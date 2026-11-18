// The rules of Crazy Eights. Pure and JSON-safe.
//
// On your turn you play a card that matches the top of the discard pile by suit
// or by rank. An eight goes on anything and lets you name the suit. If you
// can't or won't play, you draw one card and may then play or pass. The first
// player to empty their hand wins.
//
// applyAction() never throws and a refused move leaves the state as it was.

import { SUITS, buildDeck, isIndex, lowValue, roller, shuffle, sortHand } from '../shared/cards.js';

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const DEFAULT_RULES = Object.freeze({});
export const normaliseRules = () => ({});
export const startCards = (playerCount) => (playerCount === 2 ? 7 : 5);

/** What a card left in your hand costs you: eights 50, picture cards and tens 10, aces 1, the rest their number. */
export const cardPoints = (card) => (card.rank === '8' ? 50 : lowValue(card) >= 10 ? 10 : lowValue(card));
const sorted = (hand) => sortHand(hand, lowValue);

export function createGame({ players, seed = Date.now(), random = null }) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`Crazy Eights needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }
  const state = {
    version: ENGINE_VERSION,
    rng: seed | 0,
    rules: {},
    phase: 'play',
    players: players.map(({ id, name }) => ({ id, name, hand: [], out: false })),
    stock: [],
    discard: [],
    suit: null, // the suit that has to be followed; differs from the top card after an eight
    turn: 0,
    drew: false,
    passes: 0,
    results: null,
  };
  const roll = roller(state, random);
  const deck = shuffle(buildDeck(), roll);
  for (let round = 0; round < startCards(players.length); round++) for (const player of state.players) player.hand.push(deck.pop());
  for (const player of state.players) sorted(player.hand);
  // The first card turned over can't be an eight.
  let first = deck.findLastIndex((card) => card.rank !== '8');
  state.discard.push(deck.splice(first, 1)[0]);
  state.stock = deck;
  state.suit = state.discard[0].suit;
  state.turn = Math.floor(roll() * players.length);
  return state;
}

const top = (state) => state.discard.at(-1);
export const canPlay = (state, card) => card.rank === '8' || card.suit === state.suit || card.rank === top(state).rank;
/** Cards that can still be drawn, counting the discard pile that would be turned over. */
const drawable = (state) => state.stock.length + Math.max(0, state.discard.length - 1);

function nextTurn(state, events) {
  const count = state.players.length;
  for (let step = 1; step <= count; step++) {
    const seat = (state.turn + step) % count;
    if (!state.players[seat].out) {
      state.turn = seat;
      break;
    }
  }
  state.drew = false;
  events.push({ type: 'turn', seat: state.turn });
}

function finish(state, events) {
  const staying = state.players.map((player, seat) => ({ player, seat })).filter(({ player }) => !player.out);
  const points = (player) => player.hand.reduce((sum, card) => sum + cardPoints(card), 0);
  const emptied = staying.filter(({ player }) => player.hand.length === 0);
  // Nobody out means the game was blocked: the fewest points left wins.
  const best = Math.min(...staying.map(({ player }) => points(player)));
  const winners = (emptied.length ? emptied : staying.filter(({ player }) => points(player) === best)).map(({ seat }) => seat);
  const rows = state.players.map((player, seat) => ({ seat, name: player.name, cards: player.hand.length, points: points(player), out: player.out }));
  state.phase = 'finished';
  state.results = { winners, rows: rows.sort((a, b) => Number(a.out) - Number(b.out) || a.points - b.points || a.seat - b.seat) };
  events.push({ type: 'finished', results: state.results });
}

const MOVES = {
  play(state, seat, action, events) {
    const player = state.players[seat];
    if (!isIndex(action.card, player.hand.length)) return 'Pick one of your cards.';
    const card = player.hand[action.card];
    if (!canPlay(state, card)) return 'That card doesn’t match.';
    if (card.rank === '8' && !SUITS.includes(action.suit)) return 'Pick a suit for the eight.';
    player.hand.splice(action.card, 1);
    state.discard.push(card);
    state.suit = card.rank === '8' ? action.suit : card.suit;
    state.passes = 0;
    events.push({ type: 'played', seat, card, suit: state.suit });
    if (player.hand.length === 0) finish(state, events);
    else nextTurn(state, events);
    return null;
  },
  draw(state, seat, _action, events, roll) {
    if (state.drew) return 'You’ve already drawn this turn.';
    if (drawable(state) === 0) return 'There are no cards to draw.';
    if (state.stock.length === 0) {
      // Turn the discard pile over, keeping its top card.
      const keep = state.discard.pop();
      state.stock = shuffle(state.discard, roll);
      state.discard = [keep];
      events.push({ type: 'reshuffled' });
    }
    const card = state.stock.pop();
    state.players[seat].hand.push(card);
    sorted(state.players[seat].hand);
    state.drew = true;
    events.push({ type: 'drew', seat, card });
    return null;
  },
  pass(state, _seat, _action, events) {
    if (!state.drew && drawable(state) > 0) return 'Draw a card first.';
    state.passes += 1;
    events.push({ type: 'passed', seat: state.turn });
    // Everyone has passed with nothing left to draw: the game is blocked.
    if (drawable(state) === 0 && state.passes >= state.players.filter((player) => !player.out).length) finish(state, events);
    else nextTurn(state, events);
    return null;
  },
};

export function legalActions(state, seat) {
  if (state.phase !== 'play' || !isIndex(seat, state.players.length) || state.turn !== seat || state.players[seat].out) return [];
  const legal = [];
  if (state.players[seat].hand.some((card) => canPlay(state, card))) legal.push('play');
  if (!state.drew && drawable(state) > 0) legal.push('draw');
  else legal.push('pass');
  return legal;
}

/** Returns { ok: true, events } or { ok: false, error }. Never throws. */
export function applyAction(state, seat, action, options = {}) {
  try {
    if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string' || !Object.hasOwn(MOVES, action.type)) {
      return { ok: false, error: 'Unknown move.' };
    }
    if (state.phase !== 'play') return { ok: false, error: 'The game is over.' };
    if (state.players[seat].out) return { ok: false, error: 'You’ve left this game.' };
    if (state.turn !== seat) return { ok: false, error: 'It isn’t your turn.' };
    const events = [];
    const refusal = MOVES[action.type](state, seat, action, events, roller(state, options.random));
    return refusal ? { ok: false, error: refusal } : { ok: true, events };
  } catch (error) {
    return { ok: false, error: 'Something went wrong with that move.', bug: String(error?.stack ?? error) };
  }
}

/** A player has left for good. Their cards go to the bottom of the draw pile. */
export function forfeit(state, seat) {
  if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
  const player = state.players[seat];
  if (state.phase !== 'play' || player.out) return { ok: false, error: 'Nothing to do.' };
  const events = [{ type: 'left', seat }];
  state.stock.unshift(...player.hand);
  player.hand = [];
  player.out = true;
  if (state.players.filter((other) => !other.out).length < 2) finish(state, events);
  else if (state.turn === seat) nextTurn(state, events);
  return { ok: true, events };
}

export const actors = (state) => (state.phase === 'play' ? [state.turn] : []);
export const pause = () => 0;
export const step = () => ({ ok: false, error: 'Nothing to do.' });

/** A move that is always accepted for the player whose turn it is. */
export function anyLegal(state, seat) {
  const hand = state.players[seat].hand;
  const card = hand.findIndex((entry) => canPlay(state, entry));
  if (card !== -1) return { type: 'play', card, suit: hand[card].suit };
  return { type: !state.drew && drawable(state) > 0 ? 'draw' : 'pass' };
}

/** What one seat may know: their own hand, and how many cards everyone else holds. */
export function viewFor(state, viewer) {
  const mine = state.players[viewer]?.hand ?? [];
  const myTurn = state.phase === 'play' && state.turn === viewer;
  return {
    game: 'crazy8',
    you: viewer,
    phase: state.phase,
    turn: state.turn,
    top: { ...top(state) },
    suit: state.suit,
    stockCount: drawable(state),
    drew: myTurn && state.drew,
    legal: legalActions(state, viewer),
    playable: myTurn ? mine.map((card, index) => (canPlay(state, card) ? index : -1)).filter((index) => index !== -1) : [],
    rules: state.rules,
    results: state.results,
    players: state.players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      count: player.hand.length,
      out: player.out,
      hand: seat === viewer || state.phase === 'finished' ? player.hand.map((card) => ({ ...card })) : null,
    })),
  };
}

/** Only the player who drew a card sees what it was. */
export function eventFor(event, viewer) {
  return event.type === 'drew' && event.seat !== viewer ? { ...event, card: null } : event;
}
