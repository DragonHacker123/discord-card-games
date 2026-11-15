// The real server with real WebSocket clients, in dev mode on a spare port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/main.js';

const staticDir = await mkdtemp(join(tmpdir(), 'jacks-static-'));
await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>t</title>');

const server = await startServer({ dev: true, port: 0, env: {}, staticDir, quiet: true });
const http = `http://127.0.0.1:${server.port}`;
test.after(() => server.close());

async function login(name) {
  const response = await fetch(`${http}/api/dev-login`, { method: 'POST', body: JSON.stringify({ name }) });
  assert.equal(response.status, 200);
  return response.json();
}

/** A client that keeps every message and can wait for one. */
function client(session, room, { origin = 'http://localhost:5200', hello = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin });
  const seen = [];
  const waiters = [];
  const me = {
    ws,
    seen,
    closed: new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
    send: (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
    /** Resolves with the first message, old or new, that passes the check. */
    next(check, from = 0) {
      const old = seen.slice(from).find(check);
      if (old) return Promise.resolve(old);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out. Saw: ${seen.map((m) => m.t).join(',')}`)), 4000);
        waiters.push({ check, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    last: (type) => seen.findLast((message) => message.t === type),
  };
  ws.on('error', () => {});
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    seen.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.check(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  ws.on('open', () => {
    if (hello) me.send({ t: 'hello', session, room });
  });
  return me;
}

const roomWith = (check) => (message) => message.t === 'room' && check(message.room);

test('the made-up sign-in is refused when the request came through a proxy', async () => {
  const response = await fetch(`${http}/api/dev-login`, { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: '{}' });
  assert.equal(response.status, 404);
  const config = await (await fetch(`${http}/api/config`, { headers: { 'cf-connecting-ip': '1.2.3.4' } })).json();
  assert.equal(config.dev, false);
});

test('files outside the built client can’t be fetched', async () => {
  for (const path of ['/../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/.env', '/.env', '/.proxy/../.env']) {
    const response = await fetch(`${http}${path}`);
    assert.notEqual(response.status, 200, path);
  }
  const page = await fetch(`${http}/.proxy/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});

test('a connection needs a real session, a sane room and an allowed origin', async () => {
  const a = await login('A');
  assert.equal((await client('nope', 'r1').closed).reason, 'bad-session');
  assert.equal((await client(a.session, '../etc').closed).reason, 'bad-room');
  assert.equal((await client(a.session, 'r1', { hello: false, origin: 'https://evil.example' }).closed).code, 1006);
  const quiet = client(a.session, 'r1', { hello: false });
  await new Promise((resolve) => quiet.ws.on('open', resolve));
  quiet.send('not json');
  assert.equal((await quiet.closed).reason, 'bad-message');
  const big = client(a.session, 'r1');
  await big.next((m) => m.t === 'room');
  big.send({ t: 'act', action: { type: 'x'.repeat(5000) } });
  assert.notEqual((await big.closed).code, 1000);
});

test('two people and a computer player sit down, deal, and each sees only their own cards', async () => {
  const [a, b, c] = await Promise.all([login('Ann'), login('Bob'), login('Cat')]);
  const ann = client(a.session, 'table1');
  await ann.next(roomWith((room) => room.host === a.user.id));
  const bob = client(b.session, 'table1');
  await bob.next((m) => m.t === 'room');

  ann.send({ t: 'sit' });
  bob.send({ t: 'sit' });
  bob.send({ t: 'addBot' });
  bob.send({ t: 'start' });
  bob.send({ t: 'rules', rules: { jack: 30 } });
  assert.equal((await bob.next((m) => m.t === 'no')).error, 'Only the host can do that.');
  ann.send({ t: 'addBot' });
  ann.send({ t: 'rules', rules: { jack: 11, drawFromDiscard: true, matchSeconds: 999 } });
  const ready = await ann.next(roomWith((room) => room.seats.length === 3 && room.rules.jack === 11));
  assert.equal(ready.room.rules.matchSeconds, 15);
  assert.deepEqual(ready.room.seats.map((seat) => seat.bot), [false, false, true]);
  assert.equal(ready.room.playing, false);

  ann.send({ t: 'start' });
  const annGame = await ann.next((m) => m.t === 'game');
  const bobGame = await bob.next((m) => m.t === 'game');
  assert.equal(annGame.view.you, 0);
  assert.equal(bobGame.view.you, 1);
  for (const game of [annGame, bobGame]) {
    game.view.players.forEach((player, seat) => {
      const shown = player.slots.filter((slot) => slot?.card).length;
      assert.equal(shown, seat === game.view.you ? 2 : 0);
    });
    assert.equal(game.view.drawPile, undefined);
  }

  // Someone who arrives now watches, and sees no cards at all.
  const cat = client(c.session, 'table1');
  const catGame = await cat.next((m) => m.t === 'game');
  assert.equal(catGame.view.you, -1);
  assert.ok(!JSON.stringify(catGame.view.players).includes('rank'));
  cat.send({ t: 'act', action: { type: 'ready' } });
  assert.equal((await cat.next((m) => m.t === 'no')).error, 'You’re watching this game.');
  cat.send({ t: 'sit' });
  assert.equal((await cat.next((m) => m.t === 'no' && m.error.startsWith('Wait'))).t, 'no');

  // Rubbish is refused and the server carries on.
  const mark = bob.seen.length;
  for (const action of [null, 5, { type: '__proto__' }, { type: 'swap', slot: 'length' }, { type: 'match', owner: 'length', slot: 0 }, { type: 'peek', target: 7 }]) {
    bob.send({ t: 'act', action });
  }
  bob.send({ t: 'constructor' });
  bob.send({ t: 'act', action: { type: 'ready' } });
  await bob.next((m) => m.t === 'game' && m.view.players[1].ready, mark);
  assert.equal(bob.seen.slice(mark).filter((m) => m.t === 'no').length, 7);

  ann.send({ t: 'act', action: { type: 'ready' } });
  const started = await ann.next((m) => m.t === 'game' && m.view.phase === 'draw');
  assert.ok(started.view.turn >= 0);

  // No message to anyone ever carried a card they shouldn't have.
  for (const [who, seat] of [[ann, 0], [bob, 1], [cat, -1]]) {
    for (const message of who.seen.filter((m) => m.t === 'game')) {
      for (const event of message.events) {
        assert.equal(event.secret, undefined);
        if (event.type === 'drew' && event.seat !== seat) assert.equal(event.card, undefined);
      }
    }
  }

  // Ann closes Discord. Bob is told she's away, and the host passes on.
  ann.ws.close();
  const after = await bob.next(roomWith((room) => room.seats[0]?.away === true));
  assert.equal(after.room.playing, true);

  // The same person opening it twice: the first copy is closed.
  const bob2 = client(b.session, 'table1');
  assert.equal((await bob.closed).reason, 'replaced');
  const again = await bob2.next((m) => m.t === 'game');
  assert.equal(again.view.you, 1);
  bob2.ws.close();
  cat.ws.close();
});

test('too many messages at once closes the connection', async () => {
  const a = await login('Spammer');
  const spam = client(a.session, 'spam');
  await spam.next((m) => m.t === 'room');
  for (let i = 0; i < 60; i++) spam.send({ t: 'sit' });
  assert.equal((await spam.closed).reason, 'rate');
});

test('the host can switch the room to Go Fish and play it', async () => {
  const [a, b] = await Promise.all([login('Gil'), login('Hal')]);
  const gil = client(a.session, 'fishroom');
  const first = await gil.next((m) => m.t === 'room');
  assert.equal(first.room.game, 'jacks');
  assert.deepEqual(first.room.games.map((game) => game.id), ['jacks', 'blackjack', 'gofish']);
  const hal = client(b.session, 'fishroom');
  await hal.next((m) => m.t === 'room');

  hal.send({ t: 'game', game: 'gofish' });
  assert.equal((await hal.next((m) => m.t === 'no')).error, 'Only the host can pick the game.');
  gil.send({ t: 'game', game: '__proto__' });
  assert.equal((await gil.next((m) => m.t === 'no')).error, 'Unknown game.');
  gil.send({ t: 'game', game: 'gofish' });
  const fishRoom = await gil.next(roomWith((room) => room.game === 'gofish'));
  assert.equal(fishRoom.room.maxSeats, 6);

  gil.send({ t: 'sit' });
  hal.send({ t: 'sit' });
  await gil.next(roomWith((room) => room.seats.length === 2));
  gil.send({ t: 'start' });
  const gilGame = await gil.next((m) => m.t === 'game');
  const halGame = await hal.next((m) => m.t === 'game');
  assert.equal(gilGame.view.game, 'gofish');
  assert.equal(gilGame.view.players[0].hand.length + gilGame.view.players[0].books.length * 4, 7);
  assert.equal(gilGame.view.players[1].hand, null);
  assert.equal(halGame.view.players[0].hand, null);

  // Whoever's turn it is asks; the other is refused.
  const turn = gilGame.view.turn;
  const [asker, askerGame, waiter] = turn === 0 ? [gil, gilGame, hal] : [hal, halGame, gil];
  waiter.send({ t: 'act', action: { type: 'ask', target: turn, rank: 'A' } });
  assert.equal((await waiter.next((m) => m.t === 'no', waiter.seen.length)).error, 'It isn’t your turn.');
  const from = asker.seen.length;
  asker.send({ t: 'act', action: { type: 'ask', target: 1 - turn, rank: askerGame.view.players[turn].hand[0].rank } });
  const after = await asker.next((m) => m.t === 'game' && m.events.some((event) => event.type === 'asked'), from);
  assert.ok(after.view.last);
  // The other player never learns a fished card.
  const seenByWaiter = await waiter.next((m) => m.t === 'game' && m.events.some((event) => event.type === 'asked'));
  for (const event of seenByWaiter.events) if (event.type === 'goFish' && !event.lucky) assert.equal(event.card, null);

  gil.send({ t: 'game', game: 'jacks' });
  assert.equal((await gil.next((m) => m.t === 'no', gil.seen.length)).error, 'Wait for this game to finish.');
  gil.ws.close();
  hal.ws.close();
});

test('one person can play Blackjack against the house', async () => {
  const a = await login('Ivy');
  const ivy = client(a.session, 'bjroom');
  await ivy.next((m) => m.t === 'room');
  ivy.send({ t: 'game', game: 'blackjack' });
  ivy.send({ t: 'rules', rules: { rounds: 5, nonsense: true } });
  const room = await ivy.next(roomWith((r) => r.game === 'blackjack' && r.rules.rounds === 5));
  assert.deepEqual(room.room.rules, { rounds: 5 });
  assert.equal(room.room.minSeats, 1);
  ivy.send({ t: 'sit' });
  await ivy.next(roomWith((r) => r.seats.length === 1));
  ivy.send({ t: 'start' });
  const first = await ivy.next((m) => m.t === 'game');
  assert.equal(first.view.game, 'blackjack');
  assert.deepEqual(first.view.legal, ['bet']);
  assert.equal(first.deadline.kind, 'bet');
  ivy.send({ t: 'act', action: { type: 'bet', amount: 15 } });
  assert.equal((await ivy.next((m) => m.t === 'no')).error, 'That bet isn’t allowed.');
  ivy.send({ t: 'act', action: { type: 'bet', amount: 50 } });
  const dealt = await ivy.next((m) => m.t === 'game' && m.view.phase !== 'bet');
  assert.equal(dealt.view.players[0].chips, 950);
  assert.equal(dealt.view.players[0].hands[0].cards.length, 2);
  // The hidden card stays hidden until the house plays or the hand is over.
  if (dealt.view.phase === 'play') assert.equal(dealt.view.house.cards[1], null);
  assert.ok(!JSON.stringify(dealt).includes('shoe'));
  ivy.ws.close();
});
