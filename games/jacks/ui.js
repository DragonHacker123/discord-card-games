// The card table for Jacks. All rules live in engine.js. This file draws what
// viewFor() says and sends actions back.
//
// It runs two ways. On the test page it holds the whole game and plays the
// computer players itself. In the Discord version (startOnline) it holds only
// the view the server sends, so game.state is that view and no hidden card ever
// reaches this file.

import {
  applyAction,
  closeLastCall,
  closeMatchWindow,
  createGame,
  DEFAULT_RULES,
  ENGINE_VERSION,
  eventFor,
  lastCallSeconds,
  normaliseRules,
  scoreCard,
  stackNextCard,
  viewFor,
} from './engine.js';
import { botAct, botMatchOther, botMatchSlot, botNoticesMatch, botObserve, createBot } from './bots.js';
import { createTutorialGame, stepAllows, stepSlots, TUTOR_ADA, TUTORIAL_STEPS } from './tutorial.js';

let ME = 0; // your seat, or -1 if you're watching an online game
let online = null; // the Discord version's hooks, null on the test page
const BOT_NAMES = ['Ada', 'Bea', 'Cal', 'Dot', 'Eli', 'Fay', 'Gus'];
const SETTINGS_KEY = 'jacks-settings-v1';
const BOT_PACE = {
  draw: [800, 1300],
  decide: [900, 1700],
  power: [900, 1400],
  endTurn: [400, 800],
  give: [900, 1600],
};
// How long a computer player takes to try a match with someone else's card, in real seconds.
const BOT_OTHER_MATCH_MS = [3000, 5000];
const REVEAL_MS = 1900;
const RESULTS_DELAY_MS = 1700;
const TUTOR_MOVE_MS = 1100;
const calmMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const $ = (id) => document.getElementById(id);

let settings = loadSettings();
let opponentCount = 3;
let game = null; // { state, bots, record }. The record is only for the bug report test tool.
let tutor = null; // { index } while the tutorial is running
let seatEls = [];

const ui = {
  matchPick: null, // { seat, slot, discardCount }: the card you've picked to try a match with
  pick: { own: null, other: null },
  reveals: new Map(),
  xray: false,
  paused: false,
  speed: 1,
  force: '',
  botKey: '',
  botTimer: 0,
  giveScheduled: false,
  peekScheduled: new Set(),
  deadline: null,
  deadlineLabel: '',
  promptSig: '',
};

// The test tools stay set while the tutorial runs, but they don't touch it.
const xrayOn = () => ui.xray && !tutor && !online;

/** What you're allowed to see. Online, the server has already worked that out. */
const myView = () => (online ? game.state : viewFor(game.state, ME));

/* ---------- Saved settings ---------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return normaliseRules(JSON.parse(raw));
  } catch {
    // Storage can be unavailable in a private window. The defaults are fine.
  }
  return normaliseRules(DEFAULT_RULES);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings still apply for this visit.
  }
}

/* ---------- Words ---------- */

const SUIT_GLYPH = { S: '♠︎', H: '♥︎', D: '♦︎', C: '♣︎' };
const SUIT_WORD = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const RANK_WORD = { A: 'ace', J: 'jack', Q: 'queen', K: 'king', JOKER: 'joker' };
const SLOT_WORD = ['top left', 'top right', 'bottom left', 'bottom right'];

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const rankWord = (rank) => RANK_WORD[rank] ?? rank;
const isRedCard = (card) => card.suit === 'H' || card.suit === 'D' || card.suit === 'R';
const cardName = (card) => (card.rank === 'JOKER' ? 'Joker' : `${card.rank}${SUIT_GLYPH[card.suit]}`);
const cardWords = (card) => (card.rank === 'JOKER' ? 'joker' : `${rankWord(card.rank)} of ${SUIT_WORD[card.suit]}`);
const slotWord = (slot) => SLOT_WORD[slot] ?? `extra card ${slot - 3}`;
const scoreText = (value) => (value < 0 ? `−${-value}` : String(value));
const seatName = (seat) => game.state.players[seat].name;
const jitter = (low, high) => low + Math.random() * (high - low);

function matchingSentence(rules) {
  if (rules.matchMode === 'countdown') {
    return `After each discard you have ${rules.matchSeconds} seconds to try a match, and the next player waits.`;
  }
  return 'You can try a match at any moment until the next card lands on the discard pile.';
}

function faceScoresSentence(rules) {
  return `Jack ${scoreText(rules.jack)}, queen ${scoreText(rules.queen)}, black king ${scoreText(rules.blackKing)}, red king ${scoreText(rules.redKing)}`;
}

function takeDiscardLines(rules) {
  if (!rules.drawFromDiscard) return '<li>Take a card from the draw pile and look at it.</li>';
  return `<li>Take a card from the draw pile and look at it, or take the top card of the discard pile. Everyone sees that card and which of your places it goes into.</li>
      <li>A card you pick up from the discard pile must be swapped in. It can’t go straight back, and it has no power.</li>
      <li>With no cards of your own you can still pick one up, and you choose which of your empty places it goes into.</li>
      <li>Picking up doesn’t reopen matching. Nobody can match until the next card is discarded.</li>`;
}

function rulesHtml(rules) {
  return `
    <h3>Scoring</h3>
    <ul>
      <li>Joker −5, ace 1, number cards their number</li>
      <li>${faceScoresSentence(rules)}</li>
      <li>Lowest total wins</li>
    </ul>
    <h3>Starting</h3>
    <ul>
      <li>One deck with two jokers, for 2 to 8 players.</li>
      <li>Four cards face down in a 2×2 grid. You see your two nearest once, then have to remember them.</li>
      <li>The discard pile starts empty.</li>
    </ul>
    <h3>Your turn</h3>
    <ul>
      ${takeDiscardLines(rules)}
      <li>Swap it with any of your cards without seeing that card first. The old card goes face up on the discard pile.</li>
      <li>Or put the card you drew straight on the discard pile.</li>
      <li>With no cards you still draw and discard, and a jack or queen does nothing.</li>
      <li>When the draw pile runs out, the discards are shuffled back in, except the top card.</li>
    </ul>
    <h3>Powers</h3>
    <p>Only when you put the card you just drew straight on the pile:</p>
    <ul>
      <li>7 or 8: look at one of your cards</li>
      <li>9 or 10: look at someone else’s card</li>
      <li>Jack: swap one of yours with an opponent’s, neither seen</li>
      <li>Queen: look at one of yours and one of an opponent’s, then choose whether to swap them</li>
      <li>Powers are optional. A swapped-out or matched card has no power.</li>
      <li>Everyone can see which cards are being looked at or swapped, but not what they are.</li>
    </ul>
    <h3>Matching</h3>
    <ul>
      <li>Pick any player’s card, then press the discard pile, to try a match.</li>
      <li>${matchingSentence(rules)}</li>
      <li>Matching goes by rank only, so any king matches any king.</li>
      <li>Right with your own card: it stays on the pile and isn’t replaced, so you can go down to no cards.</li>
      <li>Right with someone else’s card: it stays on the pile, and you can give them one of your cards to fill the gap.</li>
      <li>You choose which card to give. Nobody gets to look at it, and play waits while you choose.</li>
      <li>If you don’t give one, or have none to give, they get a card from the draw pile instead. Nobody looks at it, not even them.</li>
      <li>Wrong: everyone sees it, it goes back, and whoever tried takes a penalty card.</li>
      <li>You don’t get to look at a penalty card. It goes after your other cards.</li>
      <li>Gaps in your first four places stay empty. Extra cards close up so there are no gaps.</li>
      <li>Computer players can match anyone’s card, but only cards they should know about, and only after 3 to 5 seconds.</li>
      <li>Computer players forget cards or remember them wrongly, so they can take a penalty too.</li>
      <li>A computer player gives away the card it thinks is worth the most, unless it thinks a card from the draw pile would be worse.</li>
    </ul>
    <h3>Calling Jacks</h3>
    <ul>
      <li>Call at the end of your turn. Everyone else gets one more go.</li>
      <li>The caller’s cards can still be swapped with, and the caller can still match.</li>
      <li>Reaching no cards doesn’t end the game by itself.</li>
      <li>After the last go, there’s a short final chance to match the last discard. If the last go was a pick-up with no discard, there’s nothing to match.</li>
      <li>Then every card turns over and the totals are counted.</li>
      <li>If whoever called ties for the lowest total, they lose. There’s no other penalty for calling and losing.</li>
      <li>A tie between players who didn’t call is a shared win.</li>
    </ul>`;
}

/* ---------- Card drawings ---------- */

const PIPS = {
  A: [[50, 70]],
  2: [[50, 30], [50, 110]],
  3: [[50, 30], [50, 70], [50, 110]],
  4: [[30, 30], [70, 30], [30, 110], [70, 110]],
  5: [[30, 30], [70, 30], [50, 70], [30, 110], [70, 110]],
  6: [[30, 30], [70, 30], [30, 70], [70, 70], [30, 110], [70, 110]],
  7: [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70], [30, 110], [70, 110]],
  8: [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70], [50, 90], [30, 110], [70, 110]],
  9: [[30, 28], [70, 28], [30, 56], [70, 56], [50, 70], [30, 84], [70, 84], [30, 112], [70, 112]],
  10: [[30, 28], [70, 28], [50, 42], [30, 56], [70, 56], [30, 84], [70, 84], [50, 98], [30, 112], [70, 112]],
};
const CROWNS = {
  K: 'M35 53 L37 38 L44 46 L50 33 L56 46 L63 38 L65 53 Z',
  Q: 'M37 53 L35 41 L43 47 L50 38 L57 47 L65 41 L63 53 Z',
  J: 'M37 53 C37 43 44 38 52 38 C58 38 63 41 66 46 L58 46 C58 50 56 53 53 53 Z',
};

function suitMark(suit, x, y, size, upsideDown = false) {
  const turn = upsideDown ? ` transform="rotate(180 ${x + size / 2} ${y + size / 2})"` : '';
  return `<use href="#suit-${suit}" x="${x}" y="${y}" width="${size}" height="${size}"${turn}/>`;
}

function cardCorner(card) {
  const size = card.rank === '10' ? 16 : 19;
  return `<text x="12" y="21" text-anchor="middle" font-size="${size}">${card.rank}</text>${suitMark(card.suit, 5.5, 24, 13)}`;
}

function jokerSvg(card, mini) {
  const tone = isRedCard(card) ? ' is-red' : '';
  const paper = '<rect class="paper" width="100" height="140"/>';
  if (mini) {
    return `<svg class="cardface${tone}" viewBox="0 0 100 140" aria-hidden="true">${paper}<use href="#joker-star" x="20" y="22" width="60" height="60"/><text x="50" y="112" text-anchor="middle" font-size="23">JOKER</text></svg>`;
  }
  const corner = '<use href="#joker-star" x="5" y="6" width="15" height="15"/>';
  return `<svg class="cardface${tone}" viewBox="0 0 100 140" aria-hidden="true">${paper}${corner}<g transform="rotate(180 50 70)">${corner}</g><use href="#joker-star" x="22" y="39" width="56" height="56"/><text x="50" y="31" text-anchor="middle" font-size="15" letter-spacing="1">JOKER</text><text x="50" y="117" text-anchor="middle" font-size="15" letter-spacing="1">JOKER</text></svg>`;
}

function cardSvg(card, mini = false) {
  if (card.rank === 'JOKER') return jokerSvg(card, mini);
  const tone = isRedCard(card) ? ' is-red' : '';
  const paper = '<rect class="paper" width="100" height="140"/>';
  if (mini) {
    const size = card.rank === '10' ? 50 : 60;
    return `<svg class="cardface${tone}" viewBox="0 0 100 140" aria-hidden="true">${paper}<text x="50" y="66" text-anchor="middle" font-size="${size}">${card.rank}</text>${suitMark(card.suit, 28, 76, 44)}</svg>`;
  }
  let middle;
  const crown = CROWNS[card.rank];
  if (crown) {
    middle =
      '<rect x="24" y="23" width="52" height="94" rx="3" fill="none" stroke="currentColor" stroke-width="1"/>' +
      '<rect x="26" y="25" width="48" height="90" rx="2" fill="currentColor" opacity="0.08"/>' +
      `<path d="${crown}"/><text x="50" y="97" text-anchor="middle" font-size="46">${card.rank}</text>` +
      suitMark(card.suit, 27, 27, 11) +
      suitMark(card.suit, 62, 102, 11, true);
  } else if (card.rank === 'A') {
    middle = suitMark(card.suit, 29, 49, 42);
  } else {
    middle = PIPS[card.rank].map(([x, y]) => suitMark(card.suit, x - 9, y - 9, 18, y > 70)).join('');
  }
  return `<svg class="cardface${tone}" viewBox="0 0 100 140" aria-hidden="true">${paper}${cardCorner(card)}<g transform="rotate(180 50 70)">${cardCorner(card)}</g>${middle}</svg>`;
}

const cardKey = (card) => `${card.rank}${card.suit}`;

function setCardHtml(el, card, mini) {
  const key = card ? `${cardKey(card)}${mini ? 'm' : ''}` : '';
  if (el.dataset.face === key) return;
  el.dataset.face = key;
  el.innerHTML = card ? cardSvg(card, mini) : '';
}

/* ---------- Timers ---------- */

const timers = new Set();

function later(fn, ms) {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
  return id;
}

function clearTimers() {
  for (const id of timers) clearTimeout(id);
  timers.clear();
}

/** Runs a computer player's move, held back while the pause tool is on. */
function botLater(fn, ms) {
  later(() => {
    if (!game) return;
    if (ui.paused) botLater(fn, 300 * ui.speed);
    else fn();
  }, ms / ui.speed);
}

/* ---------- Starting and leaving a game ---------- */

function resetTableState() {
  clearTimers();
  tutor = null;
  $('game').classList.remove('is-tutorial');
  $('coach').hidden = true;
  ui.matchPick = null;
  ui.pick = { own: null, other: null };
  ui.reveals.clear();
  ui.botKey = '';
  ui.giveScheduled = false;
  ui.peekScheduled = new Set();
  ui.deadline = null;
  ui.promptSig = '';
  $('results').hidden = true;
  $('stamp').hidden = true;
  $('hint').hidden = true;
  $('recordFallback').hidden = true;
}

function dealNewGame() {
  resetTableState();
  const seed = Math.floor(Math.random() * 2 ** 31);
  const players = [
    { id: 'you', name: 'You' },
    ...BOT_NAMES.slice(0, opponentCount).map((name) => ({ id: name.toLowerCase(), name })),
  ];
  const state = createGame({ players, seed, rules: settings });
  const bots = state.players.map((_player, seat) => (seat === ME ? null : createBot(seat, seed + seat * 7919)));
  game = { state, bots, record: [] };
  showGame();
  buildTable();
  render();
  scheduleBots();
}

function startTutorial() {
  resetTableState();
  const state = createTutorialGame();
  game = { state, bots: state.players.map(() => null), record: [] };
  tutor = { index: 0 };
  $('game').classList.add('is-tutorial');
  $('coach').hidden = false;
  showGame();
  buildTable();
  render();
  renderCoach();
}

function showLobby() {
  resetTableState();
  game = null;
  $('game').hidden = true;
  $('lobby').hidden = false;
  renderLobby();
}

function showGame() {
  $('lobby').hidden = true;
  $('game').hidden = false;
  $('gameRules').innerHTML = rulesHtml(game.state.rules);
}

function resumeGame(saved) {
  resetTableState();
  game = saved;
  showGame();
  buildTable();
  const { state } = game;
  if (state.matchOpen) startMatchCountdown(state.rules.matchSeconds);
  if (state.phase === 'lastCall') startLastCall();
  if (state.phase === 'finished') showResults();
  render();
  scheduleBots();
}

/* ---------- Building the table ---------- */

function slotPlace(slot) {
  if (slot < 4) return { column: (slot % 2) + 1, row: slot < 2 ? 1 : 2 };
  const extra = slot - 4;
  return { column: 3 + Math.floor(extra / 2), row: (extra % 2) + 1 };
}

function makeSlot(seat, slot) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card';
  el.dataset.seat = String(seat);
  el.dataset.slot = String(slot);
  const place = slotPlace(slot);
  el.style.gridColumn = String(place.column);
  el.style.gridRow = String(place.row);
  el.innerHTML =
    '<span class="flip"><span class="face back back-face"></span><span class="face front"></span></span>' +
    '<span class="eye" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></span>' +
    '<span class="xray" hidden></span>';
  return el;
}

function buildSeat(seat) {
  const root = document.createElement('section');
  root.className = seat === ME ? 'seat seat-me' : 'seat';
  root.innerHTML =
    '<header class="seat-head"><span class="seat-name"></span><span class="seat-chip"></span></header>' +
    '<div class="seat-body"><div class="grid"></div>' +
    `<div class="held">${seat === ME ? '<span class="held-label">You drew</span>' : ''}<div class="held-card"></div></div></div>`;
  return {
    root,
    name: root.querySelector('.seat-name'),
    chip: root.querySelector('.seat-chip'),
    grid: root.querySelector('.grid'),
    held: root.querySelector('.held'),
    heldCard: root.querySelector('.held-card'),
    slots: [],
  };
}

function buildTable() {
  seatEls = game.state.players.map((_player, seat) => buildSeat(seat));
  const opponents = $('opponents');
  opponents.textContent = '';
  seatEls.forEach((parts, seat) => {
    parts.name.textContent = seatName(seat);
    if (seat !== ME) opponents.append(parts.root);
  });
  const mine = $('meSeat');
  mine.textContent = '';
  if (seatEls[ME]) mine.append(seatEls[ME].root);
  $('discardTop').dataset.face = 'none';
  $('discardBelow').dataset.face = 'none';
}

/* ---------- Drawing the current state ---------- */

/** What a click on this card does: 'pick' for a swap or power, 'select' to try a match with it. */
function pickKind(seat, view) {
  if (view.legal.includes('giveCard')) return seat === ME ? 'pick' : null;
  if (seat === ME && view.legal.includes('swap')) return 'pick';
  const power = view.power;
  if (power && power.seat === ME && power.stage === 'choose') {
    if (power.kind === 'blindSwap' || power.kind === 'queen') return 'pick';
    if ((power.kind === 'peekOwn') === (seat === ME)) return 'pick';
  }
  return view.legal.includes('match') ? 'select' : null;
}

function updateSlot(el, seat, slot, view) {
  const entry = view.players[seat].slots[slot];
  const xrayEl = el.querySelector('.xray');
  if (!entry) {
    // With no cards, a card you picked up goes into an empty place.
    const canPlace = seat === ME && !tutor && view.legal.includes('place');
    el.className = canPlace ? 'card gap can-pick' : 'card gap';
    el.setAttribute('aria-label', `${seat === ME ? 'Your' : `${seatName(seat)}’s`} ${slotWord(slot)} place, empty`);
    el.setAttribute('aria-disabled', canPlace ? 'false' : 'true');
    xrayEl.hidden = true;
    return;
  }
  const key = `${seat}:${slot}`;
  const reveal = ui.reveals.get(key);
  const seen = view.power?.seen.find((item) => item.seat === seat && item.slot === slot);
  const face = entry.card ?? reveal?.card ?? seen?.card ?? null;
  const front = el.querySelector('.front');
  if (face) setCardHtml(front, face, seat !== ME);

  const allowed = !tutor || tutorWantsSlot(seat, slot);
  const kind = allowed ? pickKind(seat, view) : null;
  const picked =
    (seat === ME && ui.pick.own === slot) || (ui.pick.other && ui.pick.other.seat === seat && ui.pick.other.slot === slot);
  const looking = view.power?.targets.some((item) => item.seat === seat && item.slot === slot);
  const matchPicked = ui.matchPick?.seat === seat && ui.matchPick.slot === slot;
  el.className = 'card';
  el.classList.toggle('up', Boolean(face));
  el.classList.toggle('bad', Boolean(reveal?.bad));
  el.classList.toggle('can-pick', kind === 'pick');
  el.classList.toggle('can-select', kind === 'select');
  el.classList.toggle('picked', Boolean(picked));
  el.classList.toggle('match-picked', matchPicked);
  el.classList.toggle('looking', Boolean(looking));
  el.classList.toggle('tutor-target', Boolean(tutor) && !picked && !matchPicked && (Boolean(kind) || tutorPointsAtSlot(seat, slot)));
  el.setAttribute('aria-disabled', kind ? 'false' : 'true');
  el.setAttribute(
    'aria-label',
    `${seat === ME ? 'Your' : `${seatName(seat)}’s`} ${slotWord(slot)} card, ${face ? cardWords(face) : 'face down'}${matchPicked ? ', picked to match' : ''}`,
  );

  const hidden = xrayOn() && !face ? game.state.players[seat].slots[slot] : null;
  xrayEl.hidden = !hidden;
  if (hidden) {
    xrayEl.textContent = cardName(hidden);
    xrayEl.classList.toggle('is-red', isRedCard(hidden));
  }
}

function chipFor(seat, view) {
  if (view.players[seat].out) return { text: 'Left' };
  if (view.phase === 'finished') {
    const row = view.results.standings.find((item) => item.seat === seat);
    return { text: `${scoreText(row.total)} pts`, total: true };
  }
  if (view.caller === seat) return { text: 'Called Jacks', called: true };
  if (view.phase === 'peek') return { text: view.players[seat].ready ? 'Ready' : 'Memorising' };
  if (online?.away(seat)) return { text: 'Away' };
  return { text: '' };
}

/**
 * The first four places keep their spots, gaps and all, because that's how
 * players remember cards. Extra cards (penalties) fill the columns to the right
 * in order, two to a column, with no gaps, and an empty extra place isn't shown.
 */
function layoutSlots(parts, player) {
  let extra = 0;
  parts.slots.forEach((el, slot) => {
    const shown = slot < 4 || Boolean(player.slots[slot]);
    el.style.display = shown ? '' : 'none';
    if (!shown) return;
    const place = slot < 4 ? slotPlace(slot) : { column: 3 + Math.floor(extra / 2), row: (extra % 2) + 1 };
    if (slot >= 4) extra += 1;
    el.style.gridColumn = String(place.column);
    el.style.gridRow = String(place.row);
  });
}

/** Slides any card that closed up into a gap, so it doesn't just jump. */
function settleMoved(rects) {
  seatEls.forEach((parts, seat) => {
    parts.slots.forEach((el, slot) => {
      if (slot < 4 || el.style.display === 'none' || el.getAnimations?.().length) return;
      flyFrom(el, rects.slots[`${seat}:${slot}`], 380);
    });
  });
}

function renderSeat(seat, view) {
  const parts = seatEls[seat];
  const player = view.players[seat];
  const playing = ['draw', 'decide', 'power', 'endTurn'].includes(view.phase);
  parts.root.classList.toggle('active', playing && view.turn === seat);
  parts.root.classList.toggle('winner', Boolean(view.results?.winners.includes(seat)));
  const chip = chipFor(seat, view);
  parts.chip.textContent = chip.text;
  parts.chip.classList.toggle('chip-called', Boolean(chip.called));
  parts.chip.classList.toggle('chip-total', Boolean(chip.total));

  player.slots.forEach((_entry, slot) => {
    if (!parts.slots[slot]) {
      parts.slots[slot] = makeSlot(seat, slot);
      parts.grid.append(parts.slots[slot]);
    }
    updateSlot(parts.slots[slot], seat, slot, view);
  });
  layoutSlots(parts, player);

  const holding = view.holding === seat;
  parts.held.classList.toggle('is-holding', holding);
  if (seat === ME) {
    const verb = view.drawnFrom === 'discard' ? 'took' : 'drew';
    parts.root.querySelector('.held-label').textContent = `You ${verb}`;
    setCardHtml(parts.heldCard, holding ? view.drawn : null, false);
    // The prompt no longer names the card, so screen readers need it here.
    parts.heldCard.setAttribute('role', 'img');
    parts.heldCard.setAttribute('aria-label', holding ? `You ${verb} the ${cardWords(view.drawn)}` : '');
  } else {
    // A card taken from the discard pile stays face up, so everyone can follow it.
    const seenByAll = holding && view.drawnFrom === 'discard' ? view.drawn : null;
    parts.heldCard.classList.toggle('back-face', !seenByAll);
    parts.heldCard.classList.toggle('seen-by-all', Boolean(seenByAll));
    setCardHtml(parts.heldCard, seenByAll, true);
    parts.heldCard.setAttribute('role', 'img');
    parts.heldCard.setAttribute('aria-label', seenByAll ? `${seatName(seat)} took the ${cardWords(seenByAll)}` : '');
    let tag = parts.heldCard.querySelector('.xray');
    const shown = xrayOn() && holding && !seenByAll ? game.state.drawn : null;
    if (shown && !tag) {
      tag = document.createElement('span');
      tag.className = 'xray';
      parts.heldCard.append(tag);
    }
    if (tag) {
      tag.hidden = !shown;
      if (shown) {
        tag.textContent = cardName(shown);
        tag.classList.toggle('is-red', isRedCard(shown));
      }
    }
  }
}

function renderPiles(view) {
  const draw = $('drawPile');
  const canDraw = view.legal.includes('draw') && (!tutor || stepAllows(tutorStep(), { type: 'draw' }));
  draw.classList.toggle('can-pick', canDraw);
  draw.classList.toggle('tutor-target', Boolean(tutor) && canDraw);
  draw.setAttribute('aria-disabled', canDraw ? 'false' : 'true');

  const discard = $('discardPile');
  const canMatch = Boolean(ui.matchPick) && (!tutor || stepAllows(tutorStep(), matchPickAction()));
  const canDiscard = !ui.matchPick && view.legal.includes('discard') && (!tutor || stepAllows(tutorStep(), { type: 'discard' }));
  const canTake = !ui.matchPick && view.legal.includes('takeDiscard') && !tutor;
  discard.classList.toggle('can-pick', canDiscard || canTake);
  discard.classList.toggle('can-match', canMatch);
  discard.classList.toggle('tutor-target', Boolean(tutorStep()?.highlight?.discard) || (Boolean(tutor) && (canDiscard || canMatch)));
  discard.setAttribute('aria-disabled', canDiscard || canTake || canMatch ? 'false' : 'true');
  let discardLabel = 'Discard pile, empty';
  if (canMatch) discardLabel = 'Try to match with the card you picked';
  else if (canDiscard) discardLabel = 'Discard the card you drew';
  else if (canTake) discardLabel = `Pick up the ${cardWords(view.discardTop)} from the discard pile`;
  else if (view.discardTop) discardLabel = `Discard pile, ${cardWords(view.discardTop)} on top`;
  discard.setAttribute('aria-label', discardLabel);

  $('drawCount').textContent = String(view.drawCount);
  setCardHtml($('discardTop'), view.discardTop, false);
  setCardHtml($('discardBelow'), view.discardBelow, false);

  const nextCard = xrayOn() ? game.state.drawPile[game.state.drawPile.length - 1] : null;
  const tag = $('drawXray');
  tag.hidden = !nextCard;
  if (nextCard) {
    tag.textContent = cardName(nextCard);
    tag.classList.toggle('is-red', isRedCard(nextCard));
  }
}

function statusText(view) {
  if (view.phase === 'peek') return 'Everyone is memorising.';
  if (view.phase === 'finished') return 'All cards turned over.';
  if (view.phase === 'lastCall') return 'Everyone has had their last go.';
  const whose = view.turn === ME ? 'Your turn.' : `${seatName(view.turn)}’s turn.`;
  if (view.caller === null) return whose;
  const goes = view.finalTurnsLeft + 1;
  const caller = view.caller === ME ? 'You' : seatName(view.caller);
  return `${caller} called Jacks. ${goes} ${goes === 1 ? 'go' : 'goes'} left. ${whose}`;
}

function promptFor(view) {
  if (view.phase === 'finished') return { text: 'Game over.', buttons: finishedButtons() };
  const me = view.players[ME];
  if (!me) return { text: view.phase === 'finished' ? 'Game over.' : 'You’re watching this game.' };
  if (me.out && view.phase !== 'finished') return { text: 'You left this game, so you’re watching.' };
  if (view.phase === 'peek') {
    if (me.ready) return { text: 'Waiting for the others.' };
    return {
      mine: true,
      text: 'Memorise these two cards.',
      buttons: [{ label: 'I’ve memorised them', primary: true, action: { type: 'ready' } }],
    };
  }
  if (view.phase === 'finished') return { text: 'Game over.' };
  if (view.give) {
    if (view.give.seat === ME) {
      return {
        mine: true,
        text: `Give ${seatName(view.give.owner)} one of your cards?`,
        buttons: [{ label: 'Keep my cards', action: { type: 'keepCards' } }],
      };
    }
    return { text: `${seatName(view.give.seat)} is giving a card.` };
  }
  if (view.phase === 'lastCall') {
    if (!view.legal.includes('match')) return { text: 'Everyone has had their last go.' };
    return { text: `Last chance to match the ${rankWord(view.discardTop.rank)}.` };
  }

  if (view.turn !== ME) {
    if (view.caller === ME) return { text: 'You called Jacks.' };
    if (view.discardTop && view.matchOpen) return { text: 'Matching is open.' };
    return { text: `Waiting for ${seatName(view.turn)}.` };
  }

  if (view.phase === 'decide') {
    if (view.legal.includes('place')) return { mine: true, text: 'Put it in one of your empty places.' };
    if (!view.legal.includes('discard')) return { mine: true, text: 'Swap it with one of your cards.' };
    // The outlined discard pile is the way to discard, so there's no button for it.
    return { text: '' };
  }

  if (view.phase === 'power') {
    const { kind, stage, seen } = view.power;
    const skip = { label: 'Don’t use it', action: { type: 'skipPower' } };
    if (stage === 'viewing') {
      return { mine: true, text: 'Remember this card.', buttons: [{ label: 'Done', primary: true, action: { type: 'powerDone' } }] };
    }
    if (stage === 'decide') {
      const [own, other] = seen;
      return {
        mine: true,
        text: `Swap your ${rankWord(own.card.rank)} for ${seatName(other.seat)}’s ${rankWord(other.card.rank)}?`,
        buttons: [
          { label: 'Swap them', primary: true, action: { type: 'queenDecide', swap: true } },
          { label: 'Leave them', action: { type: 'queenDecide', swap: false } },
        ],
      };
    }
    if (kind === 'peekOwn') return { mine: true, text: 'Look at one of your cards.', buttons: [skip] };
    if (kind === 'peekOther') return { mine: true, text: 'Look at someone else’s card.', buttons: [skip] };
    const verb = kind === 'queen' ? 'Look at' : 'Swap';
    if (ui.pick.own === null && !ui.pick.other) {
      return { mine: true, text: `${verb} one of your cards and one of an opponent’s.`, buttons: [skip] };
    }
    return {
      mine: true,
      text: ui.pick.own === null ? 'Now pick one of your cards.' : 'Now pick an opponent’s card.',
      buttons: [skip],
    };
  }

  return { text: '' };
}

/** After a game, so you can get back to dealing once the scores are closed. */
function finishedButtons() {
  const buttons = [];
  if (online ? online.canDeal() : !tutor) buttons.push({ label: 'Deal again', primary: true, run: 'deal' });
  buttons.push({ label: 'Scores', run: 'scores' });
  return buttons;
}

function renderPrompt(view) {
  const prompt = promptFor(view);
  const buttons = prompt.buttons ?? [];
  const signature = JSON.stringify([prompt.text, prompt.mine, buttons, tutor?.index]);
  if (signature === ui.promptSig) return;
  ui.promptSig = signature;
  $('prompt').classList.toggle('is-mine', Boolean(prompt.mine));
  $('promptText').textContent = prompt.text;
  const holder = $('promptButtons');
  holder.textContent = '';
  for (const spec of buttons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn${spec.primary ? ' btn-primary' : ''}`;
    button.textContent = spec.label;
    if (tutor && spec.action) {
      const wanted = stepAllows(tutorStep(), spec.action);
      button.disabled = !wanted;
      button.classList.toggle('tutor-target', wanted);
    }
    button.addEventListener('click', () => (spec.run ? resultChoice(spec.run) : humanAct(spec.action)));
    holder.append(button);
  }
}

// These two sit in the table's bottom corners and keep their space when hidden,
// so your cards don't shift when your turn reaches its end.
function renderTurnButtons(view) {
  const showing = view.legal.includes('endTurn');
  for (const [id, type] of [['callBtn', 'callJacks'], ['endTurnBtn', 'endTurn']]) {
    const button = $(id);
    const wanted = stepAllows(tutorStep(), { type });
    button.classList.toggle('is-off', !showing);
    button.classList.toggle('tutor-target', showing && wanted);
    button.disabled = !showing || (Boolean(tutor) && !wanted);
  }
}

function render() {
  if (!game) return;
  const view = myView();
  // A picked card only counts against the discard it was picked for.
  if (
    ui.matchPick &&
    (!view.legal.includes('match') ||
      !view.players[ui.matchPick.seat].slots[ui.matchPick.slot] ||
      view.discardCount !== ui.matchPick.discardCount)
  ) {
    ui.matchPick = null;
  }
  if (!(view.power && view.power.seat === ME && view.power.stage === 'choose')) ui.pick = { own: null, other: null };
  view.players.forEach((_player, seat) => renderSeat(seat, view));
  renderPiles(view);
  $('status').textContent = statusText(view);
  renderPrompt(view);
  renderTurnButtons(view);
  renderCountdown();
}

function renderCountdown() {
  const el = $('countdown');
  if (ui.deadline === null) {
    el.hidden = true;
    return;
  }
  const seconds = Math.max(0, Math.ceil((ui.deadline - Date.now()) / 1000));
  el.hidden = false;
  el.textContent = `${ui.deadlineLabel} ${seconds}s`;
}

/* ---------- Moves ---------- */

function captureRects() {
  const rects = {
    draw: $('drawPile').getBoundingClientRect(),
    discard: $('discardPile').getBoundingClientRect(),
    held: [],
    slots: {},
  };
  seatEls.forEach((parts, seat) => {
    rects.held[seat] = parts.heldCard.getBoundingClientRect();
    parts.slots.forEach((el, slot) => {
      rects.slots[`${seat}:${slot}`] = el.getBoundingClientRect();
    });
  });
  return rects;
}

function act(seat, action) {
  if (!game) return null;
  const rects = captureRects();
  const result = applyAction(game.state, seat, action);
  if (!result.ok) return result;
  handleEvents(result.events, rects);
  return result;
}

function humanAct(action) {
  if (!game) return;
  if (tutor && !stepAllows(tutorStep(), action)) {
    tutorNudge();
    return;
  }
  ui.matchPick = null;
  if (online) {
    online.act(action);
    render();
    return;
  }
  if (!tutor && action.type === 'draw' && ui.force) {
    const found = stackNextCard(game.state, ui.force);
    if (!found) showHint(`There’s no ${rankWord(ui.force)} left in the draw pile, so this draw is random.`);
    ui.force = '';
    $('forceDraw').value = '';
  }
  const result = act(ME, action);
  if (result && !result.ok) {
    showHint(result.error);
    render();
    return;
  }
  if (tutor) advanceTutor();
}

function handleEvents(events, rects) {
  for (const event of events) {
    game.record.push(event);
    for (const bot of game.bots) {
      if (bot) botObserve(bot, eventFor(event, bot.seat));
    }
    applySideEffects(event);
  }
  render();
  animateEvents(events, rects);
  settleMoved(rects);
  considerBotMatches(events);
  scheduleBots();
}

/** Turns a card face up for a moment. Only for cards everyone has just been shown. */
function revealBriefly(key, reveal) {
  ui.reveals.set(key, reveal);
  later(() => {
    ui.reveals.delete(key);
    render();
  }, REVEAL_MS);
}

function applySideEffects(event) {
  if (event.type === 'matchFailed') revealBriefly(`${event.owner}:${event.slot}`, { card: event.card, bad: true });
  // So everyone can see where a card from the discard pile went, and find it later.
  if (event.type === 'swapped' && event.fromDiscard) revealBriefly(`${event.seat}:${event.slot}`, { card: event.drawnCard });
  if (event.type === 'placed') revealBriefly(`${event.seat}:${event.slot}`, { card: event.card });
  if (event.type === 'gaveCard' || event.type === 'keptCards') {
    ui.giveScheduled = false;
    // A bot's move may have come due while everyone waited, so it needs a new timer.
    ui.botKey = '';
  }
  if (event.type === 'called') showStamp(event.seat);
  if (event.type === 'matchWindowOpened') startMatchCountdown(event.seconds);
  if (event.type === 'matchWindowClosed') ui.deadline = null;
  if (event.type === 'lastCall') startLastCall();
  if (event.type === 'finished') {
    ui.deadline = null;
    ui.matchPick = null;
    later(showResults, RESULTS_DELAY_MS);
  }
}

function startMatchCountdown(seconds) {
  // Online, the server keeps the time.
  if (online) return;
  // A final discard goes straight to the last chance, which has its own timer.
  if (!game.state.matchOpen) return;
  ui.deadline = Date.now() + seconds * 1000;
  ui.deadlineLabel = 'Matching closes in';
  later(() => {
    if (!game || !game.state.matchOpen) return;
    const rects = captureRects();
    const result = closeMatchWindow(game.state);
    if (result.ok) handleEvents(result.events, rects);
  }, seconds * 1000);
}

function startLastCall() {
  // The tutorial turns the cards over when the player presses its button.
  if (tutor || online) return;
  const seconds = lastCallSeconds(game.state.rules);
  ui.deadline = Date.now() + seconds * 1000;
  ui.deadlineLabel = 'Last chance to match:';
  const close = () => {
    if (!game || game.state.phase !== 'lastCall') return;
    // Time can run out while someone is still choosing a card to give.
    if (game.state.give) {
      later(close, 300);
      return;
    }
    const rects = captureRects();
    const result = closeLastCall(game.state);
    if (result.ok) handleEvents(result.events, rects);
  };
  later(close, seconds * 1000);
}

/* ---------- Computer players ---------- */

function runBot(seat) {
  if (!game) return;
  const bot = game.bots[seat];
  const view = viewFor(game.state, seat);
  const action = botAct(bot, view);
  if (!action) return;
  const result = act(seat, action);
  if (result && !result.ok) {
    // A bot should never be refused. If one is, keep the game moving and flag it.
    console.error('Jacks: computer player move refused', seatName(seat), action, result.error);
    const fallback = ['draw', 'discard', 'skipPower', 'powerDone', 'endTurn'].find((type) => view.legal.includes(type));
    if (fallback) act(seat, { type: fallback });
  }
}

function scheduleBots() {
  if (tutor) return;
  const { state } = game;
  if (state.give) {
    // Everyone waits for a computer player to hand over a card, as they do for a person.
    if (state.give.seat !== ME && !ui.giveScheduled) {
      ui.giveScheduled = true;
      const giver = state.give.seat;
      botLater(() => runBot(giver), jitter(...BOT_PACE.give));
    }
    return;
  }
  if (state.phase === 'peek') {
    state.players.forEach((player, seat) => {
      if (seat !== ME && !player.ready && !ui.peekScheduled.has(seat)) {
        ui.peekScheduled.add(seat);
        botLater(() => runBot(seat), jitter(900, 2200));
      }
    });
    return;
  }
  if (state.phase === 'finished' || state.phase === 'lastCall' || state.turn === ME) return;
  const key = `${state.turnCount}:${state.phase}:${state.power?.stage ?? ''}:${state.matchOpen}`;
  if (key === ui.botKey) return;
  ui.botKey = key;
  const [low, high] = BOT_PACE[state.phase];
  const seat = state.turn;
  // Only the latest timer moves, so giving a card can't make a bot move twice.
  ui.botTimer += 1;
  const timer = ui.botTimer;
  botLater(() => {
    if (timer === ui.botTimer) runBot(seat);
  }, jitter(low, high));
}

function considerBotMatches(events) {
  if (!events.some((event) => ['swapped', 'discardedDrawn', 'matched', 'gaveCard', 'keptCards'].includes(event.type))) return;
  const { state, bots } = game;
  const windowMs = state.rules.matchMode === 'countdown' ? state.rules.matchSeconds * 1000 : 3000;
  for (const bot of bots) {
    if (!bot) continue;
    const view = viewFor(state, bot.seat);
    if (botMatchSlot(bot, view) === null) {
      if (botMatchOther(bot, view) && botNoticesMatch(bot)) tryOtherCardLater(bot, view.discardTop.rank);
      continue;
    }
    if (!botNoticesMatch(bot)) continue;
    const rank = view.discardTop.rank;
    let delay = jitter(700, Math.min(2600, windowMs * 0.8));
    // The Slow setting shouldn't make a bot miss a window that closes on a timer.
    if (state.rules.matchMode === 'countdown' || state.phase === 'lastCall') delay = Math.min(delay, windowMs * 0.8 * ui.speed);
    botLater(() => {
      const fresh = viewFor(game.state, bot.seat);
      if (fresh.discardTop?.rank !== rank) return;
      const slot = botMatchSlot(bot, fresh);
      if (slot !== null) act(bot.seat, { type: 'match', slot });
    }, delay);
  }
}

function tryOtherCardLater(bot, rank) {
  // botLater goes faster or slower with the speed tool, but this delay is a rule, so it stays in real seconds.
  botLater(() => {
    const fresh = viewFor(game.state, bot.seat);
    if (fresh.discardTop?.rank !== rank) return;
    const target = botMatchOther(bot, fresh);
    if (target) act(bot.seat, { type: 'match', owner: target.seat, slot: target.slot });
  }, jitter(...BOT_OTHER_MATCH_MS) * ui.speed);
}

/* ---------- Tutorial ---------- */

function tutorStep() {
  return tutor ? TUTORIAL_STEPS[tutor.index] : null;
}

function tutorWantsSlot(seat, slot) {
  return stepSlots(tutorStep()).some((spot) => spot.seat === seat && spot.slot === slot);
}

function tutorPointsAtSlot(seat, slot) {
  return Boolean(tutorStep()?.highlight?.slots?.some((spot) => spot.seat === seat && spot.slot === slot));
}

function tutorNudge() {
  showHint(tutorStep().ada ? 'Wait for Ada’s move.' : 'Not that one. Follow the tutorial step.');
}

function renderCoach() {
  const step = tutorStep();
  if (!step) return;
  $('coachSection').textContent = step.section;
  $('coachBar').style.width = `${Math.round((tutor.index / (TUTORIAL_STEPS.length - 1)) * 100)}%`;
  $('coachTitle').textContent = step.title;
  $('coachBody').textContent = step.body;
  const scores = $('coachScores');
  scores.hidden = !step.scores;
  if (step.scores) scores.innerHTML = scoreTilesHtml(DEFAULT_RULES);
  const next = $('coachNextBtn');
  next.hidden = !step.next;
  if (step.next) next.textContent = step.next;
}

function advanceTutor() {
  tutor.index += 1;
  $('hint').hidden = true;
  render();
  renderCoach();
  const step = tutorStep();
  if (step.ada) playAdaMoves(step.ada, step.pause ?? TUTOR_MOVE_MS);
}

function playAdaMoves([move, ...rest], wait) {
  later(() => {
    act(TUTOR_ADA, move);
    if (rest.length) playAdaMoves(rest, TUTOR_MOVE_MS);
    else later(advanceTutor, move.type === 'endTurn' ? 0 : TUTOR_MOVE_MS);
  }, wait);
}

function tutorNext() {
  const step = tutorStep();
  if (!step?.next) return;
  if (step.finish) {
    const rects = captureRects();
    const result = closeLastCall(game.state);
    if (result.ok) handleEvents(result.events, rects);
  }
  advanceTutor();
}

/* ---------- Clicking on things ---------- */

function onSlotClick(seat, slot) {
  if (!game) return;
  const view = myView();
  if (!view.players[seat].slots[slot]) {
    if (seat === ME && !tutor && view.legal.includes('place')) humanAct({ type: 'place', slot });
    return;
  }
  if (tutor && !tutorWantsSlot(seat, slot)) {
    tutorNudge();
    return;
  }

  if (view.legal.includes('giveCard')) {
    if (seat === ME) humanAct({ type: 'giveCard', slot });
    return;
  }
  if (seat === ME && view.legal.includes('swap')) {
    humanAct({ type: 'swap', slot });
    return;
  }
  const power = view.power;
  if (power && power.seat === ME && power.stage === 'choose') {
    if (power.kind === 'blindSwap' || power.kind === 'queen') {
      if (seat === ME) ui.pick.own = slot;
      else ui.pick.other = { seat, slot };
      if (ui.pick.own !== null && ui.pick.other) {
        const action = {
          type: power.kind === 'queen' ? 'queenLook' : 'blindSwap',
          own: ui.pick.own,
          other: ui.pick.other,
        };
        ui.pick = { own: null, other: null };
        humanAct(action);
        return;
      }
      render();
      return;
    }
    if ((power.kind === 'peekOwn') === (seat === ME)) {
      humanAct({ type: 'peek', target: { seat, slot } });
      return;
    }
  }
  if (view.legal.includes('match')) toggleMatchPick(seat, slot, view);
}

/** Picks a card to try a match with. The next press of the discard pile tries it. */
function toggleMatchPick(seat, slot, view) {
  const same = ui.matchPick?.seat === seat && ui.matchPick.slot === slot;
  ui.matchPick = same ? null : { seat, slot, discardCount: view.discardCount };
  $('hint').hidden = true;
  if (stepAllows(tutorStep(), { type: 'pickForMatch', seat, slot })) advanceTutor();
  else render();
}

function matchPickAction() {
  return { type: 'match', owner: ui.matchPick.seat, slot: ui.matchPick.slot };
}

function onDiscardPileClick() {
  if (!game) return;
  const view = myView();
  if (ui.matchPick && view.legal.includes('match')) humanAct(matchPickAction());
  else if (view.legal.includes('discard')) humanAct({ type: 'discard' });
  else if (view.legal.includes('takeDiscard')) humanAct({ type: 'takeDiscard' });
}

function showHint(text) {
  const hint = $('hint');
  hint.textContent = text;
  hint.hidden = false;
  later(() => {
    if (hint.textContent === text) hint.hidden = true;
  }, 3200);
}

/* ---------- Animation ---------- */

function flyFrom(el, from, duration = 380) {
  if (calmMotion || !el || !from) return;
  const to = el.getBoundingClientRect();
  if (!to.width || !from.width) return;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const scale = from.width / to.width;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  el.style.zIndex = '40';
  const flight = el.animate(
    [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: 'none' }],
    { duration, easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)' },
  );
  flight.onfinish = () => {
    el.style.zIndex = '';
  };
  flight.oncancel = flight.onfinish;
}

function flashCard(el) {
  if (calmMotion || !el) return;
  el.animate(
    [{ boxShadow: '0 0 0 4px var(--brass)' }, { boxShadow: '0 0 0 4px var(--brass)', offset: 0.5 }, { boxShadow: '0 0 0 0 transparent' }],
    { duration: 1300, easing: 'ease-out' },
  );
}

function animateEvents(events, rects) {
  const slotOf = (seat, slot) => seatEls[seat]?.slots[slot];
  const swapEffect = (a, b) => {
    const elA = slotOf(a.seat, a.slot);
    const elB = slotOf(b.seat, b.slot);
    flyFrom(elA, rects.slots[`${b.seat}:${b.slot}`], 480);
    flyFrom(elB, rects.slots[`${a.seat}:${a.slot}`], 480);
    flashCard(elA);
    flashCard(elB);
  };
  for (const event of events) {
    switch (event.type) {
      case 'drew':
        flyFrom(seatEls[event.seat].heldCard, rects.draw);
        break;
      case 'tookDiscard':
        flyFrom(seatEls[event.seat].heldCard, rects.discard);
        break;
      case 'placed': {
        const el = slotOf(event.seat, event.slot);
        flyFrom(el, rects.held[event.seat]);
        flashCard(el);
        break;
      }
      case 'refilled': {
        const el = slotOf(event.owner, event.slot);
        flyFrom(el, rects.draw, 520);
        flashCard(el);
        break;
      }
      case 'swapped': {
        const el = slotOf(event.seat, event.slot);
        flyFrom(el, rects.held[event.seat]);
        flyFrom($('discardTop'), rects.slots[`${event.seat}:${event.slot}`]);
        flashCard(el);
        break;
      }
      case 'discardedDrawn':
        flyFrom($('discardTop'), rects.held[event.seat]);
        break;
      case 'blindSwapped':
        swapEffect(event.a, event.b);
        break;
      case 'queenResolved':
        if (event.swapped) swapEffect(event.a, event.b);
        break;
      case 'matched':
        flyFrom($('discardTop'), rects.slots[`${event.owner}:${event.slot}`]);
        break;
      case 'matchFailed':
        if (event.penaltySlot !== null) flyFrom(slotOf(event.seat, event.penaltySlot), rects.draw, 520);
        break;
      case 'gaveCard': {
        const el = slotOf(event.owner, event.ownerSlot);
        flyFrom(el, rects.slots[`${event.seat}:${event.slot}`], 480);
        flashCard(el);
        break;
      }
      default:
    }
  }
}

function showStamp(seat) {
  const stamp = $('stamp');
  const who = seat === ME ? 'You called it' : `${seatName(seat)} called it`;
  stamp.innerHTML = `<span class="stamp-word">Jacks!</span><span class="stamp-sub">${escapeHtml(who)}.</span>`;
  stamp.hidden = false;
  stamp.classList.remove('stamp-in');
  void stamp.offsetWidth;
  stamp.classList.add('stamp-in');
  later(() => {
    stamp.hidden = true;
  }, 1800);
}

/* ---------- Bug reports ---------- */

async function copyRecord() {
  if (!game) return;
  const { state, record } = game;
  const text = JSON.stringify(
    {
      game: 'Jacks',
      engine: ENGINE_VERSION,
      seed: state.seed,
      rules: state.rules,
      players: state.players.map((player) => player.name),
      phase: state.phase,
      currentHands: state.players.map((player) => player.slots.map((card) => (card ? cardKey(card) : null))),
      events: record,
    },
    null,
    1,
  );
  const button = $('copyRecordBtn');
  const box = $('recordFallback');
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
    box.hidden = true;
    later(() => {
      button.textContent = 'Copy full game record';
    }, 1800);
  } catch {
    box.value = text;
    box.hidden = false;
    box.focus();
    box.select();
    button.textContent = 'Select and copy from the box';
  }
}

/* ---------- Results ---------- */

function showResults() {
  if (!game || game.state.phase !== 'finished') return;
  const { results, caller } = game.state;
  const winners = results.winners;
  const panel = $('results');
  const winnerNames = winners.map((seat) => (seat === ME ? 'You' : seatName(seat)));
  let headline;
  if (winners.length > 1) headline = `${winnerNames.join(' and ')} tie on ${scoreText(results.best)}`;
  else if (winners[0] === ME) headline = `You win with ${scoreText(results.best)}`;
  else headline = `${winnerNames[0]} wins with ${scoreText(results.best)}`;

  const callerName = caller === ME ? 'You' : seatName(caller);
  const callerWon = winners.includes(caller);
  const callerTied = !callerWon && results.standings.find((row) => row.called).total === results.best;
  let sub = `${callerName} called Jacks, but ${caller === ME ? 'weren’t' : 'wasn’t'} lowest.`;
  if (callerWon) sub = `${callerName} called Jacks and got it right.`;
  else if (callerTied) sub = `${callerName} called Jacks and tied, so ${caller === ME ? 'you lose' : `${callerName} loses`}.`;

  const rows = results.standings
    .map((row) => {
      const cards = row.cards.length
        ? row.cards.map((card) => `<span class="result-card">${cardSvg(card, true)}</span>`).join('')
        : `<span class="result-empty">${row.out ? 'Left the game' : 'No cards left'}</span>`;
      const tag = row.called ? '<span class="result-tag">Called Jacks</span>' : '';
      return `<li class="result-row${winners.includes(row.seat) ? ' is-winner' : ''}">
        <span class="result-name">${escapeHtml(row.seat === ME ? 'You' : row.name)}${tag}</span>
        <span class="result-cards">${cards}</span>
        <span class="result-total">${row.out ? '' : scoreText(row.total)}</span>
      </li>`;
    })
    .join('');

  const actions = online
    ? online.resultButtons()
    : tutor
    ? `<button type="button" class="btn btn-primary" data-result="deal">Deal a real game</button>
       <button type="button" class="btn" data-result="tutorial">Do the tutorial again</button>
       <button type="button" class="btn" data-result="lobby">Back to the menu</button>`
    : `<button type="button" class="btn btn-primary" data-result="deal">Deal again</button>
       <button type="button" class="btn" data-result="table">See the table</button>
       <button type="button" class="btn" data-result="lobby">Return to menu</button>`;
  panel.innerHTML = `
    <h2>${escapeHtml(headline)}</h2>
    <p class="results-sub">${escapeHtml(sub)}</p>
    <ol class="results-list">${rows}</ol>
    <div class="results-actions">${actions}</div>`;
  panel.hidden = false;
}

/* ---------- Lobby ---------- */

function heroCard(card) {
  return card ? `<div class="hero-card">${cardSvg(card)}</div>` : '<div class="hero-card back-face"></div>';
}

function scoreTilesHtml(rules) {
  const tiles = [
    [{ rank: 'JOKER', suit: 'R' }, 'Joker'],
    [{ rank: 'K', suit: 'D' }, 'Red king'],
    [{ rank: 'A', suit: 'S' }, 'Ace'],
    [{ rank: 'J', suit: 'C' }, 'Jack'],
    [{ rank: 'Q', suit: 'H' }, 'Queen'],
    [{ rank: 'K', suit: 'S' }, 'Black king'],
  ];
  return tiles
    .map(
      ([card, label]) =>
        `<div class="score-tile"><div class="hero-card">${cardSvg(card)}</div><b>${scoreText(scoreCard(card, rules))}</b><span>${label}</span></div>`,
    )
    .join('');
}

function renderLobby() {
  $('heroHand').innerHTML = [null, null, { rank: 'K', suit: 'H' }, { rank: '7', suit: 'C' }].map(heroCard).join('');

  const seats = $('seatButtons');
  seats.textContent = '';
  for (let count = 1; count <= BOT_NAMES.length; count++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = String(count);
    button.setAttribute('aria-pressed', String(count === opponentCount));
    button.setAttribute('aria-label', `${count} computer ${count === 1 ? 'player' : 'players'}`);
    button.addEventListener('click', () => {
      opponentCount = count;
      renderLobby();
    });
    seats.append(button);
  }

  const pickUp = settings.drawFromDiscard ? ' You can pick up from the discard pile.' : '';
  $('settingsSummary').textContent = `${faceScoresSentence(settings)}. ${matchingSentence(settings)}${pickUp}`;
}

function openRules() {
  $('rulesDialogBody').innerHTML = rulesHtml(online && game ? game.state.rules : settings);
  $('rulesDialog').showModal();
}

/* ---------- Settings menu ---------- */

function fillSettingsForm() {
  $('setJack').value = settings.jack;
  $('setQueen').value = settings.queen;
  $('setBlackKing').value = settings.blackKing;
  $('setRedKing').value = settings.redKing;
  $('matchNext').checked = settings.matchMode === 'nextDiscard';
  $('matchCountdown').checked = settings.matchMode === 'countdown';
  $('setDrawFromDiscard').checked = settings.drawFromDiscard;
  const seconds = $('matchSeconds');
  seconds.value = [...seconds.options].some((option) => Number(option.value) === settings.matchSeconds)
    ? String(settings.matchSeconds)
    : '5';
  refreshSecondsField();
}

function refreshSecondsField() {
  const on = $('matchCountdown').checked;
  $('matchSeconds').disabled = !on;
  $('matchSeconds').parentElement.classList.toggle('is-off', !on);
}

function readSettingsForm() {
  settings = normaliseRules({
    jack: $('setJack').value,
    queen: $('setQueen').value,
    blackKing: $('setBlackKing').value,
    redKing: $('setRedKing').value,
    matchMode: $('matchCountdown').checked ? 'countdown' : 'nextDiscard',
    matchSeconds: $('matchSeconds').value,
    drawFromDiscard: $('setDrawFromDiscard').checked,
  });
  saveSettings();
  refreshSecondsField();
  if (!$('lobby').hidden) renderLobby();
}

function applyPreset(jack, queen, blackKing) {
  $('setJack').value = jack;
  $('setQueen').value = queen;
  $('setBlackKing').value = blackKing;
  readSettingsForm();
}

function openSettings() {
  fillSettingsForm();
  const inGame = Boolean(game) && game.state.phase !== 'finished';
  $('settingsApplies').hidden = !inGame || Boolean(online);
  $('settingsDealBtn').hidden = !game || Boolean(online);
  $('settingsDialog').showModal();
}

// Closes directly rather than through a form submit, which the sandboxed
// frames this page runs in can block.
function closeSettings() {
  readSettingsForm();
  $('settingsDialog').close();
}

/** A button under the scores, or one of the same buttons once they're closed. */
function resultChoice(choice) {
  if (choice === 'table') {
    $('results').hidden = true;
    return;
  }
  if (choice === 'scores') {
    showResults();
    return;
  }
  if (online) {
    online.result(choice);
    return;
  }
  if (choice === 'deal') dealNewGame();
  if (choice === 'lobby') showLobby();
  if (choice === 'tutorial') startTutorial();
}

/* ---------- Wiring ---------- */

function wireControls() {
  $('dealBtn').addEventListener('click', dealNewGame);
  $('tutorialBtn').addEventListener('click', startTutorial);
  $('coachNextBtn').addEventListener('click', tutorNext);
  $('coachLeaveBtn').addEventListener('click', showLobby);
  $('lobbyRulesBtn').addEventListener('click', openRules);
  $('rulesCloseBtn').addEventListener('click', () => $('rulesDialog').close());
  $('rulesOkBtn').addEventListener('click', () => $('rulesDialog').close());
  $('lobbySettingsBtn').addEventListener('click', openSettings);
  $('gameSettingsBtn').addEventListener('click', openSettings);
  $('dealAgainBtn').addEventListener('click', dealNewGame);
  $('lobbyBtn').addEventListener('click', showLobby);
  $('copyRecordBtn').addEventListener('click', copyRecord);

  $('drawPile').addEventListener('click', () => {
    if (!game) return;
    if (myView().legal.includes('draw')) humanAct({ type: 'draw' });
  });

  $('discardPile').addEventListener('click', onDiscardPileClick);

  $('callBtn').addEventListener('click', () => humanAct({ type: 'callJacks' }));
  $('endTurnBtn').addEventListener('click', () => humanAct({ type: 'endTurn' }));

  document.addEventListener('click', (event) => {
    const slot = event.target.closest?.('.card[data-seat]');
    if (slot) onSlotClick(Number(slot.dataset.seat), Number(slot.dataset.slot));
    const resultButton = event.target.closest?.('[data-result]');
    if (resultButton) resultChoice(resultButton.dataset.result);
  });

  document.addEventListener('keydown', (event) => {
    if ($('settingsDialog').open || $('rulesDialog').open || event.target.closest?.('input, select, textarea')) return;
    if (event.key === 'Escape' && ui.matchPick) {
      ui.matchPick = null;
      render();
    }
  });

  $('xrayToggle').addEventListener('change', (event) => {
    ui.xray = event.target.checked;
    render();
  });
  $('pauseToggle').addEventListener('change', (event) => {
    ui.paused = event.target.checked;
  });
  $('forceDraw').addEventListener('change', (event) => {
    ui.force = event.target.value;
  });
  $('botSpeed').addEventListener('change', (event) => {
    ui.speed = Number(event.target.value) || 1;
  });

  $('settingsPanel').addEventListener('input', readSettingsForm);
  $('settingsCloseBtn').addEventListener('click', closeSettings);
  $('settingsOkBtn').addEventListener('click', closeSettings);
  $('presetTens').addEventListener('click', () => applyPreset(10, 10, 10));
  $('presetSequence').addEventListener('click', () => applyPreset(11, 12, 13));
  $('settingsDealBtn').addEventListener('click', () => {
    closeSettings();
    dealNewGame();
  });
  $('settingsDialog').addEventListener('close', () => {
    fillSettingsForm();
    if (!$('lobby').hidden) renderLobby();
    online?.settingsChanged(settings);
  });

  setInterval(() => {
    if (game && ui.deadline !== null) renderCountdown();
  }, 200);
}

function start(data) {
  wireControls();
  fillSettingsForm();
  if (data?.opponentCount) opponentCount = data.opponentCount;
  // Storage can be blocked where this page runs, so an update carries the settings across too.
  if (data?.settings) {
    settings = normaliseRules(data.settings);
    fillSettingsForm();
  }
  if (data?.game?.state?.engine === ENGINE_VERSION) resumeGame(data.game);
  else showLobby();
}

/* ---------- The Discord version ---------- */

/**
 * Starts the table for an online game. hooks:
 *   act(action)        send your move to the server
 *   away(seat)         true if that player has left or gone quiet
 *   resultButtons()    HTML for the buttons under the results
 *   result(choice)     one of those buttons was pressed
 *   settingsChanged(s) the settings menu was closed
 */
export function startOnline(hooks) {
  online = hooks;
  wireControls();
  fillSettingsForm();
  let gameId = null;
  return {
    /** A new view from the server, with the events that led to it. */
    update({ id, view, events, deadline }) {
      const fresh = !game || id !== gameId || view.you !== ME || view.players.length !== seatEls.length;
      let rects = null;
      if (fresh) {
        resetTableState();
        gameId = id;
        ME = view.you;
        game = { state: view, bots: [], record: [] };
        showGame();
        buildTable();
      } else {
        rects = captureRects();
        game.state = view;
        for (const event of events) applySideEffects(event);
      }
      ui.deadline = deadline ? Date.now() + deadline.ms : null;
      ui.deadlineLabel = deadline?.kind === 'lastCall' ? 'Last chance to match:' : 'Matching closes in';
      render();
      if (rects) {
        animateEvents(events, rects);
        settleMoved(rects);
      }
      if (fresh && view.phase === 'finished') showResults();
    },
    refuse: showHint,
    redraw() {
      render();
      if (game && !$('results').hidden) showResults();
    },
    close() {
      resetTableState();
      game = null;
      gameId = null;
      $('game').hidden = true;
    },
    openSettings,
    openRules,
    settings: () => settings,
    setSettings(rules) {
      if ($('settingsDialog').open) return;
      settings = normaliseRules(rules);
      fillSettingsForm();
    },
    summary: (rules) => `${faceScoresSentence(rules)}. ${matchingSentence(rules)}${rules.drawFromDiscard ? ' You can pick up from the discard pile.' : ''}`,
    cardSvg,
    escapeHtml,
  };
}

const isOnlinePage = Boolean(document.querySelector('meta[name="jacks-mode"][content="online"]'));

// Keeps a game going if this page is updated while it's open.
try {
  window.claude?.hot?.snapshot?.(() => ({ game: tutor || online ? null : game, opponentCount, settings }));
} catch {
  // The hook only exists in the artifact viewer.
}

if (isOnlinePage) {
  // The Discord client calls startOnline() once it has signed in.
} else if (window.claude?.hot?.ready) window.claude.hot.ready(start);
else start(window.claude?.hot?.data ?? {});
