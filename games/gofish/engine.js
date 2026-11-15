// The rules of Go Fish. Pure and JSON-safe: the whole game is one plain object,
// and every change goes through applyAction() or forfeit().
//
// On your turn you ask one other player for a rank you hold. If they have any,
// they hand them all over and you ask again. If not, you "go fish": you draw a
// card, and if it's the rank you asked for you show it and ask again. Four of a
// rank is a book, laid down at once. Most books wins.
//
// The engine takes moves from the network, so applyAction() never throws and a
// refused move leaves the state exactly as it was.

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const DEFAULT_RULES = Object.freeze({});

/** Go Fish has no settings yet. Anything given comes out as the one rule set. */
export function normaliseRules() {
  return {};
}

/** Seven cards each for two or three players, five each for more. */
export const startCards = (playerCount) => (playerCount <= 3 ? 7 : 5);

export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  return deck;
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
const rankOrder = (rank) => RANKS.indexOf(rank);

function sortHand(hand) {
  hand.sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank) || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
}

export function createGame({ players, seed = Date.now(), random = null }) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`Go Fish needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }
  const state = {
    version: ENGINE_VERSION,
    rng: seed | 0,
    rules: {},
    phase: 'play',
    players: players.map(({ id, name }) => ({ id, name, hand: [], books: [], out: false })),
    pile: [],
    turn: 0,
    turnCount: 0,
    last: null, // the most recent ask, for the line on the table
    results: null,
  };
  const roll = () => (random ? random() : nextRandom(state));
  const deck = buildDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(roll() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const each = startCards(players.length);
  for (let round = 0; round < each; round++) for (const player of state.players) player.hand.push(deck.pop());
  state.pile = deck;
  state.turn = Math.floor(roll() * players.length);
  for (let seat = 0; seat < state.players.length; seat++) {
    sortHand(state.players[seat].hand);
    layBooks(state, seat, []);
  }
  settle(state, []);
  return state;
}

/** Lays down every set of four in a hand. */
function layBooks(state, seat, events) {
  const player = state.players[seat];
  for (const rank of RANKS) {
    if (player.hand.filter((card) => card.rank === rank).length < 4) continue;
    player.hand = player.hand.filter((card) => card.rank !== rank);
    player.books.push(rank);
    events.push({ type: 'book', seat, rank });
  }
}

const bookCount = (state) => state.players.reduce((sum, player) => sum + player.books.length, 0);
const hasTarget = (state, seat) => state.players.some((player, index) => index !== seat && !player.out && player.hand.length > 0);

function nextSeat(state, from) {
  for (let step = 1; step <= state.players.length; step++) {
    const seat = (from + step) % state.players.length;
    if (!state.players[seat].out) return seat;
  }
  return from;
}

function passTurn(state, events) {
  state.turn = nextSeat(state, state.turn);
  state.turnCount += 1;
  events.push({ type: 'turn', seat: state.turn });
}

function computeResults(state) {
  const staying = state.players.filter((player) => !player.out);
  const best = Math.max(0, ...staying.map((player) => player.books.length));
  const rows = state.players.map((player, seat) => ({ seat, name: player.name, books: [...player.books], out: player.out }));
  return {
    winners: rows.filter((row) => !row.out && row.books.length === best).map((row) => row.seat),
    rows: [...rows].sort((a, b) => Number(a.out) - Number(b.out) || b.books.length - a.books.length || a.seat - b.seat),
  };
}

function finish(state, events) {
  state.phase = 'finished';
  state.results = computeResults(state);
  events.push({ type: 'finished', results: state.results });
}

/**
 * Brings the game to a point where the player whose turn it is can ask, or
 * ends it. A player with no cards draws one; with nobody to ask, they draw and
 * the turn moves on.
 */
function settle(state, events) {
  for (let guard = 0; guard < 400 && state.phase === 'play'; guard++) {
    const staying = state.players.filter((player) => !player.out);
    const cardsLeft = state.pile.length + staying.reduce((sum, player) => sum + player.hand.length, 0);
    if (staying.length < 2 || bookCount(state) === RANKS.length || cardsLeft === 0) return finish(state, events);
    const seat = state.turn;
    const player = state.players[seat];
    if (player.out) {
      passTurn(state, events);
      continue;
    }
    if (player.hand.length === 0) {
      if (state.pile.length === 0) {
        passTurn(state, events);
        continue;
      }
      const card = state.pile.pop();
      player.hand.push(card);
      events.push({ type: 'drew', seat, card });
      continue;
    }
    if (hasTarget(state, seat)) return undefined;
    // Cards in hand but nobody to ask.
    if (state.pile.length === 0) return finish(state, events);
    const card = state.pile.pop();
    player.hand.push(card);
    sortHand(player.hand);
    events.push({ type: 'drew', seat, card });
    layBooks(state, seat, events);
    passTurn(state, events);
  }
  if (state.phase === 'play') finish(state, events);
  return undefined;
}

function ask(state, seat, action, events) {
  const { target, rank } = action;
  if (!isIndex(target, state.players.length) || target === seat) return 'Pick another player to ask.';
  if (typeof rank !== 'string' || !RANKS.includes(rank)) return 'Pick one of your cards.';
  const asker = state.players[seat];
  const other = state.players[target];
  if (other.out) return 'They’ve left the game.';
  if (other.hand.length === 0) return 'They have no cards.';
  if (!asker.hand.some((card) => card.rank === rank)) return 'You can only ask for a rank you hold.';

  events.push({ type: 'asked', seat, target, rank });
  const given = other.hand.filter((card) => card.rank === rank);
  if (given.length > 0) {
    other.hand = other.hand.filter((card) => card.rank !== rank);
    asker.hand.push(...given);
    sortHand(asker.hand);
    state.last = { seat, target, rank, got: given.length, lucky: false };
    events.push({ type: 'gave', from: target, to: seat, rank, count: given.length });
    layBooks(state, seat, events);
    return null; // same player again
  }
  if (state.pile.length === 0) {
    state.last = { seat, target, rank, got: 0, lucky: false };
    events.push({ type: 'goFish', seat, card: null, lucky: false });
    passTurn(state, events);
    return null;
  }
  const card = state.pile.pop();
  asker.hand.push(card);
  sortHand(asker.hand);
  const lucky = card.rank === rank;
  state.last = { seat, target, rank, got: 0, lucky };
  events.push({ type: 'goFish', seat, card, lucky });
  layBooks(state, seat, events);
  if (!lucky) passTurn(state, events);
  return null;
}

export function legalActions(state, seat) {
  if (state.phase !== 'play' || !isIndex(seat, state.players.length)) return [];
  if (state.players[seat].out || state.turn !== seat) return [];
  return ['ask'];
}

/** Returns { ok: true, events } or { ok: false, error }. Never throws. */
export function applyAction(state, seat, action) {
  try {
    if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
    if (!action || typeof action !== 'object' || Array.isArray(action) || action.type !== 'ask') return { ok: false, error: 'Unknown move.' };
    if (state.phase !== 'play') return { ok: false, error: 'The game is over.' };
    if (state.players[seat].out) return { ok: false, error: 'You’ve left this game.' };
    if (state.turn !== seat) return { ok: false, error: 'It isn’t your turn.' };
    const events = [];
    const refusal = ask(state, seat, action, events);
    if (refusal) return { ok: false, error: refusal };
    settle(state, events);
    return { ok: true, events };
  } catch (error) {
    return { ok: false, error: 'Something went wrong with that move.', bug: String(error?.stack ?? error) };
  }
}

/** A player has left for good. Their cards go to the bottom of the draw pile; their books stay down but can't win. */
export function forfeit(state, seat) {
  if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
  const player = state.players[seat];
  if (state.phase !== 'play' || player.out) return { ok: false, error: 'Nothing to do.' };
  const events = [{ type: 'left', seat }];
  state.pile.unshift(...player.hand);
  player.hand = [];
  player.out = true;
  if (state.turn === seat) passTurn(state, events);
  settle(state, events);
  return { ok: true, events };
}

/** What one seat may know. A watcher (seat -1) sees no hand at all. */
export function viewFor(state, viewer) {
  return {
    game: 'gofish',
    you: viewer,
    phase: state.phase,
    turn: state.turn,
    turnCount: state.turnCount,
    pileCount: state.pile.length,
    last: state.last,
    rules: state.rules,
    legal: legalActions(state, viewer),
    results: state.results,
    players: state.players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      count: player.hand.length,
      books: [...player.books],
      out: player.out,
      hand: seat === viewer ? player.hand.map((card) => ({ ...card })) : null,
    })),
  };
}

/** Hides a drawn card from everyone but the player who drew it, unless it was shown. */
export function eventFor(event, viewer) {
  if (event.type === 'drew' && event.seat !== viewer) return { ...event, card: null };
  if (event.type === 'goFish' && event.seat !== viewer && !event.lucky) return { ...event, card: null };
  return event;
}
