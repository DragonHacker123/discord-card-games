// The rules of Hearts. Pure and JSON-safe.
//
// Four players. Each round everyone passes three cards (left, then right, then
// across, then no pass), and the 2 of clubs leads. You must follow suit. Every
// heart you take costs a point and the queen of spades costs 13; take all 26
// and everyone else gets them instead. The game ends when someone reaches the
// target, and the lowest score wins.
//
// applyAction() never throws and a refused move leaves the state as it was.

import { buildDeck, isIndex, roller, shuffle, sortHand } from '../shared/cards.js';
import { following, trickWinner } from '../shared/tricks.js';

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 4;
export const TARGETS = [50, 100];
export const DEFAULT_RULES = Object.freeze({ target: 50 });
export const normaliseRules = (input) => ({ target: TARGETS.includes(input?.target) ? input.target : DEFAULT_RULES.target });

const PASSES = ['left', 'right', 'across', 'none'];
const OFFSET = { left: 1, right: 3, across: 2 };
export const isQueen = (card) => card.rank === 'Q' && card.suit === 'S';
export const pointsOf = (card) => (card.suit === 'H' ? 1 : isQueen(card) ? 13 : 0);

function startPlay(state) {
  state.phase = 'play';
  state.turn = state.players.findIndex((player) => player.hand.some((card) => card.rank === '2' && card.suit === 'C'));
}

function deal(state, roll) {
  const deck = shuffle(buildDeck(), roll);
  state.players.forEach((player, seat) => {
    player.hand = sortHand(deck.slice(seat * 13, seat * 13 + 13));
    player.roundPoints = 0;
    player.passing = null;
    player.received = [];
  });
  state.round += 1;
  state.passDir = PASSES[(state.round - 1) % 4];
  state.trick = [];
  state.trickWinner = null;
  state.tricksPlayed = 0;
  state.heartsBroken = false;
  state.summary = null;
  state.moon = null;
  if (state.passDir === 'none') startPlay(state);
  else {
    state.phase = 'pass';
    state.turn = null;
  }
}

export function createGame({ players, seed = Date.now(), rules, random = null }) {
  if (!Array.isArray(players) || players.length !== 4) throw new Error('Hearts needs exactly 4 players.');
  const state = {
    version: ENGINE_VERSION,
    rng: seed | 0,
    rules: normaliseRules(rules),
    phase: 'pass',
    round: 0,
    passDir: 'left',
    players: players.map(({ id, name }) => ({ id, name, hand: [], out: false, score: 0, roundPoints: 0, passing: null, received: [] })),
    trick: [],
    trickWinner: null,
    tricksPlayed: 0,
    heartsBroken: false,
    turn: null,
    summary: null,
    moon: null,
    results: null,
  };
  deal(state, roller(state, random));
  return state;
}

/** The cards a seat may play now, by position in their hand. */
export function playable(state, seat) {
  const hand = state.players[seat].hand;
  const all = hand.map((_card, index) => index);
  const first = state.tricksPlayed === 0;
  if (!state.trick.length) {
    if (first) return all.filter((index) => hand[index].rank === '2' && hand[index].suit === 'C');
    if (state.heartsBroken) return all;
    const plain = all.filter((index) => hand[index].suit !== 'H');
    return plain.length ? plain : all;
  }
  let options = following(hand, state.trick[0].card.suit);
  if (first) {
    // No points on the first trick, unless points are all you have.
    const safe = options.filter((index) => pointsOf(hand[index]) === 0);
    if (safe.length) options = safe;
  }
  return options;
}

function finish(state, events) {
  const staying = state.players.filter((player) => !player.out);
  const pool = staying.length ? staying : state.players;
  const best = Math.min(...pool.map((player) => player.score));
  const winners = state.players.map((player, seat) => (pool.includes(player) && player.score === best ? seat : -1)).filter((seat) => seat !== -1);
  const rows = state.players.map((player, seat) => ({ seat, name: player.name, score: player.score, out: player.out }));
  state.phase = 'finished';
  state.turn = null;
  state.results = { winners, rows: rows.sort((a, b) => Number(a.out) - Number(b.out) || a.score - b.score || a.seat - b.seat) };
  events.push({ type: 'finished', results: state.results });
}

function endRound(state, events) {
  const moon = state.players.findIndex((player) => player.roundPoints === 26);
  state.moon = moon === -1 ? null : moon;
  state.summary = state.players.map((player, seat) => {
    const points = moon === -1 ? player.roundPoints : seat === moon ? 0 : 26;
    player.score += points;
    return { seat, points };
  });
  events.push({ type: 'round', summary: state.summary, moon: state.moon });
  if (state.players.some((player) => player.score >= state.rules.target)) finish(state, events);
  else {
    state.phase = 'roundEnd';
    state.turn = null;
  }
}

const MOVES = {
  pass(state, seat, action, events) {
    if (state.phase !== 'pass') return 'There’s no passing now.';
    const player = state.players[seat];
    if (player.passing) return 'You’ve already passed.';
    const picks = action.cards;
    if (!Array.isArray(picks) || picks.length !== 3 || new Set(picks).size !== 3 || !picks.every((index) => isIndex(index, player.hand.length))) return 'Pick three cards to pass.';
    player.passing = picks.map((index) => ({ ...player.hand[index] }));
    events.push({ type: 'chose', seat });
    if (state.players.every((other) => other.passing)) {
      const offset = OFFSET[state.passDir];
      const gifts = state.players.map((other) => other.passing);
      for (const other of state.players) {
        other.hand = other.hand.filter((card) => !other.passing.some((gone) => gone.rank === card.rank && gone.suit === card.suit));
      }
      state.players.forEach((other, from) => {
        const to = state.players[(from + offset) % 4];
        to.hand.push(...gifts[from]);
        to.received = gifts[from];
        other.passing = null;
      });
      for (const other of state.players) sortHand(other.hand);
      events.push({ type: 'passed', dir: state.passDir });
      startPlay(state);
    }
    return null;
  },
  play(state, seat, action, events) {
    if (state.phase !== 'play') return 'Wait for the next trick.';
    if (state.turn !== seat) return 'It isn’t your turn.';
    const hand = state.players[seat].hand;
    if (!isIndex(action.card, hand.length)) return 'Pick one of your cards.';
    if (!playable(state, seat).includes(action.card)) {
      if (state.tricksPlayed === 0 && !state.trick.length) return 'The 2 of clubs leads.';
      if (!state.trick.length) return 'Hearts haven’t been broken yet.';
      if (hand.some((card) => card.suit === state.trick[0].card.suit)) return 'You have to follow suit.';
      return 'No points on the first trick.';
    }
    const [card] = hand.splice(action.card, 1);
    state.trick.push({ seat, card });
    if (card.suit === 'H') state.heartsBroken = true;
    events.push({ type: 'played', seat, card });
    if (state.trick.length === 4) {
      state.phase = 'trickEnd';
      state.trickWinner = state.trick[trickWinner(state.trick)].seat;
      state.turn = null;
    } else state.turn = (seat + 1) % 4;
    return null;
  },
};

export function legalActions(state, seat) {
  if (!isIndex(seat, state.players.length)) return [];
  if (state.phase === 'pass') return state.players[seat].passing ? [] : ['pass'];
  if (state.phase === 'play' && state.turn === seat) return ['play'];
  return [];
}

/** Returns { ok: true, events } or { ok: false, error }. Never throws. */
export function applyAction(state, seat, action) {
  try {
    if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string' || !Object.hasOwn(MOVES, action.type)) {
      return { ok: false, error: 'Unknown move.' };
    }
    if (state.phase === 'finished') return { ok: false, error: 'The game is over.' };
    const events = [];
    const refusal = MOVES[action.type](state, seat, action, events);
    return refusal ? { ok: false, error: refusal } : { ok: true, events };
  } catch (error) {
    return { ok: false, error: 'Something went wrong with that move.', bug: String(error?.stack ?? error) };
  }
}

/** A player has left for good. The computer plays their seat out, and they can't win. */
export function forfeit(state, seat) {
  if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
  if (state.phase === 'finished' || state.players[seat].out) return { ok: false, error: 'Nothing to do.' };
  state.players[seat].out = true;
  return { ok: true, events: [{ type: 'left', seat }] };
}

export function actors(state) {
  if (state.phase === 'pass') return state.players.map((player, seat) => (player.passing ? -1 : seat)).filter((seat) => seat !== -1);
  return state.phase === 'play' ? [state.turn] : [];
}

export const pause = (state) => (state.phase === 'trickEnd' ? 1500 : state.phase === 'roundEnd' ? 6000 : 0);

/** Moves on after a pause: gathers a finished trick, or deals the next round. */
export function step(state, options = {}) {
  const events = [];
  if (state.phase === 'trickEnd') {
    const winner = state.trickWinner;
    const points = state.trick.reduce((sum, play) => sum + pointsOf(play.card), 0);
    state.players[winner].roundPoints += points;
    state.tricksPlayed += 1;
    state.trick = [];
    state.trickWinner = null;
    for (const player of state.players) player.received = [];
    events.push({ type: 'trick', winner, points });
    if (state.tricksPlayed === 13) endRound(state, events);
    else {
      state.phase = 'play';
      state.turn = winner;
    }
    return { ok: true, events };
  }
  if (state.phase === 'roundEnd') {
    deal(state, roller(state, options.random));
    events.push({ type: 'dealt', round: state.round });
    return { ok: true, events };
  }
  return { ok: false, error: 'Nothing to do.' };
}

/** A move that is always accepted for a seat that has to act. */
export function anyLegal(state, seat) {
  if (state.phase === 'pass') return { type: 'pass', cards: [0, 1, 2] };
  return { type: 'play', card: playable(state, seat)[0] };
}

/** What one seat may know: their own hand and the cards on the table. */
export function viewFor(state, viewer) {
  const me = state.players[viewer];
  const legal = legalActions(state, viewer);
  return {
    game: 'hearts',
    you: viewer,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    passDir: state.passDir,
    passTo: me && state.passDir !== 'none' ? (viewer + OFFSET[state.passDir]) % 4 : null,
    passing: me?.passing ? me.passing.map((card) => ({ ...card })) : null,
    received: me ? me.received.map((card) => ({ ...card })) : [],
    waiting: state.phase === 'pass' ? actors(state) : [],
    trick: state.trick.map((play) => ({ seat: play.seat, card: { ...play.card } })),
    trickWinner: state.trickWinner,
    heartsBroken: state.heartsBroken,
    legal,
    playable: legal.includes('play') ? playable(state, viewer) : [],
    rules: state.rules,
    summary: state.summary,
    moon: state.moon,
    results: state.results,
    players: state.players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      out: player.out,
      count: player.hand.length,
      score: player.score,
      roundPoints: player.roundPoints,
      hand: seat === viewer ? player.hand.map((card) => ({ ...card })) : null,
    })),
  };
}

export const eventFor = (event) => event;
