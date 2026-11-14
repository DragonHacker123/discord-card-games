// Jacks rules engine.
//
// Pure game logic: no DOM, timers or network. The test page runs it in the
// browser, and the Discord Activity server will run the same file later, so
// everything here must stay JSON-safe. Players only ever receive viewFor() and
// eventFor() output, which strip the cards they aren't allowed to see.
//
// A player's cards live in numbered slots. Slots 0-1 are the far row and 2-3
// the near row. A slot that loses its card stays empty rather than closing up,
// because players remember cards by where they sit.

export const ENGINE_VERSION = 4;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const START_CARDS = 4;
export const NEAR_SLOTS = [2, 3];

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const POWER_BY_RANK = {
  7: 'peekOwn',
  8: 'peekOwn',
  9: 'peekOther',
  10: 'peekOther',
  J: 'blindSwap',
  Q: 'queen',
};
const MATCH_PHASES = new Set(['draw', 'decide', 'power', 'endTurn', 'lastCall']);

// The settings a game can be dealt with. matchMode is how long matching stays open:
//   nextDiscard: any time while the card is on top, and play never pauses.
//   countdown:   for matchSeconds after each discard, and the next player waits.
// drawFromDiscard lets a player take the top discard instead of drawing.
export const DEFAULT_RULES = Object.freeze({
  jack: 10,
  queen: 10,
  blackKing: 10,
  redKing: -1,
  matchMode: 'nextDiscard',
  matchSeconds: 5,
  drawFromDiscard: false,
});

export function normaliseRules(given) {
  const input = given && typeof given === 'object' ? given : {};
  const whole = (value, fallback, min, max) => {
    const number = Math.round(Number(value));
    if (value === '' || value === null || !Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  };
  return {
    jack: whole(input.jack, DEFAULT_RULES.jack, -20, 30),
    queen: whole(input.queen, DEFAULT_RULES.queen, -20, 30),
    blackKing: whole(input.blackKing, DEFAULT_RULES.blackKing, -20, 30),
    redKing: whole(input.redKing, DEFAULT_RULES.redKing, -20, 30),
    matchMode: input.matchMode === 'countdown' ? 'countdown' : 'nextDiscard',
    matchSeconds: whole(input.matchSeconds, DEFAULT_RULES.matchSeconds, 2, 15),
    drawFromDiscard: input.drawFromDiscard === true,
  };
}

/** How long the final chance to match lasts, once the last go has been played. */
export function lastCallSeconds(rules) {
  return rules.matchMode === 'countdown' ? rules.matchSeconds : DEFAULT_RULES.matchSeconds;
}

export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  deck.push({ rank: 'JOKER', suit: 'R' }, { rank: 'JOKER', suit: 'B' });
  return deck;
}

export function scoreCard(card, rules = DEFAULT_RULES) {
  if (card.rank === 'JOKER') return -5;
  if (card.rank === 'K') return card.suit === 'H' || card.suit === 'D' ? rules.redKing : rules.blackKing;
  if (card.rank === 'A') return 1;
  if (card.rank === 'J') return rules.jack;
  if (card.rank === 'Q') return rules.queen;
  return Number(card.rank);
}

/** What a card you know nothing about is worth on average, under these settings. */
export function averageCardScore(rules = DEFAULT_RULES) {
  const deck = buildDeck();
  return deck.reduce((sum, card) => sum + scoreCard(card, rules), 0) / deck.length;
}

export function powerOf(card) {
  return POWER_BY_RANK[card.rank] ?? null;
}

/** Seeded random number, advancing holder.rng so a game can be replayed. */
export function nextRandom(holder) {
  holder.rng = (holder.rng + 0x6d2b79f5) | 0;
  let t = holder.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// A server passes its own random source, so nobody can work the deck out from a
// seed. Without one, the seeded generator makes a game replayable.
let outsideRandom = null;

function roll(holder) {
  if (!outsideRandom) return nextRandom(holder);
  const value = Number(outsideRandom());
  return value >= 0 && value < 1 ? value : nextRandom(holder);
}

function shuffle(holder, cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(roll(holder) * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function createGame({ players, seed = Date.now(), rules, random = null }) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new Error(`Jacks needs ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }
  const state = {
    engine: ENGINE_VERSION,
    seed,
    rng: seed | 0,
    rules: normaliseRules(rules),
    matchOpen: false,
    phase: 'peek',
    players: players.map((p) => ({ id: p.id, name: p.name, slots: [], ready: false })),
    drawPile: [],
    discardPile: [],
    turn: 0,
    turnCount: 0,
    drawn: null,
    drawnFrom: null, // 'draw', or 'discard' if everyone saw which card it was
    matchShut: false, // true from a pick-up off the discard pile until the next discard
    power: null,
    caller: null,
    finalTurnsLeft: 0,
    results: null,
    give: null, // { seat, owner, slot }: seat owes owner a card for that empty place
  };
  outsideRandom = typeof random === 'function' ? random : null;
  try {
    state.drawPile = shuffle(state, buildDeck());
    for (let i = 0; i < START_CARDS; i++) {
      for (const player of state.players) player.slots.push(state.drawPile.pop());
    }
    state.turn = Math.floor(roll(state) * players.length);
  } finally {
    outsideRandom = null;
  }
  return state;
}

class RuleError extends Error {}

function fail(message) {
  throw new RuleError(message);
}

const hasCards = (player) => player.slots.some(Boolean);
const countCards = (player) => player.slots.filter(Boolean).length;
const discardTop = (state) => state.discardPile[state.discardPile.length - 1] ?? null;

function requireTurn(state, seat, phase) {
  if (state.phase !== phase) fail('You can’t do that right now.');
  if (state.turn !== seat) fail('It isn’t your turn.');
}

function requirePower(state, seat, kinds, stage) {
  requireTurn(state, seat, 'power');
  if (!kinds.includes(state.power.kind) || state.power.stage !== stage) {
    fail('You can’t do that with this card.');
  }
}

const isIndex = (value) => Number.isInteger(value) && value >= 0;

function cardAt(state, seat, slot) {
  // Seats and slots arrive from players, so "length" or "__proto__" must not get through.
  if (!isIndex(seat) || !isIndex(slot)) return null;
  return state.players[seat]?.slots?.[slot] ?? null;
}

function requireOwnCard(state, seat, slot) {
  const card = cardAt(state, seat, slot);
  if (!card) fail('Pick one of your own cards.');
  return card;
}

function requireOtherCard(state, seat, target) {
  if (!target || target.seat === seat) fail('Pick another player’s card.');
  const card = cardAt(state, target.seat, target.slot);
  if (!card) fail('There’s no card there.');
  return card;
}

function exchange(state, a, b) {
  const first = state.players[a.seat].slots;
  const second = state.players[b.seat].slots;
  [first[a.slot], second[b.slot]] = [second[b.slot], first[a.slot]];
}

/** Takes the top card, turning the discard pile over if the draw pile is empty. */
function takeCard(state, events) {
  if (state.drawPile.length === 0 && state.discardPile.length > 1) {
    const top = state.discardPile.pop();
    state.drawPile = shuffle(state, state.discardPile);
    state.discardPile = [top];
    events.push({ type: 'reshuffled', cards: state.drawPile.length });
  }
  return state.drawPile.pop() ?? null;
}

function usablePower(state, seat, card) {
  const kind = powerOf(card);
  if (!kind) return null;
  const mine = countCards(state.players[seat]);
  const theirs = state.players.reduce((sum, p, i) => (i === seat ? sum : sum + countCards(p)), 0);
  if (kind === 'peekOwn') return mine > 0 ? kind : null;
  if (kind === 'peekOther') return theirs > 0 ? kind : null;
  return mine > 0 && theirs > 0 ? kind : null;
}

function matchingOpen(state) {
  if (!MATCH_PHASES.has(state.phase)) return false;
  // Picking up a card doesn't give anyone a second go at the card underneath.
  if (state.matchShut) return false;
  if (state.rules.matchMode === 'countdown') return state.matchOpen || state.phase === 'lastCall';
  return true;
}

/** In countdown mode a discard opens matching, until the host calls closeMatchWindow(). */
function openMatchWindow(state, events) {
  if (state.rules.matchMode !== 'countdown') return;
  state.matchOpen = true;
  events.push({ type: 'matchWindowOpened', seconds: state.rules.matchSeconds });
}

function startTurn(state, events) {
  state.phase = 'draw';
  state.turnCount += 1;
  events.push({ type: 'turnStarted', seat: state.turn });
}

function advanceTurn(state, events) {
  // Players who have left are passed over. Their last go still counts as gone.
  do {
    if (state.caller !== null) {
      if (state.finalTurnsLeft === 0) {
        state.phase = 'lastCall';
        state.matchOpen = false;
        events.push({ type: 'lastCall' });
        return;
      }
      state.finalTurnsLeft -= 1;
    }
    state.turn = (state.turn + 1) % state.players.length;
  } while (state.players[state.turn].out);
  startTurn(state, events);
}

function startPlay(state, events) {
  while (state.players[state.turn].out) state.turn = (state.turn + 1) % state.players.length;
  events.push({ type: 'started', first: state.turn });
  startTurn(state, events);
}

/** After the card is dealt with, a player may call. Once someone has called, nobody else can. */
function finishTurnAction(state, events) {
  state.power = null;
  if (state.caller === null) {
    state.phase = 'endTurn';
  } else {
    advanceTurn(state, events);
  }
}

const HANDLERS = {
  ready(state, seat, _action, events) {
    if (state.phase !== 'peek') fail('The game has already started.');
    const player = state.players[seat];
    if (player.ready) fail('You’re already ready.');
    player.ready = true;
    events.push({ type: 'ready', seat });
    if (state.players.every((p) => p.ready)) startPlay(state, events);
  },

  draw(state, seat, _action, events) {
    requireTurn(state, seat, 'draw');
    if (state.matchOpen) fail('Wait for the matching countdown to finish.');
    const card = takeCard(state, events);
    if (!card) {
      events.push({ type: 'noCardsLeft', seat });
      finishTurnAction(state, events);
      return;
    }
    state.drawn = card;
    state.drawnFrom = 'draw';
    state.phase = 'decide';
    events.push({ type: 'drew', seat, secret: { to: seat, data: { card } } });
  },

  // Everyone can see the card you take, so it goes into your hand in full view.
  takeDiscard(state, seat, _action, events) {
    requireTurn(state, seat, 'draw');
    if (!state.rules.drawFromDiscard) fail('You can’t pick up from the discard pile in this game.');
    if (state.matchOpen) fail('Wait for the matching countdown to finish.');
    if (!discardTop(state)) fail('There’s nothing on the discard pile.');
    const card = state.discardPile.pop();
    state.drawn = card;
    state.drawnFrom = 'discard';
    state.matchShut = true;
    state.phase = 'decide';
    events.push({ type: 'tookDiscard', seat, card });
  },

  // With no cards of your own, a card you picked up goes into one of your empty places.
  place(state, seat, action, events) {
    requireTurn(state, seat, 'decide');
    const { slots } = state.players[seat];
    if (state.drawnFrom !== 'discard' || hasCards(state.players[seat])) fail('You can’t do that right now.');
    const slot = action.slot ?? 0;
    if (!Number.isInteger(slot) || slot < 0 || slot >= slots.length || slots[slot]) fail('Pick one of your empty places.');
    const card = state.drawn;
    slots[slot] = card;
    state.drawn = null;
    state.drawnFrom = null;
    events.push({ type: 'placed', seat, slot, card });
    finishTurnAction(state, events);
  },

  swap(state, seat, action, events) {
    requireTurn(state, seat, 'decide');
    const old = requireOwnCard(state, seat, action.slot);
    const drawnCard = state.drawn;
    const seenByAll = state.drawnFrom === 'discard';
    state.players[seat].slots[action.slot] = drawnCard;
    state.discardPile.push(old);
    state.drawn = null;
    state.drawnFrom = null;
    state.matchShut = false;
    const event = { type: 'swapped', seat, slot: action.slot, card: old };
    events.push(seenByAll ? { ...event, fromDiscard: true, drawnCard } : { ...event, secret: { to: seat, data: { drawnCard } } });
    openMatchWindow(state, events);
    finishTurnAction(state, events);
  },

  discard(state, seat, _action, events) {
    requireTurn(state, seat, 'decide');
    // A card you picked up never goes straight back.
    if (state.drawnFrom === 'discard') fail('You have to keep a card you picked up.');
    const card = state.drawn;
    state.discardPile.push(card);
    state.drawn = null;
    state.drawnFrom = null;
    state.matchShut = false;
    const kind = usablePower(state, seat, card);
    events.push({ type: 'discardedDrawn', seat, card, power: kind });
    openMatchWindow(state, events);
    if (kind) {
      state.phase = 'power';
      state.power = { kind, seat, stage: 'choose', targets: [], seen: [] };
    } else {
      finishTurnAction(state, events);
    }
  },

  peek(state, seat, action, events) {
    requirePower(state, seat, ['peekOwn', 'peekOther'], 'choose');
    const target = action.target;
    const kind = state.power.kind;
    let card;
    if (kind === 'peekOwn') {
      if (!target || target.seat !== seat) fail('Pick one of your own cards.');
      card = requireOwnCard(state, seat, target.slot);
    } else {
      card = requireOtherCard(state, seat, target);
    }
    const spot = { seat: target.seat, slot: target.slot };
    state.power.stage = 'viewing';
    state.power.targets = [spot];
    state.power.seen = [{ ...spot, card }];
    events.push({ type: 'looked', seat, kind, targets: [spot], secret: { to: seat, data: { cards: [card] } } });
  },

  powerDone(state, seat, _action, events) {
    requirePower(state, seat, ['peekOwn', 'peekOther'], 'viewing');
    finishTurnAction(state, events);
  },

  skipPower(state, seat, _action, events) {
    requirePower(state, seat, ['peekOwn', 'peekOther', 'blindSwap', 'queen'], 'choose');
    events.push({ type: 'powerSkipped', seat, kind: state.power.kind });
    finishTurnAction(state, events);
  },

  blindSwap(state, seat, action, events) {
    requirePower(state, seat, ['blindSwap'], 'choose');
    requireOwnCard(state, seat, action.own);
    requireOtherCard(state, seat, action.other);
    const a = { seat, slot: action.own };
    const b = { seat: action.other.seat, slot: action.other.slot };
    exchange(state, a, b);
    events.push({ type: 'blindSwapped', seat, a, b });
    finishTurnAction(state, events);
  },

  queenLook(state, seat, action, events) {
    requirePower(state, seat, ['queen'], 'choose');
    const ownCard = requireOwnCard(state, seat, action.own);
    const otherCard = requireOtherCard(state, seat, action.other);
    const a = { seat, slot: action.own };
    const b = { seat: action.other.seat, slot: action.other.slot };
    state.power.stage = 'decide';
    state.power.targets = [a, b];
    state.power.seen = [
      { ...a, card: ownCard },
      { ...b, card: otherCard },
    ];
    events.push({ type: 'looked', seat, kind: 'queen', targets: [a, b], secret: { to: seat, data: { cards: [ownCard, otherCard] } } });
  },

  queenDecide(state, seat, action, events) {
    requirePower(state, seat, ['queen'], 'decide');
    const [a, b] = state.power.targets;
    // A looked-at card may have been matched away, or replaced by a given card,
    // while this player decided.
    const stillSeen = (spot) => {
      const card = state.power.seen.find((item) => item.seat === spot.seat && item.slot === spot.slot)?.card;
      if (!card) return false;
      const now = cardAt(state, spot.seat, spot.slot);
      return Boolean(now) && now.rank === card.rank && now.suit === card.suit;
    };
    const stillThere = stillSeen(a) && stillSeen(b);
    const swapped = Boolean(action.swap) && stillThere;
    if (swapped) exchange(state, a, b);
    events.push({ type: 'queenResolved', seat, swapped, a, b, cardGone: Boolean(action.swap) && !stillThere });
    finishTurnAction(state, events);
  },

  endTurn(state, seat, _action, events) {
    requireTurn(state, seat, 'endTurn');
    advanceTurn(state, events);
  },

  callJacks(state, seat, _action, events) {
    requireTurn(state, seat, 'endTurn');
    state.caller = seat;
    state.finalTurnsLeft = state.players.length - 1;
    events.push({ type: 'called', seat });
    advanceTurn(state, events);
  },

  match(state, seat, action, events) {
    if (!matchingOpen(state)) fail('You can’t try a match right now.');
    const top = discardTop(state);
    if (!top) fail('There’s nothing on the discard pile to match yet.');
    // You can try any player's card. With no owner given, it means your own.
    const owner = action.owner ?? seat;
    const card = cardAt(state, owner, action.slot);
    if (!card) fail('There’s no card there.');
    if (card.rank === top.rank) {
      state.players[owner].slots[action.slot] = null;
      state.discardPile.push(card);
      events.push({ type: 'matched', seat, owner, slot: action.slot, card });
      if (owner === seat) return;
      // Matching someone else's card means handing them one of yours.
      if (hasCards(state.players[seat])) {
        state.give = { seat, owner, slot: action.slot };
        return;
      }
      // With nothing to hand over, they get a card from the draw pile instead.
      const refill = takeCard(state, events);
      if (refill) {
        state.players[owner].slots[action.slot] = refill;
        events.push({ type: 'refilled', owner, slot: action.slot });
      }
      return;
    }
    const penalty = takeCard(state, events);
    let penaltySlot = null;
    if (penalty) {
      state.players[seat].slots.push(penalty);
      penaltySlot = state.players[seat].slots.length - 1;
    }
    events.push({ type: 'matchFailed', seat, owner, slot: action.slot, card, against: { ...top }, penaltySlot });
  },

  giveCard(state, seat, action, events) {
    const { give } = state;
    if (!give || give.seat !== seat) fail('You don’t owe anyone a card.');
    const card = requireOwnCard(state, seat, action.slot);
    state.players[seat].slots[action.slot] = null;
    state.players[give.owner].slots[give.slot] = card;
    state.give = null;
    // The card itself stays secret, so the event only says where it went.
    events.push({ type: 'gaveCard', seat, slot: action.slot, owner: give.owner, ownerSlot: give.slot });
  },

  // Giving is optional. If you keep your cards, they get one from the draw pile instead.
  keepCards(state, seat, _action, events) {
    const { give } = state;
    if (!give || give.seat !== seat) fail('You don’t owe anyone a card.');
    state.give = null;
    events.push({ type: 'keptCards', seat, owner: give.owner, slot: give.slot });
    const refill = takeCard(state, events);
    if (refill) {
      state.players[give.owner].slots[give.slot] = refill;
      events.push({ type: 'refilled', owner: give.owner, slot: give.slot });
    }
  },
};

/**
 * Applies one player's action. Returns { ok: true, events } or { ok: false, error }.
 * A rejected action leaves the state untouched.
 */
export function applyAction(state, seat, action, options = {}) {
  const known = action && typeof action === 'object' && typeof action.type === 'string' && Object.hasOwn(HANDLERS, action.type);
  const handler = known ? HANDLERS[action.type] : null;
  if (!handler) return { ok: false, error: 'Unknown action.' };
  if (!isIndex(seat) || !state.players[seat]) return { ok: false, error: 'Unknown player.' };
  if (state.players[seat].out) return { ok: false, error: 'You’ve left this game.' };
  // Everyone waits while a player chooses which card to hand over.
  if (state.give && action.type !== 'giveCard' && action.type !== 'keepCards') return { ok: false, error: 'Wait for the card to be given.' };
  const events = [];
  outsideRandom = typeof options?.random === 'function' ? options.random : null;
  try {
    handler(state, seat, action, events);
    return { ok: true, events };
  } catch (error) {
    // Never throw: a server has to survive anything a player sends.
    if (error instanceof RuleError) return { ok: false, error: error.message };
    return { ok: false, error: 'That move didn’t work.', bug: String(error?.stack ?? error) };
  } finally {
    outsideRandom = null;
  }
}

/**
 * A player leaves for good. Their cards go face down to the bottom of the
 * discard pile, they are passed over from now on, and they can't win. The game
 * ends at once if fewer than two players are left.
 */
export function forfeit(state, seat) {
  const player = isIndex(seat) ? state.players[seat] : null;
  if (!player || player.out) return { ok: false, error: 'Unknown player.' };
  if (state.phase === 'finished') return { ok: false, error: 'The game is over.' };
  const events = [];
  const cards = player.slots.filter(Boolean);
  if (state.turn === seat && state.drawn) {
    cards.push(state.drawn);
    state.drawn = null;
    state.drawnFrom = null;
  }
  state.discardPile.unshift(...cards);
  player.slots = player.slots.map(() => null);
  player.out = true;
  player.ready = true;
  events.push({ type: 'forfeited', seat, cards: cards.length });

  const { give } = state;
  if (give && (give.seat === seat || give.owner === seat)) {
    state.give = null;
    // They owed someone a card and now have none, so the draw pile pays instead.
    if (give.seat === seat) {
      const refill = takeCard(state, events);
      if (refill) {
        state.players[give.owner].slots[give.slot] = refill;
        events.push({ type: 'refilled', owner: give.owner, slot: give.slot });
      }
    }
  }

  if (state.players.filter((p) => !p.out).length < 2) {
    state.power = null;
    state.matchOpen = false;
    state.give = null;
    state.results = computeResults(state);
    state.phase = 'finished';
    events.push({ type: 'finished', results: state.results });
  } else if (state.phase === 'peek') {
    if (state.players.every((p) => p.ready)) startPlay(state, events);
  } else if (state.turn === seat && state.phase !== 'lastCall') {
    state.power = null;
    advanceTurn(state, events);
  }
  return { ok: true, events };
}

/** Countdown mode only: the host calls this when the seconds run out. */
export function closeMatchWindow(state) {
  if (!state.matchOpen) return { ok: false, error: 'Matching isn’t counting down.' };
  state.matchOpen = false;
  return { ok: true, events: [{ type: 'matchWindowClosed' }] };
}

/** Ends the short last chance to match, after the host's countdown runs out. */
export function closeLastCall(state) {
  if (state.phase !== 'lastCall') return { ok: false, error: 'The game isn’t ending yet.' };
  if (state.give) return { ok: false, error: 'Wait for the card to be given.' };
  state.results = computeResults(state);
  state.phase = 'finished';
  return { ok: true, events: [{ type: 'finished', results: state.results }] };
}

function computeResults(state) {
  const rows = state.players.map((player, seat) => {
    const cards = player.slots.filter(Boolean);
    return {
      seat,
      name: player.name,
      cards,
      total: cards.reduce((sum, card) => sum + scoreCard(card, state.rules), 0),
      called: seat === state.caller,
      out: Boolean(player.out),
    };
  });
  // Someone who left can't win, however few points their empty hand shows.
  const staying = rows.filter((row) => !row.out);
  const best = Math.min(...staying.map((row) => row.total));
  const lowest = staying.filter((row) => row.total === best);
  // Whoever called has to beat everyone, so a tie goes against them.
  const winners = lowest.length > 1 ? lowest.filter((row) => !row.called) : lowest;
  return {
    best,
    winners: winners.map((row) => row.seat),
    standings: [...rows].sort((a, b) => Number(a.out) - Number(b.out) || a.total - b.total || Number(a.called) - Number(b.called) || a.seat - b.seat),
  };
}

export function legalActions(state, seat) {
  const player = state.players[seat];
  if (!player || player.out) return [];
  if (state.give) return state.give.seat === seat ? ['giveCard', 'keepCards'] : [];
  const actions = [];
  const isTurn = seat === state.turn;
  if (state.phase === 'peek' && !player.ready) actions.push('ready');
  if (state.phase === 'draw' && isTurn && !state.matchOpen) {
    actions.push('draw');
    if (state.rules.drawFromDiscard && discardTop(state)) actions.push('takeDiscard');
  }
  if (state.phase === 'decide' && isTurn) {
    if (state.drawnFrom !== 'discard') actions.push('discard');
    else if (!hasCards(player)) actions.push('place');
    if (hasCards(player)) actions.push('swap');
  }
  if (state.phase === 'power' && isTurn) {
    const { kind, stage } = state.power;
    if (stage === 'choose') {
      if (kind === 'peekOwn' || kind === 'peekOther') actions.push('peek');
      if (kind === 'blindSwap') actions.push('blindSwap');
      if (kind === 'queen') actions.push('queenLook');
      actions.push('skipPower');
    }
    if (stage === 'viewing') actions.push('powerDone');
    if (stage === 'decide') actions.push('queenDecide');
  }
  if (state.phase === 'endTurn' && isTurn) actions.push('endTurn', 'callJacks');
  if (matchingOpen(state) && discardTop(state)) actions.push('match');
  return actions;
}

/** Everything one player is allowed to know right now. */
export function viewFor(state, viewer) {
  const finished = state.phase === 'finished';
  const power = state.power;
  return {
    engine: state.engine,
    rules: state.rules,
    matchOpen: state.matchOpen,
    phase: state.phase,
    you: viewer,
    turn: state.turn,
    turnCount: state.turnCount,
    caller: state.caller,
    finalTurnsLeft: state.finalTurnsLeft,
    drawCount: state.drawPile.length,
    discardCount: state.discardPile.length,
    discardTop: discardTop(state),
    discardBelow: state.discardPile[state.discardPile.length - 2] ?? null,
    holding: state.drawn ? state.turn : null,
    drawn: viewer === state.turn || state.drawnFrom === 'discard' ? state.drawn : null,
    drawnFrom: state.drawnFrom,
    players: state.players.map((player, seat) => ({
      id: player.id,
      name: player.name,
      ready: player.ready,
      out: Boolean(player.out),
      slots: player.slots.map((card, slot) => {
        if (!card) return null;
        const peeking = state.phase === 'peek' && seat === viewer && !player.ready && NEAR_SLOTS.includes(slot);
        return finished || peeking ? { card } : {};
      }),
    })),
    power: power
      ? {
          kind: power.kind,
          seat: power.seat,
          stage: power.stage,
          targets: power.targets,
          seen: viewer === power.seat ? power.seen : [],
        }
      : null,
    results: state.results,
    give: state.give,
    legal: legalActions(state, viewer),
  };
}

/** The version of an event one player may see. */
export function eventFor(event, viewer) {
  const { secret, ...shown } = event;
  return secret && secret.to === viewer ? { ...shown, ...secret.data } : shown;
}

/** Test tool: moves a card of this rank to the top of the draw pile, if one is there. */
export function stackNextCard(state, rank) {
  const index = state.drawPile.findLastIndex((card) => card.rank === rank);
  if (index === -1) return false;
  state.drawPile.push(state.drawPile.splice(index, 1)[0]);
  return true;
}
