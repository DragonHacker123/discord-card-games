// The Discord version of the card table. It signs in, joins the room for this
// activity, and passes messages between the server and the table in ui.js.
// The server decides everything; this file only shows what it's told.

import { DiscordSDK } from '@discord/embedded-app-sdk';
import { startOnline } from '../games/jacks/ui.js';
import { createFishTable } from '../games/gofish/table.js';
import { createBlackjackTable } from '../games/blackjack/table.js';

const inDiscord = new URLSearchParams(location.search).has('frame_id');
// Inside Discord, everything goes through its proxy.
const base = location.hostname.endsWith('.discordsays.com') ? '/.proxy' : '';
const app = document.querySelector('.app');

const state = {
  me: null,
  session: null,
  roomId: null,
  room: null,
  socket: null,
  retries: 0,
  stopped: false,
  inGame: false,
  playing: null, // which game's table is showing: 'jacks' or 'gofish'
  endArmed: false,
};

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(label, onClick, className = 'btn') {
  const el = make('button', className, label);
  el.type = 'button';
  el.addEventListener('click', onClick);
  return el;
}

/* ---------- Screens ---------- */

const notice = make('section', 'notice');
const roomScreen = make('section', 'lobby');
roomScreen.hidden = true;
app.prepend(notice, roomScreen);

function showNotice(text, action) {
  notice.textContent = '';
  notice.append(make('h1', '', 'Card Games'), make('p', '', text));
  if (action) notice.append(action);
  notice.hidden = false;
  roomScreen.hidden = true;
  document.getElementById('game').hidden = true;
  for (const id of ['gofish', 'blackjack']) {
    const other = document.getElementById(id);
    if (other) other.hidden = true;
  }
}

const send = (message) => {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
};

const isHost = () => Boolean(state.room && state.me && state.room.host === state.me.id);

const table = startOnline({
  act: (action) => send({ t: 'act', action }),
  away: (seat) => Boolean(state.room?.seats[seat]?.away),
  canDeal: () => isHost(),
  resultButtons() {
    const see = '<button type="button" class="btn" data-result="table">See the table</button>';
    if (!isHost()) return see;
    return `<button type="button" class="btn btn-primary" data-result="deal">Deal again</button>${see}<button type="button" class="btn" data-result="lobby">Return to menu</button>`;
  },
  result(choice) {
    if (choice === 'deal') send({ t: 'start' });
    if (choice === 'lobby') send({ t: 'lobby' });
  },
  settingsChanged(rules) {
    if (isHost() && !state.room.playing) send({ t: 'rules', rules });
  },
});

const fish = createFishTable({
  act: (action) => send({ t: 'act', action }),
  away: (seat) => Boolean(state.room?.seats[seat]?.away),
  isHost,
  deal: () => send({ t: 'start' }),
  lobby: () => send({ t: 'lobby' }),
  cardSvg: table.cardSvg,
  escapeHtml,
});
const blackjack = createBlackjackTable({
  act: (action) => send({ t: 'act', action }),
  away: (seat) => Boolean(state.room?.seats[seat]?.away),
  isHost,
  deal: () => send({ t: 'start' }),
  lobby: () => send({ t: 'lobby' }),
  cardSvg: table.cardSvg,
  escapeHtml,
});
const tables = { jacks: table, gofish: fish, blackjack };
const showing = () => tables[state.playing] ?? table;

// The host can stop a game from the side of the table. It takes two presses.
const endButton = button('End game', () => {
  if (!state.endArmed) {
    state.endArmed = true;
    endButton.textContent = 'Press again to end';
    setTimeout(() => {
      state.endArmed = false;
      endButton.textContent = 'End game';
    }, 3000);
    return;
  }
  send({ t: 'lobby' });
});
document.querySelector('.side-actions').append(endButton);

function face(person) {
  const el = make('span', 'room-face');
  if (person.avatar) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = person.avatar;
    img.addEventListener('error', () => {
      el.textContent = person.name.slice(0, 1).toUpperCase();
    });
    el.append(img);
  } else {
    el.textContent = person.bot ? '♠' : person.name.slice(0, 1).toUpperCase();
  }
  return el;
}

let hintTimer = 0;
let hintText = '';

function showRoomHint(text) {
  hintText = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hintText = '';
    if (!state.inGame && state.room) renderRoom();
  }, 3500);
  renderRoom();
}

function renderRoom() {
  const { room, me } = state;
  const host = isHost();
  const seated = room.seats.some((seat) => seat.id === me.id);
  const gameName = room.games.find((entry) => entry.id === room.game)?.name ?? 'Jacks';
  const hostName = [...room.seats, ...room.watching].find((person) => person.id === room.host)?.name ?? 'the host';

  const main = make('div', 'lobby-main');
  const hero = make('div', 'hero');
  hero.append(make('h1', 'wordmark', gameName));
  const hand = make('div', 'hero-hand');
  hand.setAttribute('aria-hidden', 'true');
  hand.innerHTML = [null, null, { rank: 'K', suit: 'H' }, { rank: '7', suit: 'C' }]
    .map((card) => (card ? `<div class="hero-card">${table.cardSvg(card)}</div>` : '<div class="hero-card back-face"></div>'))
    .join('');
  hero.append(hand);

  const setup = make('div', 'setup');
  if (host) {
    const picker = make('div', 'game-picker');
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', 'Game');
    for (const entry of room.games) {
      const choice = button(entry.name, () => send({ t: 'game', game: entry.id }));
      choice.setAttribute('aria-pressed', String(entry.id === room.game));
      picker.append(choice);
    }
    setup.append(picker);
  }
  setup.append(make('p', 'room-heading', `At the table (${room.seats.length} of ${room.maxSeats})`));
  const list = make('ul', 'room-seats');
  room.seats.forEach((seat, index) => {
    const item = make('li', `room-seat${seat.away ? ' is-away' : ''}`);
    const who = make('span', 'room-who');
    who.append(make('span', 'room-name', seat.id === me.id ? `${seat.name} (you)` : seat.name));
    const tag = seat.bot ? 'Computer' : seat.id === room.host ? 'Host' : seat.away ? 'Away' : '';
    if (tag) who.append(make('span', 'room-tag', tag));
    item.append(face(seat), who);
    if (seat.bot && host) {
      const remove = button('Remove', () => send({ t: 'removeBot', seat: index }), 'btn btn-small');
      remove.setAttribute('aria-label', `Remove ${seat.name}`);
      item.append(remove);
    }
    list.append(item);
  });
  if (room.seats.length === 0) list.append(make('li', 'room-seat is-empty', 'Nobody yet'));
  setup.append(list);

  const actions = make('div', 'setup-actions');
  const full = room.seats.length >= room.maxSeats;
  if (host) {
    const deal = button('Deal the cards', () => send({ t: 'start' }), 'btn btn-primary btn-large');
    deal.disabled = room.seats.length < room.minSeats || !room.seats.some((seat) => !seat.bot);
    actions.append(deal);
  }
  if (seated) actions.append(button('Stand up', () => send({ t: 'stand' }), 'btn btn-large'));
  else {
    const sit = button('Sit down', () => send({ t: 'sit' }), `btn btn-large${host ? '' : ' btn-primary'}`);
    sit.disabled = full;
    actions.append(sit);
  }
  if (host) {
    const add = button('Add a computer player', () => send({ t: 'addBot' }), 'btn btn-large');
    add.disabled = full;
    actions.append(add);
    if (room.game === 'jacks') actions.append(button('Settings', () => table.openSettings(), 'btn btn-large'));
  }
  actions.append(button('Rules', () => tables[room.game].openRules(), 'btn btn-large'));
  setup.append(actions);

  if (room.game === 'jacks') setup.append(make('p', 'settings-summary', table.summary(room.rules)));
  if (room.game === 'blackjack') {
    if (host) {
      const rounds = make('div', 'rounds-picker');
      rounds.setAttribute('role', 'group');
      rounds.setAttribute('aria-label', 'Hands in a game');
      rounds.append(make('span', '', 'Hands'));
      for (const count of [5, 10, 20]) {
        const choice = button(String(count), () => send({ t: 'rules', rules: { rounds: count } }), 'btn btn-small');
        choice.setAttribute('aria-pressed', String(room.rules.rounds === count));
        rounds.append(choice);
      }
      setup.append(rounds);
    }
    setup.append(make('p', 'settings-summary', `${room.rules.rounds} hands. Everyone starts with 1,000 chips. Most chips wins.`));
  }
  const hint = make('p', 'room-hint', hintText);
  hint.setAttribute('role', 'alert');
  setup.append(hint);

  main.append(hero, setup);
  if (!host) main.append(make('p', 'note', `${hostName} is the host and deals the cards.`));
  if (room.watching.length) main.append(make('p', 'note', `Watching: ${room.watching.map((person) => person.name).join(', ')}`));

  roomScreen.textContent = '';
  roomScreen.append(main);
  roomScreen.hidden = false;
  notice.hidden = true;
}

function onRoom(room) {
  const wasPlaying = state.room?.playing;
  state.room = room;
  if (room.game === 'jacks') table.setSettings(room.rules);
  endButton.hidden = !isHost();
  if (room.playing) {
    roomScreen.hidden = true;
    if (state.inGame) showing().redraw();
    return;
  }
  if (wasPlaying || state.inGame) {
    table.close();
    fish.close();
    blackjack.close();
    state.inGame = false;
    state.playing = null;
  }
  renderRoom();
}

function onGame(message) {
  state.inGame = true;
  roomScreen.hidden = true;
  notice.hidden = true;
  const playing = Object.hasOwn(tables, message.view?.game ?? '') ? message.view.game : 'jacks';
  if (state.playing && state.playing !== playing) showing().close();
  state.playing = playing;
  showing().update(message);
}

/* ---------- The connection ---------- */

const FINAL = {
  replaced: 'You opened the game somewhere else, so this one has stopped.',
  full: 'This room is full.',
  'not-in-activity': 'Discord says you aren’t in this activity. Close it and open it again.',
  rate: 'Too many messages at once. Reload to carry on.',
  'bad-room': 'This room’s name isn’t valid.',
};

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}${base}/ws`);
  state.socket = socket;
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ t: 'hello', session: state.session, room: state.roomId }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.t === 'welcome') {
      state.me = message.you;
      state.retries = 0;
    } else if (message.t === 'room') onRoom(message.room);
    else if (message.t === 'game') onGame(message);
    else if (message.t === 'no') {
      if (state.inGame) showing().refuse(message.error);
      else if (state.room) showRoomHint(message.error);
    } else if (message.t === 'error') {
      if (message.code === 'bad-session') {
        // The server restarted or the sign-in ran out. Signing in again fixes both.
        state.stopped = true;
        sessionStorage.removeItem('jacks-dev-session');
        signIn().then(() => {
          state.stopped = false;
          connect();
        }, failed);
      } else if (FINAL[message.code]) {
        state.stopped = true;
        showNotice(FINAL[message.code]);
      }
    }
  });
  socket.addEventListener('close', () => {
    if (state.stopped || state.socket !== socket) return;
    state.retries += 1;
    if (state.retries > 1) showNotice('Reconnecting…');
    setTimeout(connect, Math.min(8000, 400 * 2 ** Math.min(state.retries, 5)));
  });
}

/* ---------- Signing in ---------- */

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}

async function signIn() {
  const config = await (await fetch(`${base}/api/config`)).json();
  if (inDiscord) {
    const sdk = new DiscordSDK(config.clientId);
    await sdk.ready();
    const { code } = await sdk.commands.authorize({
      client_id: config.clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });
    const signedIn = await post('/api/token', { code });
    await sdk.commands.authenticate({ access_token: signedIn.access_token });
    state.session = signedIn.session;
    state.roomId = sdk.instanceId;
    return;
  }
  if (!config.dev) throw new Error('outside-discord');
  // Local testing: each browser tab is a different made-up person.
  const params = new URLSearchParams(location.search);
  state.roomId = params.get('room') || 'dev';
  const saved = sessionStorage.getItem('jacks-dev-session');
  if (saved) {
    state.session = saved;
    return;
  }
  const name = params.get('name') || `Tester ${Math.floor(Math.random() * 90) + 10}`;
  const signedIn = await post('/api/dev-login', { name });
  state.session = signedIn.session;
  sessionStorage.setItem('jacks-dev-session', signedIn.session);
}

function failed(error) {
  console.error('Card Games: sign-in failed', error);
  if (error?.message === 'outside-discord') showNotice('Open this from the Activities button in a Discord voice channel.');
  else showNotice('Couldn’t sign you in.', button('Try again', () => location.reload(), 'btn btn-primary'));
}

showNotice('Joining the table…');
signIn().then(connect, failed);
