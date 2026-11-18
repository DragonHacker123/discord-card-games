// The rules of Solitaire (Klondike), played as a race. Pure and JSON-safe.
//
// Everyone gets the same deal and plays their own board at the same time.
// Build the four suits up from ace to king on the foundations. On the columns,
// cards go down in turn, red on black and black on red; only a king goes on an
// empty column. The draw pile turns one card at a time and can be gone through
// as often as you like. Whoever has the most cards on their foundations when
// the time runs out wins, and finishing the whole deck ends the game at once.
//
// applyAction() never throws and a refused move leaves the state as it was.

import { SUITS, buildDeck, isIndex, lowValue, roller, shuffle } from '../shared/cards.js';

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 6;
export const MINUTES = [5, 10, 15];
export const DEFAULT_RULES = Object.freeze({ minutes: 10 });
export const normaliseRules = (input) => ({ minutes: MINUTES.includes(input?.minutes) ? input.minutes : DEFAULT_RULES.minutes });

const isRed = (suit) => suit === 'H' || suit === 'D';
export const placed = (board) => SUITS.reduce((sum, suit) => sum + board.foundations[suit], 0);

function layOut(deck) {
  const cards = deck.map((card) => ({ ...card }));
  const tableau = [];
  for (let col = 0; col < 7; col++) {
    const pile = cards.splice(0, col + 1).map((card) => ({ ...card, up: false }));
    pile.at(-1).up = true;
    tableau.push(pile);
  }
  return { stock: cards, waste: [], foundations: { S: 0, H: 0, D: 0, C: 0 }, tableau };
}

export function createGame({ players, seed = Date.now(), rules, random = null }) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`Solitaire takes ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }
  const state = { version: ENGINE_VERSION, rng: seed | 0, rules: normaliseRules(rules), phase: 'play', players: [], results: null };
  const deck = shuffle(buildDeck(), roller(state, random));
  state.players = players.map(({ id, name }) => ({ id, name, out: false, done: false, moves: 0, board: layOut(deck) }));
  return state;
}

const canFound = (board, card) => lowValue(card) === board.foundations[card.suit] + 1;

function canStack(board, card, col) {
  const pile = board.tableau[col];
  if (!pile.length) return card.rank === 'K';
  const top = pile.at(-1);
  return top.up && isRed(top.suit) !== isRed(card.suit) && lowValue(top) === lowValue(card) + 1;
}

/** The cards a tap would pick up: the top of the waste, or a face-up card in a column and everything on it. */
function lifted(board, source) {
  if (source?.pile === 'waste') return board.waste.length ? [board.waste.at(-1)] : null;
  if (source?.pile !== 'tableau' || !isIndex(source.col, 7)) return null;
  const pile = board.tableau[source.col];
  if (!isIndex(source.index, pile.length) || !pile[source.index].up) return null;
  return pile.slice(source.index);
}

/**
 * Where a tap sends a card: { to: 'foundation' }, { to: 'tableau', col } or null.
 * A single card goes to its foundation if it can; otherwise the cards go to the
 * first column that takes them, preferring one with cards to an empty one.
 * Works on a player's view of their board as well as on the real thing.
 */
export function destination(board, source) {
  const cards = lifted(board, source);
  if (!cards) return null;
  if (cards.length === 1 && canFound(board, cards[0])) return { to: 'foundation' };
  let empty = -1;
  for (let col = 0; col < 7; col++) {
    if (source.pile === 'tableau' && col === source.col) continue;
    if (!canStack(board, cards[0], col)) continue;
    if (board.tableau[col].length) return { to: 'tableau', col };
    if (empty === -1) empty = col;
  }
  // A king already at the bottom of its column gains nothing by moving to another empty one.
  if (empty !== -1 && !(source.pile === 'tableau' && source.index === 0)) return { to: 'tableau', col: empty };
  return null;
}

function finish(state, events) {
  const staying = state.players.filter((player) => !player.out);
  const best = Math.max(0, ...staying.map((player) => placed(player.board)));
  const winners = best === 0 ? [] : state.players.map((player, seat) => (!player.out && placed(player.board) === best ? seat : -1)).filter((seat) => seat !== -1);
  const rows = state.players.map((player, seat) => ({ seat, name: player.name, placed: placed(player.board), moves: player.moves, out: player.out }));
  state.phase = 'finished';
  state.results = { winners, rows: rows.sort((a, b) => Number(a.out) - Number(b.out) || b.placed - a.placed || a.moves - b.moves || a.seat - b.seat) };
  events.push({ type: 'finished', results: state.results });
}

const allDone = (state) => state.players.every((player) => player.out || player.done);

const MOVES = {
  draw(state, seat) {
    const { board } = state.players[seat];
    if (board.stock.length) board.waste.push(board.stock.pop());
    else if (board.waste.length) {
      board.stock = board.waste.reverse();
      board.waste = [];
    } else return 'There are no cards left to draw.';
    return null;
  },
  tap(state, seat, action) {
    const { board } = state.players[seat];
    const source = { pile: action.pile, col: action.col, index: action.index };
    const target = destination(board, source);
    if (!target) return lifted(board, source) ? 'That card has nowhere to go.' : 'Pick a face-up card.';
    let cards;
    if (source.pile === 'waste') cards = [board.waste.pop()];
    else {
      const pile = board.tableau[source.col];
      cards = pile.splice(source.index);
      if (pile.length) pile.at(-1).up = true;
    }
    if (target.to === 'foundation') board.foundations[cards[0].suit] += 1;
    else board.tableau[target.col].push(...cards.map((card) => ({ rank: card.rank, suit: card.suit, up: true })));
    return null;
  },
  giveUp(state, seat) {
    state.players[seat].done = true;
    return null;
  },
};

export function legalActions(state, seat) {
  if (state.phase !== 'play' || !isIndex(seat, state.players.length)) return [];
  const player = state.players[seat];
  return player.out || player.done ? [] : ['tap', 'draw', 'giveUp'];
}

/** Returns { ok: true, events } or { ok: false, error }. Never throws. */
export function applyAction(state, seat, action) {
  try {
    if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string' || !Object.hasOwn(MOVES, action.type)) {
      return { ok: false, error: 'Unknown move.' };
    }
    if (state.phase !== 'play') return { ok: false, error: 'The game is over.' };
    const player = state.players[seat];
    if (player.out) return { ok: false, error: 'You’ve left this game.' };
    if (player.done) return { ok: false, error: 'You’ve stopped playing this deal.' };
    const refusal = MOVES[action.type](state, seat, action);
    if (refusal) return { ok: false, error: refusal };
    const events = [{ type: action.type === 'giveUp' ? 'stopped' : 'moved', seat }];
    if (action.type !== 'giveUp') player.moves += 1;
    if (placed(player.board) === 52) {
      player.done = true;
      finish(state, events);
    } else if (allDone(state)) finish(state, events);
    return { ok: true, events };
  } catch (error) {
    return { ok: false, error: 'Something went wrong with that move.', bug: String(error?.stack ?? error) };
  }
}

/** A player has left for good. */
export function forfeit(state, seat) {
  if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
  const player = state.players[seat];
  if (state.phase !== 'play' || player.out) return { ok: false, error: 'Nothing to do.' };
  player.out = true;
  const events = [{ type: 'left', seat }];
  if (allDone(state)) finish(state, events);
  return { ok: true, events };
}

/** The clock has run out. */
export function timeUp(state) {
  if (state.phase !== 'play') return { ok: false, error: 'Nothing to do.' };
  const events = [{ type: 'timeUp' }];
  finish(state, events);
  return { ok: true, events };
}

export const actors = (state) => (state.phase === 'play' ? state.players.map((player, seat) => (player.out || player.done ? -1 : seat)).filter((seat) => seat !== -1) : []);

/** What one seat may know: their own board with its face-down cards hidden, and how far everyone has got. */
export function viewFor(state, viewer) {
  const me = state.players[viewer];
  return {
    game: 'solitaire',
    you: viewer,
    phase: state.phase,
    rules: state.rules,
    legal: legalActions(state, viewer),
    board: me
      ? {
          stockCount: me.board.stock.length,
          waste: me.board.waste.slice(-1).map((card) => ({ rank: card.rank, suit: card.suit })),
          wasteCount: me.board.waste.length,
          foundations: { ...me.board.foundations },
          tableau: me.board.tableau.map((pile) => pile.map((card) => (card.up ? { rank: card.rank, suit: card.suit, up: true } : { up: false }))),
        }
      : null,
    results: state.results,
    players: state.players.map((player) => ({ id: player.id, name: player.name, out: player.out, done: player.done, placed: placed(player.board) })),
  };
}

/** Nobody is told what another player moved, only that they did. */
export const eventFor = (event) => event;
