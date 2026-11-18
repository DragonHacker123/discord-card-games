// The rules of Rummy (the basic game). Pure and JSON-safe.
//
// On your turn you take the top card of the draw pile or of the discard pile.
// You may then lay down melds (three or four cards of one rank, or three or
// more cards in sequence in one suit, ace low), add cards to melds already on
// the table, and finish by discarding one card. The first player to get rid of
// every card wins.
//
// applyAction() never throws and a refused move leaves the state as it was.

import { SUITS, buildDeck, isIndex, lowValue, roller, sameCard, shuffle, sortHand } from '../shared/cards.js';

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const DEFAULT_RULES = Object.freeze({});
export const normaliseRules = () => ({});
export const startCards = (playerCount) => (playerCount === 2 ? 10 : playerCount <= 4 ? 7 : 6);
/** How often the discard pile is turned over to make a new draw pile before the game is called off. */
export const RECYCLES = 2;

/** What a card left in your hand costs: picture cards 10, aces 1, the rest their number. */
export const cardPoints = (card) => Math.min(10, lowValue(card));
const sorted = (hand) => sortHand(hand, lowValue);

/** 'set' (one rank), 'run' (one suit, in sequence, ace low) or null for a group of cards. */
export function meldKind(cards) {
  if (!Array.isArray(cards) || cards.length < 3) return null;
  if (cards.every((card) => card.rank === cards[0].rank)) return cards.length <= 4 ? 'set' : null;
  if (!cards.every((card) => card.suit === cards[0].suit)) return null;
  const values = cards.map(lowValue).sort((a, b) => a - b);
  return values.every((value, index) => index === 0 || value === values[index - 1] + 1) ? 'run' : null;
}

const tidy = (cards, kind) => (kind === 'run' ? cards.sort((a, b) => lowValue(a) - lowValue(b)) : cards.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit)));

export function createGame({ players, seed = Date.now(), random = null }) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`Rummy needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }
  const state = {
    version: ENGINE_VERSION,
    rng: seed | 0,
    rules: {},
    phase: 'play',
    players: players.map(({ id, name }) => ({ id, name, hand: [], out: false })),
    stock: [],
    discard: [],
    melds: [],
    turn: 0,
    stage: 'draw', // 'draw', then 'play' until the discard
    taken: null, // the card just picked up from the discard pile, which can't go straight back
    recycles: 0,
    results: null,
  };
  const roll = roller(state, random);
  const deck = shuffle(buildDeck(), roll);
  for (let round = 0; round < startCards(players.length); round++) for (const player of state.players) player.hand.push(deck.pop());
  for (const player of state.players) sorted(player.hand);
  state.discard.push(deck.pop());
  state.stock = deck;
  state.turn = Math.floor(roll() * players.length);
  return state;
}

function finish(state, events, winner = null) {
  const points = (player) => player.hand.reduce((sum, card) => sum + cardPoints(card), 0);
  const staying = state.players.map((player, seat) => ({ player, seat })).filter(({ player }) => !player.out);
  // Nobody out means the cards ran dry: the fewest points left in hand wins.
  const best = Math.min(...staying.map(({ player }) => points(player)));
  const winners = winner !== null ? [winner] : staying.filter(({ player }) => points(player) === best).map(({ seat }) => seat);
  const rows = state.players.map((player, seat) => ({ seat, name: player.name, cards: player.hand.length, points: points(player), out: player.out }));
  state.phase = 'finished';
  state.results = { winners, rows: rows.sort((a, b) => Number(a.out) - Number(b.out) || Number(winners.includes(b.seat)) - Number(winners.includes(a.seat)) || a.points - b.points || a.seat - b.seat) };
  events.push({ type: 'finished', results: state.results });
}

function nextTurn(state, events, roll) {
  state.taken = null;
  state.stage = 'draw';
  if (state.stock.length === 0) {
    if (state.recycles >= RECYCLES || state.discard.length < 2) {
      finish(state, events);
      return;
    }
    const keep = state.discard.pop();
    state.stock = shuffle(state.discard, roll);
    state.discard = [keep];
    state.recycles += 1;
    events.push({ type: 'reshuffled' });
  }
  const count = state.players.length;
  for (let step = 1; step <= count; step++) {
    const seat = (state.turn + step) % count;
    if (!state.players[seat].out) {
      state.turn = seat;
      break;
    }
  }
  events.push({ type: 'turn', seat: state.turn });
}

const MOVES = {
  draw(state, seat, action, events) {
    if (state.stage !== 'draw') return 'You’ve already taken a card.';
    if (action.from !== 'stock' && action.from !== 'discard') return 'Take a card from one of the piles.';
    const pile = action.from === 'stock' ? state.stock : state.discard;
    if (!pile.length) return 'That pile is empty.';
    const card = pile.pop();
    state.players[seat].hand.push(card);
    sorted(state.players[seat].hand);
    state.taken = action.from === 'discard' ? card : null;
    state.stage = 'play';
    events.push({ type: 'drew', seat, from: action.from, card });
    return null;
  },
  meld(state, seat, action, events) {
    if (state.stage !== 'play') return 'Take a card first.';
    const hand = state.players[seat].hand;
    const picks = action.cards;
    if (!Array.isArray(picks) || picks.length < 3 || picks.length > 13 || new Set(picks).size !== picks.length || !picks.every((index) => isIndex(index, hand.length))) return 'Pick three or more of your cards.';
    const cards = picks.map((index) => hand[index]);
    const kind = meldKind(cards);
    if (!kind) return 'Those cards don’t make a set or a run.';
    state.players[seat].hand = hand.filter((_card, index) => !picks.includes(index));
    state.melds.push({ kind, cards: tidy(cards, kind) });
    events.push({ type: 'melded', seat, meld: state.melds.length - 1 });
    if (state.players[seat].hand.length === 0) finish(state, events, seat);
    return null;
  },
  layoff(state, seat, action, events) {
    if (state.stage !== 'play') return 'Take a card first.';
    const hand = state.players[seat].hand;
    if (!isIndex(action.card, hand.length)) return 'Pick one of your cards.';
    if (!isIndex(action.meld, state.melds.length)) return 'Pick a set or run on the table.';
    const meld = state.melds[action.meld];
    const cards = [...meld.cards, hand[action.card]];
    const kind = meldKind(cards);
    if (!kind) return 'That card doesn’t fit there.';
    hand.splice(action.card, 1);
    meld.kind = kind;
    meld.cards = tidy(cards, kind);
    events.push({ type: 'laidOff', seat, meld: action.meld });
    if (hand.length === 0) finish(state, events, seat);
    return null;
  },
  discard(state, seat, action, events, roll) {
    if (state.stage !== 'play') return 'Take a card first.';
    const hand = state.players[seat].hand;
    if (!isIndex(action.card, hand.length)) return 'Pick one of your cards.';
    if (state.taken && hand.length > 1 && sameCard(hand[action.card], state.taken)) return 'You can’t discard the card you just picked up.';
    const [card] = hand.splice(action.card, 1);
    state.discard.push(card);
    events.push({ type: 'discarded', seat, card });
    if (hand.length === 0) finish(state, events, seat);
    else nextTurn(state, events, roll);
    return null;
  },
};

export function legalActions(state, seat) {
  if (state.phase !== 'play' || !isIndex(seat, state.players.length) || state.turn !== seat || state.players[seat].out) return [];
  return state.stage === 'draw' ? ['draw'] : ['meld', 'layoff', 'discard'];
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
export function forfeit(state, seat, options = {}) {
  if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
  const player = state.players[seat];
  if (state.phase !== 'play' || player.out) return { ok: false, error: 'Nothing to do.' };
  const events = [{ type: 'left', seat }];
  state.stock.unshift(...player.hand);
  player.hand = [];
  player.out = true;
  if (state.players.filter((other) => !other.out).length < 2) finish(state, events);
  else if (state.turn === seat) nextTurn(state, events, roller(state, options.random));
  return { ok: true, events };
}

export const actors = (state) => (state.phase === 'play' ? [state.turn] : []);
export const pause = () => 0;
export const step = () => ({ ok: false, error: 'Nothing to do.' });

/** A move that is always accepted for the player whose turn it is. */
export function anyLegal(state, seat) {
  if (state.stage === 'draw') return { type: 'draw', from: state.stock.length ? 'stock' : 'discard' };
  const hand = state.players[seat].hand;
  const card = hand.findIndex((entry) => !state.taken || !sameCard(entry, state.taken));
  return { type: 'discard', card: Math.max(0, card) };
}

/** What one seat may know: their own hand, the melds, and how many cards everyone else holds. */
export function viewFor(state, viewer) {
  const mine = state.phase === 'play' && state.turn === viewer;
  return {
    game: 'rummy',
    you: viewer,
    phase: state.phase,
    turn: state.turn,
    stage: state.stage,
    top: state.discard.length ? { ...state.discard.at(-1) } : null,
    stockCount: state.stock.length,
    melds: state.melds.map((meld) => ({ kind: meld.kind, cards: meld.cards.map((card) => ({ ...card })) })),
    legal: legalActions(state, viewer),
    taken: mine && state.taken && state.players[viewer].hand.length > 1 ? { ...state.taken } : null,
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

/** A card taken from the draw pile is seen only by the player who took it. */
export function eventFor(event, viewer) {
  return event.type === 'drew' && event.from === 'stock' && event.seat !== viewer ? { ...event, card: null } : event;
}
