// The rules of Blackjack. Pure and JSON-safe: the whole game is one plain
// object, changed only by applyAction(), dealerStep(), nextRound() and forfeit().
//
// Everyone plays against the house for chips. A game is a set number of hands;
// whoever has the most chips at the end wins. Each hand: everyone bets, two
// cards each, then each player in turn hits, stands, doubles or splits. The
// house then turns over its second card and draws to 17.
//
// The engine takes moves from the network, so applyAction() never throws and a
// refused move leaves the state exactly as it was.

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 6;
export const DECKS = 4;
export const START_CHIPS = 1000;
export const MIN_BET = 10;
export const MAX_BET = 500;
export const BET_STEP = 10;
export const RESHUFFLE_BELOW = 60;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const DEFAULT_RULES = Object.freeze({ rounds: 10 });

/** Accepts anything and always returns a sane rule set. */
export function normaliseRules(given) {
  const rounds = given && typeof given === 'object' ? given.rounds : undefined;
  return { rounds: Number.isInteger(rounds) ? Math.min(30, Math.max(1, rounds)) : DEFAULT_RULES.rounds };
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
export const cardValue = (card) => (card.rank === 'A' ? 11 : ['K', 'Q', 'J', '10'].includes(card.rank) ? 10 : Number(card.rank));

/** The best total for some cards. soft means an ace is still counting as 11. */
export function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += cardValue(card);
    if (card.rank === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

/** Two cards making 21, not from a split. */
const isNatural = (hand) => hand.cards.length === 2 && !hand.split && handTotal(hand.cards).total === 21;

function newShoe(state, random) {
  const shoe = [];
  for (let deck = 0; deck < DECKS; deck++) for (const suit of SUITS) for (const rank of RANKS) shoe.push({ rank, suit });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor((random ? random() : nextRandom(state)) * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function draw(state, random) {
  if (state.shoe.length === 0) state.shoe = newShoe(state, random);
  return state.shoe.pop();
}

export function createGame({ players, seed = Date.now(), rules, random = null }) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`Blackjack needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }
  const state = {
    version: ENGINE_VERSION,
    rng: seed | 0,
    rules: normaliseRules(rules),
    phase: 'bet',
    round: 0,
    shoe: [],
    house: { cards: [], revealed: false },
    players: players.map(({ id, name }) => ({ id, name, chips: START_CHIPS, out: false, inRound: false, bet: 0, hands: [], hand: 0 })),
    turn: -1,
    results: null,
  };
  state.shoe = newShoe(state, random);
  startRound(state, []);
  return state;
}

const canAfford = (player) => !player.out && player.chips >= MIN_BET;

function startRound(state, events) {
  state.round += 1;
  state.phase = 'bet';
  state.turn = -1;
  state.house = { cards: [], revealed: false };
  for (const player of state.players) {
    player.bet = 0;
    player.hands = [];
    player.hand = 0;
    player.inRound = canAfford(player);
  }
  events.push({ type: 'round', round: state.round });
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

/** Pays every hand and moves to the pause before the next one. */
function settle(state, events) {
  const house = handTotal(state.house.cards).total;
  const houseNatural = state.house.cards.length === 2 && house === 21;
  for (const player of state.players) {
    for (const hand of player.hands) {
      const { total } = handTotal(hand.cards);
      let back = 0;
      if (total > 21) hand.outcome = 'bust';
      else if (isNatural(hand)) {
        hand.outcome = houseNatural ? 'push' : 'blackjack';
        back = houseNatural ? hand.bet : hand.bet * 2.5;
      } else if (houseNatural || (house <= 21 && house > total)) hand.outcome = 'lose';
      else if (house > 21 || total > house) {
        hand.outcome = 'win';
        back = hand.bet * 2;
      } else {
        hand.outcome = 'push';
        back = hand.bet;
      }
      hand.done = true;
      hand.paid = back - hand.bet;
      player.chips += back;
    }
  }
  state.house.revealed = true;
  state.phase = 'payout';
  state.turn = -1;
  events.push({ type: 'settled' });
}

/** Moves to the first hand still being played, or to the house when there is none. */
function advance(state, events) {
  for (let seat = 0; seat < state.players.length; seat++) {
    const index = state.players[seat].hands.findIndex((hand) => !hand.done);
    if (index === -1) continue;
    state.players[seat].hand = index;
    if (state.turn !== seat) events.push({ type: 'turn', seat });
    state.turn = seat;
    state.phase = 'play';
    return;
  }
  state.turn = -1;
  state.phase = 'dealer';
  events.push({ type: 'houseTurn' });
}

function deal(state, events, random) {
  if (state.shoe.length < RESHUFFLE_BELOW) {
    state.shoe = newShoe(state, random);
    events.push({ type: 'shuffled' });
  }
  const playing = state.players.filter((player) => player.inRound && player.bet > 0);
  for (const player of playing) player.hands = [{ cards: [], bet: player.bet, done: false, split: false, doubled: false, outcome: null, paid: 0 }];
  for (let pass = 0; pass < 2; pass++) {
    for (const player of playing) player.hands[0].cards.push(draw(state, random));
    state.house.cards.push(draw(state, random));
  }
  events.push({ type: 'dealt' });
  // The house checks for blackjack before anyone plays.
  if (handTotal(state.house.cards).total === 21) {
    events.push({ type: 'houseReveal' });
    settle(state, events);
    return;
  }
  for (const player of playing) if (isNatural(player.hands[0])) player.hands[0].done = true;
  advance(state, events);
}

function dealIfReady(state, events, random) {
  const waiting = state.players.filter((player) => player.inRound && !player.out);
  if (waiting.length === 0) return finish(state, events);
  if (waiting.every((player) => player.bet > 0)) deal(state, events, random);
  return undefined;
}

const MOVES = {
  bet(state, seat, action, events, random) {
    const player = state.players[seat];
    if (state.phase !== 'bet') return 'Bets are closed.';
    if (!player.inRound) return 'You’re out of chips.';
    if (player.bet > 0) return 'You’ve already bet.';
    const { amount } = action;
    if (!Number.isInteger(amount) || amount < MIN_BET || amount > MAX_BET || amount % BET_STEP !== 0) return 'That bet isn’t allowed.';
    if (amount > player.chips) return 'You don’t have that many chips.';
    player.chips -= amount;
    player.bet = amount;
    events.push({ type: 'bet', seat, amount });
    dealIfReady(state, events, random);
    return null;
  },
  hit(state, seat, _action, events, random) {
    const player = state.players[seat];
    const hand = player.hands[player.hand];
    hand.cards.push(draw(state, random));
    const { total } = handTotal(hand.cards);
    events.push({ type: 'hit', seat, hand: player.hand });
    if (total > 21) {
      hand.outcome = 'bust';
      events.push({ type: 'bust', seat, hand: player.hand });
    }
    if (total >= 21) {
      hand.done = true;
      advance(state, events);
    }
    return null;
  },
  stand(state, seat, _action, events) {
    const player = state.players[seat];
    player.hands[player.hand].done = true;
    events.push({ type: 'stood', seat, hand: player.hand });
    advance(state, events);
    return null;
  },
  double(state, seat, _action, events, random) {
    const player = state.players[seat];
    const hand = player.hands[player.hand];
    if (hand.cards.length !== 2) return 'You can only double on your first two cards.';
    if (player.chips < hand.bet) return 'You don’t have the chips to double.';
    player.chips -= hand.bet;
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(draw(state, random));
    hand.done = true;
    events.push({ type: 'doubled', seat, hand: player.hand });
    if (handTotal(hand.cards).total > 21) {
      hand.outcome = 'bust';
      events.push({ type: 'bust', seat, hand: player.hand });
    }
    advance(state, events);
    return null;
  },
  split(state, seat, _action, events, random) {
    const player = state.players[seat];
    const hand = player.hands[player.hand];
    if (player.hands.length !== 1 || hand.cards.length !== 2 || hand.cards[0].rank !== hand.cards[1].rank) return 'You can only split a pair, once.';
    if (player.chips < hand.bet) return 'You don’t have the chips to split.';
    player.chips -= hand.bet;
    const aces = hand.cards[0].rank === 'A';
    player.hands = hand.cards.map((card) => {
      const cards = [card, draw(state, random)];
      // Split aces get one card each. Any split hand that reaches 21 stands.
      return { cards, bet: hand.bet, done: aces || handTotal(cards).total === 21, split: true, doubled: false, outcome: null, paid: 0 };
    });
    events.push({ type: 'split', seat });
    advance(state, events);
    return null;
  },
};

export function legalActions(state, seat) {
  if (!isIndex(seat, state.players.length)) return [];
  const player = state.players[seat];
  if (player.out) return [];
  if (state.phase === 'bet') return player.inRound && player.bet === 0 ? ['bet'] : [];
  if (state.phase !== 'play' || state.turn !== seat) return [];
  const hand = player.hands[player.hand];
  const legal = ['hit', 'stand'];
  if (hand.cards.length === 2 && player.chips >= hand.bet) {
    legal.push('double');
    if (player.hands.length === 1 && hand.cards[0].rank === hand.cards[1].rank) legal.push('split');
  }
  return legal;
}

/** Returns { ok: true, events } or { ok: false, error }. Never throws. */
export function applyAction(state, seat, action, options = {}) {
  try {
    if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string' || !Object.hasOwn(MOVES, action.type)) {
      return { ok: false, error: 'Unknown move.' };
    }
    if (state.phase === 'finished') return { ok: false, error: 'The game is over.' };
    if (state.players[seat].out) return { ok: false, error: 'You’ve left this game.' };
    if (action.type !== 'bet') {
      if (state.phase !== 'play') return { ok: false, error: 'You can’t do that now.' };
      if (state.turn !== seat) return { ok: false, error: 'It isn’t your turn.' };
    }
    const events = [];
    const refusal = MOVES[action.type](state, seat, action, events, options.random ?? null);
    return refusal ? { ok: false, error: refusal } : { ok: true, events };
  } catch (error) {
    return { ok: false, error: 'Something went wrong with that move.', bug: String(error?.stack ?? error) };
  }
}

/**
 * One step of the house's turn: turn over the hidden card, then draw one card
 * at a time to 17, then pay out. The caller spaces the steps out.
 */
export function dealerStep(state, options = {}) {
  if (state.phase !== 'dealer') return { ok: false, error: 'It isn’t the house’s turn.' };
  const events = [];
  if (!state.house.revealed) {
    state.house.revealed = true;
    events.push({ type: 'houseReveal' });
    return { ok: true, events };
  }
  // The house only draws if some hand is still waiting to be compared.
  const live = state.players.some((player) => player.hands.some((hand) => hand.outcome !== 'bust' && !isNatural(hand)));
  if (live && handTotal(state.house.cards).total < 17) {
    state.house.cards.push(draw(state, options.random ?? null));
    events.push({ type: 'houseDrew' });
    return { ok: true, events };
  }
  settle(state, events);
  return { ok: true, events };
}

/** After the payout: the next hand, or the end of the game. */
export function nextRound(state) {
  if (state.phase !== 'payout') return { ok: false, error: 'The hand isn’t over.' };
  const events = [];
  if (state.round >= state.rules.rounds || !state.players.some(canAfford)) finish(state, events);
  else startRound(state, events);
  return { ok: true, events };
}

/** A player has left for good. Any bet on the table is lost and they can't win. */
export function forfeit(state, seat, options = {}) {
  if (!isIndex(seat, state.players.length)) return { ok: false, error: 'Unknown player.' };
  const player = state.players[seat];
  if (state.phase === 'finished' || player.out) return { ok: false, error: 'Nothing to do.' };
  const events = [{ type: 'left', seat }];
  player.out = true;
  player.inRound = false;
  player.hands = [];
  player.bet = 0;
  if (!state.players.some((other) => !other.out)) finish(state, events);
  else if (state.phase === 'bet') dealIfReady(state, events, options.random ?? null);
  else if (state.phase === 'play' && state.turn === seat) advance(state, events);
  return { ok: true, events };
}

/** What one seat may know: everything on the table except the house's hidden card and the shoe. */
export function viewFor(state, viewer) {
  const { revealed } = state.house;
  return {
    game: 'blackjack',
    you: viewer,
    phase: state.phase,
    round: state.round,
    rounds: state.rules.rounds,
    turn: state.turn,
    minBet: MIN_BET,
    maxBet: MAX_BET,
    rules: state.rules,
    legal: legalActions(state, viewer),
    results: state.results,
    house: {
      cards: state.house.cards.map((card, index) => (revealed || index === 0 ? { ...card } : null)),
      total: revealed ? handTotal(state.house.cards).total : null,
    },
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      chips: player.chips,
      out: player.out,
      inRound: player.inRound,
      bet: player.bet,
      hand: player.hand,
      hands: player.hands.map((hand) => ({
        cards: hand.cards.map((card) => ({ ...card })),
        bet: hand.bet,
        done: hand.done,
        outcome: hand.outcome,
        paid: hand.paid,
        ...handTotal(hand.cards),
      })),
    })),
  };
}

/** No event carries a card, so there is nothing to hide. */
export function eventFor(event) {
  return event;
}
