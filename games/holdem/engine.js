// The rules of no-limit Texas Hold'em. Pure and JSON-safe: the whole game is
// one plain object, changed only by applyAction(), step(), nextHand() and
// forfeit().
//
// A game is a set number of hands. Everyone starts with the same chips; whoever
// has the most at the end wins, or the last player with any chips.
//
// The engine takes moves from the network, so applyAction() never throws and a
// refused move leaves the state exactly as it was.

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const START_CHIPS = 1000;
export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const DEFAULT_RULES = Object.freeze({ hands: 20 });
export const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

/** Accepts anything and always returns a sane rule set. */
export function normaliseRules(given) {
  const hands = given && typeof given === 'object' ? given.hands : undefined;
  return { hands: Number.isInteger(hands) ? Math.min(100, Math.max(1, hands)) : DEFAULT_RULES.hands };
}

/** A small seeded generator, so tests and bug reports replay exactly. */
export function nextRandom(holder) {
  holder.rng = (holder.rng + 0x6d2b79f5) | 0;
  let t = holder.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const isIndex = (value, length) => Number.isInteger(value) && value >= 0 && value < length;
export const cardValue = (card) => RANKS.indexOf(card.rank) + 2;

/**
 * Scores the best five-card hand in five to seven cards. Returns a list of
 * numbers: the kind of hand (0 high card ... 8 straight flush), then the
 * tie-breakers. Compare two with compareScores().
 */
export function evaluate(cards) {
  const values = cards.map(cardValue);
  const bySuit = {};
  for (const card of cards) (bySuit[card.suit] ??= []).push(cardValue(card));
  const flush = Object.values(bySuit).find((suited) => suited.length >= 5);
  const straightHigh = (list) => {
    const have = new Set(list);
    if (have.has(14)) have.add(1); // the ace also plays low
    for (let high = 14; high >= 5; high--) {
      let run = true;
      for (let step = 0; step < 5 && run; step++) run = have.has(high - step);
      if (run) return high;
    }
    return 0;
  };
  if (flush) {
    const high = straightHigh(flush);
    if (high) return [8, high];
  }
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const distinct = [...counts.keys()].sort((a, b) => b - a);
  const kickers = (used, count) => distinct.filter((value) => !used.includes(value)).slice(0, count);
  const [first, second] = groups;
  if (first[1] === 4) return [7, first[0], ...kickers([first[0]], 1)];
  if (first[1] === 3 && second && second[1] >= 2) return [6, first[0], second[0]];
  if (flush) return [5, ...[...flush].sort((a, b) => b - a).slice(0, 5)];
  const high = straightHigh(values);
  if (high) return [4, high];
  if (first[1] === 3) return [3, first[0], ...kickers([first[0]], 2)];
  if (first[1] === 2 && second && second[1] === 2) return [2, first[0], second[0], ...kickers([first[0], second[0]], 1)];
  if (first[1] === 2) return [1, first[0], ...kickers([first[0]], 3)];
  return [0, ...distinct.slice(0, 5)];
}

export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const handName = (score) => (score[0] === 8 && score[1] === 14 ? 'Royal flush' : HAND_NAMES[score[0]]);

function shuffledDeck(state, random) {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor((random ? random() : nextRandom(state)) * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const alive = (player) => !player.out && player.chips > 0;
const contenders = (state) => state.players.filter((player) => player.inHand && !player.folded);
const canAct = (state) => state.players.filter((player) => player.inHand && !player.folded && !player.allIn);
const needsAction = (state) => (player) => player.inHand && !player.folded && !player.allIn && (!player.acted || player.bet < state.currentBet);
const potTotal = (state) => state.players.reduce((sum, player) => sum + player.total, 0);

/** The first seat after `from` that passes the test, or -1. Checks `from` itself last. */
function nextSeat(state, from, test) {
  const count = state.players.length;
  for (let step = 1; step <= count; step++) {
    const seat = (((from + step) % count) + count) % count;
    if (test(state.players[seat], seat)) return seat;
  }
  return -1;
}

function put(player, amount) {
  const paid = Math.min(amount, player.chips);
  player.chips -= paid;
  player.bet += paid;
  player.total += paid;
  if (player.chips === 0) player.allIn = true;
}

export function createGame({ players, seed = Date.now(), rules, random = null }) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`Hold'em needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }
  const state = {
    version: ENGINE_VERSION,
    rng: seed | 0,
    rules: normaliseRules(rules),
    phase: 'play',
    hand: 0,
    button: -1,
    deck: [],
    board: [],
    street: 'preflop',
    currentBet: 0,
    minRaise: BIG_BLIND,
    turn: -1,
    reveal: false, // hole cards are face up: an all-in with no more betting, or the showdown
    last: null, // how the last hand was won
    players: players.map(({ id, name }) => ({
      id, name, chips: START_CHIPS, out: false, inHand: false, folded: false, allIn: false, cards: [], bet: 0, total: 0, acted: false, said: '',
    })),
    results: null,
  };
  state.button = Math.floor((random ? random() : nextRandom(state)) * players.length) - 1;
  startHand(state, [], random);
  return state;
}

function startHand(state, events, random) {
  state.hand += 1;
  state.board = [];
  state.street = 'preflop';
  state.last = null;
  state.reveal = false;
  for (const player of state.players) {
    Object.assign(player, { inHand: alive(player), folded: false, allIn: false, cards: [], bet: 0, total: 0, acted: false, said: '' });
  }
  const dealtIn = (player) => player.inHand;
  state.button = nextSeat(state, state.button, dealtIn);
  state.deck = shuffledDeck(state, random);
  for (let pass = 0; pass < 2; pass++) for (const player of state.players) if (player.inHand) player.cards.push(state.deck.pop());
  // Heads-up, the button posts the small blind and acts first before the flop.
  const headsUp = state.players.filter(dealtIn).length === 2;
  const small = headsUp ? state.button : nextSeat(state, state.button, dealtIn);
  const big = nextSeat(state, small, dealtIn);
  put(state.players[small], SMALL_BLIND);
  put(state.players[big], BIG_BLIND);
  state.currentBet = BIG_BLIND;
  state.minRaise = BIG_BLIND;
  state.phase = 'play';
  state.turn = big;
  events.push({ type: 'hand', hand: state.hand });
  advance(state, events);
}

function computeResults(state) {
  const staying = state.players.filter((player) => !player.out);
  const best = Math.max(0, ...staying.map((player) => player.chips));
  const rows = state.players.map((player, seat) => ({ seat, name: player.name, chips: player.chips, out: player.out }));
  return {
    winners: rows.filter((row) => !row.out && row.chips === best).map((row) => row.seat),
    rows: [...rows].sort((a, b) => Number(a.out) - Number(b.out) || b.chips - a.chips || a.seat - b.seat),
  };
}

function finish(state, events) {
  state.phase = 'finished';
  state.turn = -1;
  state.results = computeResults(state);
  events.push({ type: 'finished', results: state.results });
}

function endHand(state, events, last) {
  state.last = last;
  state.phase = 'showdown';
  state.turn = -1;
  for (const player of state.players) {
    player.bet = 0;
    player.total = 0;
  }
  events.push({ type: 'won', pots: last.pots });
}

/** A bet nobody matched goes straight back, so it never counts as winnings. */
function refundUncalled(state) {
  const [top, next] = [...state.players].sort((a, b) => b.total - a.total);
  const extra = top.total - (next?.total ?? 0);
  if (extra <= 0 || !top.inHand || top.folded) return;
  top.chips += extra;
  top.total -= extra;
}

/** Everyone else folded: the one left takes the pot without showing. */
function awardUncontested(state, events) {
  refundUncalled(state);
  const winner = state.players.findIndex((player) => player.inHand && !player.folded);
  const amount = potTotal(state);
  state.players[winner].chips += amount;
  endHand(state, events, { pots: [{ amount, winners: [winner] }], shown: [], hands: {} });
}

/** Compares hands and pays the main pot and any side pots. */
function showdown(state, events) {
  refundUncalled(state);
  const seats = state.players.map((_player, seat) => seat).filter((seat) => state.players[seat].inHand && !state.players[seat].folded);
  const scores = new Map(seats.map((seat) => [seat, evaluate([...state.players[seat].cards, ...state.board])]));
  const levels = [...new Set(seats.map((seat) => state.players[seat].total))].sort((a, b) => a - b);
  const pots = [];
  let below = 0;
  for (const level of levels) {
    const amount = state.players.reduce((sum, player) => sum + Math.min(player.total, level) - Math.min(player.total, below), 0);
    const eligible = seats.filter((seat) => state.players[seat].total >= level);
    below = level;
    if (amount <= 0) continue;
    const best = eligible.reduce((top, seat) => (compareScores(scores.get(seat), top) > 0 ? scores.get(seat) : top), scores.get(eligible[0]));
    pots.push({ amount, winners: eligible.filter((seat) => compareScores(scores.get(seat), best) === 0) });
  }
  // Chips a folded player put in above the highest live bet (should not happen) go to the last pot.
  const stray = state.players.reduce((sum, player) => sum + Math.max(0, player.total - below), 0);
  if (stray > 0 && pots.length) pots.at(-1).amount += stray;
  for (const pot of pots) {
    const share = Math.floor(pot.amount / pot.winners.length);
    let odd = pot.amount - share * pot.winners.length;
    // Odd chips go to the winners nearest the button's left.
    const order = [...pot.winners].sort((a, b) => ((a - state.button - 1 + state.players.length) % state.players.length) - ((b - state.button - 1 + state.players.length) % state.players.length));
    for (const seat of order) {
      state.players[seat].chips += share + (odd > 0 ? 1 : 0);
      odd -= 1;
    }
  }
  state.reveal = true;
  events.push({ type: 'showdown' });
  endHand(state, events, { pots, shown: seats, hands: Object.fromEntries(seats.map((seat) => [seat, handName(scores.get(seat))])) });
}

function dealStreet(state, events) {
  const next = { preflop: 'flop', flop: 'turn', turn: 'river' }[state.street];
  state.street = next;
  for (let i = 0; i < (next === 'flop' ? 3 : 1); i++) state.board.push(state.deck.pop());
  events.push({ type: 'street', street: next });
}

function endStreet(state, events) {
  for (const player of state.players) {
    player.bet = 0;
    player.acted = false;
    if (!player.folded && !player.allIn) player.said = '';
  }
  state.currentBet = 0;
  state.minRaise = BIG_BLIND;
  if (canAct(state).length <= 1) {
    // No more betting is possible: turn the cards over and deal out the board.
    if (state.board.length === 5) return showdown(state, events);
    state.phase = 'runout';
    state.reveal = true;
    state.turn = -1;
    events.push({ type: 'runout' });
    return undefined;
  }
  if (state.street === 'river') return showdown(state, events);
  dealStreet(state, events);
  state.turn = nextSeat(state, state.button, needsAction(state));
  events.push({ type: 'turn', seat: state.turn });
  return undefined;
}

/** Moves to the next player who has to act, or ends the betting round or the hand. */
function advance(state, events) {
  if (contenders(state).length === 1) return awardUncontested(state, events);
  const able = canAct(state);
  const settled = able.length === 0 || (able.length === 1 && able[0].bet >= state.currentBet);
  const next = settled ? -1 : nextSeat(state, state.turn, needsAction(state));
  if (next === -1) return endStreet(state, events);
  state.turn = next;
  events.push({ type: 'turn', seat: next });
  return undefined;
}

const MOVES = {
  fold(state, seat) {
    const player = state.players[seat];
    player.folded = true;
    player.said = 'Fold';
    return null;
  },
  check(state, seat) {
    const player = state.players[seat];
    if (player.bet < state.currentBet) return 'You have to call, raise or fold.';
    player.acted = true;
    player.said = 'Check';
    return null;
  },
  call(state, seat) {
    const player = state.players[seat];
    if (player.bet >= state.currentBet) return 'There’s nothing to call.';
    put(player, state.currentBet - player.bet);
    player.acted = true;
    player.said = player.allIn ? 'All in' : 'Call';
    return null;
  },
  raise(state, seat, action) {
    const player = state.players[seat];
    const { to } = action;
    const most = player.bet + player.chips;
    if (!Number.isInteger(to) || to <= state.currentBet || to > most) return 'That bet isn’t allowed.';
    if (to < state.currentBet + state.minRaise && to !== most) return `Raise to at least ${state.currentBet + state.minRaise}.`;
    if (!state.players.some((other) => other !== player && other.inHand && !other.folded && !other.allIn)) return 'There’s nobody left to bet against.';
    const opening = state.currentBet === 0;
    const size = to - state.currentBet;
    put(player, to - player.bet);
    if (size >= state.minRaise) state.minRaise = size;
    state.currentBet = to;
    for (const other of state.players) other.acted = other === player;
    player.said = player.allIn ? 'All in' : opening ? 'Bet' : 'Raise';
    return null;
  },
};

export function legalActions(state, seat) {
  if (state.phase !== 'play' || !isIndex(seat, state.players.length) || state.turn !== seat) return [];
  const player = state.players[seat];
  if (player.out) return [];
  const legal = ['fold', player.bet < state.currentBet ? 'call' : 'check'];
  const others = state.players.some((other) => other !== player && other.inHand && !other.folded && !other.allIn);
  if (others && player.bet + player.chips > state.currentBet) legal.push('raise');
  return legal;
}

/** Returns { ok: true, events } or { ok: false, error }. Never throws. */
export function applyAction(state, seat, action) {
  try {
    if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string' || !Object.hasOwn(MOVES, action.type)) {
      return { ok: false, error: 'Unknown move.' };
    }
    if (state.phase === 'finished') return { ok: false, error: 'The game is over.' };
    if (state.players[seat].out) return { ok: false, error: 'You’ve left this game.' };
    if (state.phase !== 'play') return { ok: false, error: 'You can’t do that now.' };
    if (state.turn !== seat) return { ok: false, error: 'It isn’t your turn.' };
    const refusal = MOVES[action.type](state, seat, action);
    if (refusal) return { ok: false, error: refusal };
    const events = [{ type: 'acted', seat, said: state.players[seat].said }];
    advance(state, events);
    return { ok: true, events };
  } catch (error) {
    return { ok: false, error: 'Something went wrong with that move.', bug: String(error?.stack ?? error) };
  }
}

/** With everyone all in, deals the rest of the board one street at a time, then the showdown. */
export function step(state) {
  if (state.phase !== 'runout') return { ok: false, error: 'Nothing to deal.' };
  const events = [];
  if (state.board.length < 5) dealStreet(state, events);
  else showdown(state, events);
  return { ok: true, events };
}

/** After a hand is won: the next hand, or the end of the game. */
export function nextHand(state, options = {}) {
  if (state.phase !== 'showdown') return { ok: false, error: 'The hand isn’t over.' };
  const events = [];
  if (state.hand >= state.rules.hands || state.players.filter(alive).length < 2) finish(state, events);
  else startHand(state, events, options.random ?? null);
  return { ok: true, events };
}

/** A player has left for good. Their hand is folded, what they bet stays in the pot, and they can't win. */
export function forfeit(state, seat) {
  if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
  const player = state.players[seat];
  if (state.phase === 'finished' || player.out) return { ok: false, error: 'Nothing to do.' };
  const events = [{ type: 'left', seat }];
  player.out = true;
  if (!state.players.some((other) => !other.out)) {
    finish(state, events);
    return { ok: true, events };
  }
  if ((state.phase === 'play' || state.phase === 'runout') && player.inHand && !player.folded) {
    player.folded = true;
    player.said = 'Left';
    if (contenders(state).length === 1) awardUncontested(state, events);
    else if (state.phase === 'play' && state.turn === seat) advance(state, events);
  }
  return { ok: true, events };
}

/** What one seat may know: their own two cards, and everyone's once they are turned over. */
export function viewFor(state, viewer) {
  const me = state.players[viewer];
  const shown = (seat) =>
    seat === viewer ||
    (state.phase === 'runout' && state.players[seat].inHand && !state.players[seat].folded) ||
    ((state.phase === 'showdown' || state.phase === 'finished') && Boolean(state.last?.shown.includes(seat)));
  const mine = me?.inHand && !me.folded && state.board.length >= 3 ? handName(evaluate([...me.cards, ...state.board])) : null;
  return {
    game: 'holdem',
    you: viewer,
    phase: state.phase,
    hand: state.hand,
    hands: state.rules.hands,
    street: state.street,
    button: state.button,
    turn: state.turn,
    board: state.board.map((card) => ({ ...card })),
    pot: potTotal(state),
    currentBet: state.currentBet,
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    toCall: me && state.turn === viewer ? Math.min(Math.max(0, state.currentBet - me.bet), me.chips) : 0,
    minRaiseTo: me ? Math.min(state.currentBet + state.minRaise, me.bet + me.chips) : 0,
    maxRaiseTo: me ? me.bet + me.chips : 0,
    best: mine,
    last: state.last,
    rules: state.rules,
    legal: legalActions(state, viewer),
    results: state.results,
    players: state.players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      chips: player.chips,
      out: player.out,
      inHand: player.inHand,
      folded: player.folded,
      allIn: player.allIn,
      bet: player.bet,
      said: player.said,
      cards: !player.inHand || (player.folded && seat !== viewer) ? [] : player.cards.map((card) => (shown(seat) ? { ...card } : null)),
    })),
  };
}

/** No event carries a card, so there is nothing to hide. */
export function eventFor(event) {
  return event;
}
