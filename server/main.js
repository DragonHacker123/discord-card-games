// The card games server: serves the built client, signs people in through
// Discord, and carries game messages over one WebSocket per player.
//
//   node server/main.js          the real thing; needs .env (see .env.example)
//   node server/main.js --dev    local testing on port 5200, with a made-up sign-in
//
// The made-up sign-in only exists with --dev, and even then only for requests
// that come straight from this computer, so a tunnel can't reach it.

import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { createRooms } from './rooms.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 2048;
const MAX_FRAME = 4096;
const MAX_SOCKETS = 2000;
const MAX_SESSIONS = 20000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net",
  "font-src 'self' data:",
  "connect-src 'self' wss://*.discordsays.com https://*.discordsays.com ws://localhost:* ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/** Reads KEY=value lines from .env without printing or logging any of them. */
function readEnvFile(path) {
  const found = {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return found;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#')) found[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return found;
}

/** crypto-backed stand-in for Math.random, so nobody can predict a shuffle. */
const secureRandom = () => randomInt(0, 2 ** 32) / 2 ** 32;

const cleanName = (value, fallback) => {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, 32);
  return text || fallback;
};

function avatarUrl(user) {
  if (user.avatar && /^[a-z0-9_]+$/i.test(user.avatar)) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  try {
    return `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`;
  } catch {
    return null;
  }
}

export async function startServer({ dev = false, port, env = process.env, staticDir = join(ROOT, 'dist', 'activity'), roomOptions = {}, quiet = false } = {}) {
  const clientId = env.DISCORD_CLIENT_ID ?? '';
  const clientSecret = env.DISCORD_CLIENT_SECRET ?? '';
  const botToken = env.DISCORD_BOT_TOKEN ?? '';
  if (!dev && (!clientId || !clientSecret)) {
    throw new Error('DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are missing. Copy .env.example to .env and fill it in, or use --dev.');
  }
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  const sessions = new Map(); // token -> { user, expires }
  const rooms = createRooms({ random: secureRandom, ...roomOptions });
  const sockets = new Set();

  function newSession(user) {
    if (sessions.size >= MAX_SESSIONS) {
      const now = Date.now();
      for (const [token, session] of sessions) if (session.expires < now) sessions.delete(token);
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    }
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { user, expires: Date.now() + SESSION_MS });
    return token;
  }

  function sessionUser(token) {
    if (typeof token !== 'string') return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session.user;
  }

  /* ---------- Discord ---------- */

  async function discordSignIn(code) {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code }),
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) return null;
    const { access_token: accessToken } = await tokenResponse.json();
    if (typeof accessToken !== 'string') return null;
    const meResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!meResponse.ok) return null;
    const me = await meResponse.json();
    if (typeof me.id !== 'string' || !/^\d{5,25}$/.test(me.id)) return null;
    const user = { id: me.id, name: cleanName(me.global_name ?? me.username, 'Player'), avatar: avatarUrl(me) };
    return { accessToken, user };
  }

  /** With a bot token, checks the person really is in the activity they name. */
  async function inInstance(instanceId, userId) {
    if (dev || !botToken) return true;
    try {
      const response = await fetch(`https://discord.com/api/applications/${clientId}/activity-instances/${encodeURIComponent(instanceId)}`, {
        headers: { authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 404) return false;
      if (!response.ok) return true; // Discord having a bad moment shouldn't lock everyone out.
      const body = await response.json();
      return Array.isArray(body.users) && body.users.includes(userId);
    } catch {
      return true;
    }
  }

  /* ---------- HTTP ---------- */

  const isLocal = (request) => {
    const address = request.socket.remoteAddress ?? '';
    const direct = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    const proxied = ['x-forwarded-for', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'forwarded', 'via'].some((name) => request.headers[name]);
    return direct && !proxied;
  };

  function json(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  function readBody(request) {
    return new Promise((resolve) => {
      let size = 0;
      const parts = [];
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          resolve(null);
          request.destroy();
        } else parts.push(chunk);
      });
      request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
          resolve(body && typeof body === 'object' ? body : null);
        } catch {
          resolve(null);
        }
      });
      request.on('error', () => resolve(null));
    });
  }

  async function serveFile(response, path) {
    const wanted = path === '/' ? '/index.html' : path;
    const file = normalize(join(staticDir, decodeURIComponent(wanted)));
    if (file !== staticDir && !file.startsWith(staticDir + sep)) return json(response, 404, { error: 'not-found' });
    const type = TYPES[extname(file).toLowerCase()];
    if (!type) return json(response, 404, { error: 'not-found' });
    try {
      const data = await readFile(file);
      const headers = { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
      if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
      response.writeHead(200, headers);
      response.end(data);
    } catch {
      if (wanted === '/index.html') {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('The client has not been built yet. Run: npm run build:activity');
      } else json(response, 404, { error: 'not-found' });
    }
    return undefined;
  }

  // Discord's proxy may or may not put /.proxy in front of the path.
  const pathOf = (request) => {
    let path = '/';
    try {
      path = new URL(request.url, 'http://x').pathname;
    } catch {
      // Falls through to the front page.
    }
    return path.startsWith('/.proxy/') ? path.slice(7) : path;
  };

  const server = createServer(async (request, response) => {
    try {
      const path = pathOf(request);
      if (path === '/api/health') return json(response, 200, { ok: true, rooms: rooms.count() });
      if (path === '/api/config') return json(response, 200, { clientId, dev: dev && isLocal(request) });
      if (path === '/api/token' && request.method === 'POST') {
        const body = await readBody(request);
        if (!clientId || !clientSecret) return json(response, 503, { error: 'not-set-up' });
        if (!body || typeof body.code !== 'string' || body.code.length > 200) return json(response, 400, { error: 'bad-request' });
        const signedIn = await discordSignIn(body.code).catch(() => null);
        if (!signedIn) return json(response, 401, { error: 'sign-in-failed' });
        return json(response, 200, { access_token: signedIn.accessToken, session: newSession(signedIn.user), user: signedIn.user });
      }
      if (path === '/api/dev-login' && request.method === 'POST') {
        if (!dev || !isLocal(request)) return json(response, 404, { error: 'not-found' });
        const body = await readBody(request);
        const user = { id: `dev-${randomBytes(6).toString('hex')}`, name: cleanName(body?.name, 'Tester'), avatar: null };
        return json(response, 200, { session: newSession(user), user });
      }
      if (path.startsWith('/api/')) return json(response, 404, { error: 'not-found' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method' });
      return await serveFile(response, path);
    } catch (error) {
      console.error('Request failed:', error?.message ?? error);
      if (!response.headersSent) json(response, 500, { error: 'server' });
      else response.end();
      return undefined;
    }
  });

  /* ---------- WebSocket ---------- */

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  function originAllowed(request) {
    const origin = request.headers.origin;
    if (!origin) return dev;
    try {
      const { hostname } = new URL(origin);
      if (hostname.endsWith('.discordsays.com')) return true;
      return dev && (hostname === 'localhost' || hostname === '127.0.0.1');
    } catch {
      return false;
    }
  }

  server.on('upgrade', (request, socket, head) => {
    if (pathOf(request) !== '/ws' || !originAllowed(request) || sockets.size >= MAX_SOCKETS) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => connect(ws));
  });

  function connect(ws) {
    sockets.add(ws);
    let link = null; // set once hello has been accepted
    let greeting = false;
    let tokens = 20;
    let refilled = Date.now();
    ws.isAlive = true;
    const send = (message) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const fail = (code) => {
      send({ t: 'error', code });
      ws.close(1008, code);
    };
    const helloTimer = setTimeout(() => {
      if (!link) fail('bad-hello');
    }, 8000);

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(helloTimer);
      sockets.delete(ws);
      link?.leave();
    });
    ws.on('message', async (data, isBinary) => {
      // 20 messages at once, then 10 a second.
      const now = Date.now();
      tokens = Math.min(20, tokens + ((now - refilled) / 1000) * 10);
      refilled = now;
      tokens -= 1;
      if (tokens < 0) return fail('rate');
      if (isBinary) return fail('bad-message');
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        return fail('bad-message');
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail('bad-message');
      if (link) return link.handle(message);
      if (greeting || message.t !== 'hello') return fail('bad-hello');
      greeting = true;
      const user = sessionUser(message.session);
      if (!user) return fail('bad-session');
      if (typeof message.room !== 'string') return fail('bad-hello');
      if (!(await inInstance(message.room, user.id))) return fail('not-in-activity');
      if (ws.readyState !== ws.OPEN) return undefined;
      send({ t: 'welcome', you: user });
      const joined = rooms.join(message.room, user, send, () => fail('replaced'));
      if (joined.error) return fail(joined.error);
      clearTimeout(helloTimer);
      link = joined;
      return undefined;
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of sockets) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25000);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, dev ? '127.0.0.1' : undefined, resolve);
  });
  const address = server.address();
  log(`Card games server on http://localhost:${address.port}${dev ? ' (dev sign-in on, this computer only)' : ''}`);
  if (!dev && !botToken) log('No DISCORD_BOT_TOKEN: skipping the check that players are in the activity they name.');

  return {
    port: address.port,
    rooms,
    async close() {
      clearInterval(heartbeat);
      rooms.stop();
      for (const ws of sockets) ws.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dev = process.argv.includes('--dev');
  const env = { ...readEnvFile(join(ROOT, '.env')), ...process.env };
  const portArg = process.argv.find((arg) => arg.startsWith('--port='))?.slice(7);
  const port = Number(portArg ?? (dev ? 5200 : env.PORT ?? 3000));
  startServer({ dev, port, env }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
