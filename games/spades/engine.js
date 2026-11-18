// The rules of Spades. Pure and JSON-safe.
//
// Four players in two partnerships: seats 0 and 2 against seats 1 and 3. Each
// player bids the number of tricks they expect to take; a partnership's bids
// are added together. Spades are trumps. Make your bid and you score 10 a
// trick plus 1 for each extra (a "bag"); fall short and you lose 10 a trick.
// Ten bags cost 100. Bidding nil is a promise to take no tricks at all, worth
// 100 either way. The first partnership to the target wins.
//
// applyAction() never throws and a refused move leaves the state as it was.

import { buildDeck, isIndex, roller, shuffle, sortHand } from '../shared/cards.js';
import { following, trickWinner } from '../shared/tricks.js';

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 4;
export const TARGETS = [150, 250, 500];
export const DEFAULT_RULES = Object.freeze({ target: 250 });
export const normaliseRules = (input) => ({ target: TARGETS.includes(input?.target) ? input.target : DEFAULT_RULES.target });
export const teamOf = (seat) => seat % 2;

function deal(state, roll) {
  const deck = shuffle(buildDeck(), roll);
  state.players.forEach((player, seat) => {
    player.hand = sortHand(deck.slice(seat * 13, seat * 13 + 13));
    player.bid = null;
    player.tricks = 0;
  });
  state.round += 1;
  state.dealer = (state.dealer + 1) % 4;
  state.phase = 'bid';
  state.turn = (state.dealer + 1) % 4;
  state.trick = [];
  state.trickWinner = null;
  state.tricksPlayed = 0;
  state.spadesBroken = false;
  state.summary = null;
}

export function createGame({ players, seed = Date.now(), rules, random = null }) {
  if (!Array.isArray(players) || players.length !== 4) throw new Error('Spades needs exactly 4 players.');
  const state = {
    version: ENGINE_VERSION,
    rng: seed | 0,
    rules: normaliseRules(rules),
    phase: 'bid',
    round: 0,
    dealer: 0,
    players: players.map(({ id, name }) => ({ id, name, hand: [], out: false, bid: null, tricks: 0 })),
    teams: [
      { score: 0, bags: 0 },
      { score: 0, bags: 0 },
    ],
    trick: [],
    trickWinner: null,
    tricksPlayed: 0,
    spadesBroken: false,
    turn: 0,
    summary: null,
    results: null,
  };
  const roll = roller(state, random);
  state.dealer = Math.floor(roll() * 4);
  deal(state, roll);
  return state;
}

/** The cards a seat may play now, by position in their hand. */
export function playable(state, seat) {
  const hand = state.players[seat].hand;
  const all = hand.map((_card, index) => index);
  if (state.trick.length) return following(hand, state.trick[0].card.suit);
  if (state.spadesBroken) return all;
  const plain = all.filter((index) => hand[index].suit !== 'S');
  return plain.length ? plain : all;
}

function finish(state, events, winningTeam) {
  const seats = [0, 1, 2, 3].filter((seat) => teamOf(seat) === winningTeam);
  const staying = seats.filter((seat) => !state.players[seat].out);
  state.phase = 'finished';
  state.turn = null;
  state.results = {
    winners: staying,
    team: winningTeam,
    teams: state.teams.map((team, index) => ({ team: index, seats: [index, index + 2], score: team.score })),
  };
  events.push({ type: 'finished', results: state.results });
}

function endRound(state, events) {
  state.summary = state.teams.map((team, index) => {
    let change = 0;
    let bags = 0;
    let bid = 0;
    let tricks = 0;
    for (const seat of [index, index + 2]) {
      const player = state.players[seat];
      if (player.bid === 0) {
        // Nil: 100 for taking nothing. Tricks a nil bidder does take are bags, and don't help their partner's bid.
        change += player.tricks === 0 ? 100 : -100;
        bags += player.tricks;
      } else {
        bid += player.bid;
        tricks += player.tricks;
      }
    }
    if (bid > 0) {
      if (tricks >= bid) {
        change += bid * 10;
        bags += tricks - bid;
      } else change -= bid * 10;
    }
    change += bags;
    team.bags += bags;
    while (team.bags >= 10) {
      team.bags -= 10;
      change -= 100;
    }
    team.score += change;
    return { team: index, bid, tricks: state.players[index].tricks + state.players[index + 2].tricks, change };
  });
  events.push({ type: 'round', summary: state.summary });
  const { target } = state.rules;
  const [a, b] = state.teams.map((team) => team.score);
  // Reaching the target ends the game; so does falling to minus the target. A dead heat plays on.
  const over = Math.max(a, b) >= target || Math.min(a, b) <= -target;
  if (over && a !== b) finish(state, events, a > b ? 0 : 1);
  else {
    state.phase = 'roundEnd';
    state.turn = null;
  }
}

const MOVES = {
  bid(state, seat, action, events) {
    if (state.phase !== 'bid') return 'The bidding is over.';
    if (state.turn !== seat) return 'It isn’t your turn.';
    if (!Number.isInteger(action.amount) || action.amount < 0 || action.amount > 13) return 'Bid from nil to 13.';
    state.players[seat].bid = action.amount;
    events.push({ type: 'bid', seat, amount: action.amount });
    if (state.players.every((player) => player.bid !== null)) {
      state.phase = 'play';
      state.turn = (state.dealer + 1) % 4;
    } else state.turn = (seat + 1) % 4;
    return null;
  },
  play(state, seat, action, events) {
    if (state.phase !== 'play') return state.phase === 'bid' ? 'Bid first.' : 'Wait for the next trick.';
    if (state.turn !== seat) return 'It isn’t your turn.';
    const hand = state.players[seat].hand;
    if (!isIndex(action.card, hand.length)) return 'Pick one of your cards.';
    if (!playable(state, seat).includes(action.card)) return state.trick.length ? 'You have to follow suit.' : 'Spades haven’t been broken yet.';
    const [card] = hand.splice(action.card, 1);
    state.trick.push({ seat, card });
    if (card.suit === 'S') state.spadesBroken = true;
    events.push({ type: 'played', seat, card });
    if (state.trick.length === 4) {
      state.phase = 'trickEnd';
      state.trickWinner = state.trick[trickWinner(state.trick, 'S')].seat;
      state.turn = null;
    } else state.turn = (seat + 1) % 4;
    return null;
  },
};

export function legalActions(state, seat) {
  if (!isIndex(seat, state.players.length) || state.turn !== seat) return [];
  return state.phase === 'bid' ? ['bid'] : state.phase === 'play' ? ['play'] : [];
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

/** A player has left for good. The computer plays their seat out for their partner, and they can't win. */
export function forfeit(state, seat) {
  if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
  if (state.phase === 'finished' || state.players[seat].out) return { ok: false, error: 'Nothing to do.' };
  state.players[seat].out = true;
  return { ok: true, events: [{ type: 'left', seat }] };
}

export const actors = (state) => (state.phase === 'bid' || state.phase === 'play' ? [state.turn] : []);
export const pause = (state) => (state.phase === 'trickEnd' ? 1500 : state.phase === 'roundEnd' ? 6000 : 0);

/** Moves on after a pause: gathers a finished trick, or deals the next round. */
export function step(state, options = {}) {
  const events = [];
  if (state.phase === 'trickEnd') {
    const winner = state.trickWinner;
    state.players[winner].tricks += 1;
    state.tricksPlayed += 1;
    state.trick = [];
    state.trickWinner = null;
    events.push({ type: 'trick', winner });
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

/** A move that is always accepted for the seat whose turn it is. */
export function anyLegal(state, seat) {
  if (state.phase === 'bid') return { type: 'bid', amount: 1 };
  return { type: 'play', card: playable(state, seat)[0] };
}

/** What one seat may know: their own hand and the cards on the table. */
export function viewFor(state, viewer) {
  const legal = legalActions(state, viewer);
  return {
    game: 'spades',
    you: viewer,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    dealer: state.dealer,
    trick: state.trick.map((play) => ({ seat: play.seat, card: { ...play.card } })),
    trickWinner: state.trickWinner,
    spadesBroken: state.spadesBroken,
    legal,
    playable: legal.includes('play') ? playable(state, viewer) : [],
    rules: state.rules,
    teams: state.teams.map((team) => ({ ...team })),
    summary: state.summary,
    results: state.results,
    players: state.players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      out: player.out,
      count: player.hand.length,
      bid: player.bid,
      tricks: player.tricks,
      hand: seat === viewer ? player.hand.map((card) => ({ ...card })) : null,
    })),
  };
}

export const eventFor = (event) => event;
