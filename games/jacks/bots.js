// Computer players for Jacks.
//
// A bot only uses what eventFor() and viewFor() hand it, the same information a
// person gets, and it keeps its own memory of the cards it has seen. That memory
// fades and sometimes goes wrong, so bots make honest mistakes such as a failed
// match. A bot is plain JSON, so it survives a page update along with the game.

import { averageCardScore, nextRandom, powerOf, scoreCard } from './engine.js';

const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SWAPPED_IN_DISCOUNT = 2.2; // People usually keep cards they chose to swap in.
const TAKE_DISCARD_GAIN = 3; // How much better than its worst card a discard must be to take it.

const spot = (seat, slot) => `${seat}:${slot}`;

export function createBot(seat, seed, options = {}) {
  return {
    seat,
    rng: seed | 0,
    memory: {},
    guesses: {},
    forgetOwn: options.forgetOwn ?? 0.015,
    forgetOthers: options.forgetOthers ?? 0.05,
    reactChance: options.reactChance ?? 0.9,
  };
}

function trade(bot, a, b) {
  const keyA = spot(a.seat, a.slot);
  const keyB = spot(b.seat, b.slot);
  for (const store of [bot.memory, bot.guesses]) {
    const first = store[keyA];
    const second = store[keyB];
    delete store[keyA];
    delete store[keyB];
    if (second !== undefined) store[keyA] = second;
    if (first !== undefined) store[keyB] = first;
  }
}

function clearSpot(bot, key) {
  delete bot.memory[key];
  delete bot.guesses[key];
}

/** Each turn, some memories fade, and a few turn into the wrong card. */
function fadeMemories(bot) {
  for (const [key, card] of Object.entries(bot.memory)) {
    const own = key.startsWith(`${bot.seat}:`);
    if (nextRandom(bot) >= (own ? bot.forgetOwn : bot.forgetOthers)) continue;
    const position = RANK_ORDER.indexOf(card.rank);
    if (position !== -1 && nextRandom(bot) < 0.4) {
      const nudge = nextRandom(bot) < 0.5 ? -1 : 1;
      const rank = RANK_ORDER[(position + nudge + RANK_ORDER.length) % RANK_ORDER.length];
      bot.memory[key] = { ...card, rank };
    } else {
      delete bot.memory[key];
    }
  }
}

export function botObserve(bot, event) {
  switch (event.type) {
    case 'swapped': {
      const key = spot(event.seat, event.slot);
      clearSpot(bot, key);
      // A bot sees the drawn card if it's its own, or if it was taken from the discard pile.
      if (event.drawnCard) bot.memory[key] = event.drawnCard;
      else bot.guesses[key] = true;
      break;
    }
    case 'looked':
      if (event.seat === bot.seat) {
        event.targets.forEach((target, i) => {
          bot.memory[spot(target.seat, target.slot)] = event.cards[i];
        });
      }
      break;
    case 'blindSwapped':
      trade(bot, event.a, event.b);
      break;
    case 'queenResolved':
      if (event.swapped) trade(bot, event.a, event.b);
      break;
    case 'matched':
    case 'refilled':
      clearSpot(bot, spot(event.owner, event.slot));
      break;
    case 'placed':
      bot.memory[spot(event.seat, event.slot)] = event.card;
      break;
    case 'matchFailed':
      bot.memory[spot(event.owner, event.slot)] = event.card;
      break;
    case 'gaveCard':
      trade(bot, { seat: event.seat, slot: event.slot }, { seat: event.owner, slot: event.ownerSlot });
      break;
    case 'turnStarted':
      fadeMemories(bot);
      break;
    default:
  }
}

function occupied(view, seat) {
  const slots = [];
  view.players[seat].slots.forEach((entry, slot) => {
    if (entry) slots.push(slot);
  });
  return slots;
}

function estimate(bot, view, seat, slot) {
  const key = spot(seat, slot);
  if (bot.memory[key]) return scoreCard(bot.memory[key], view.rules);
  const average = averageCardScore(view.rules);
  return bot.guesses[key] ? average - SWAPPED_IN_DISCOUNT : average;
}

const isKnown = (bot, seat, slot) => Boolean(bot.memory[spot(seat, slot)]);

function estimateHand(bot, view, seat) {
  return occupied(view, seat).reduce((sum, slot) => sum + estimate(bot, view, seat, slot), 0);
}

function worstOwnSlot(bot, view) {
  let best = null;
  for (const slot of occupied(view, bot.seat)) {
    const value = estimate(bot, view, bot.seat, slot);
    if (!best || value > best.value) best = { slot, value };
  }
  return best;
}

function bestOtherCard(bot, view) {
  let best = null;
  view.players.forEach((_player, seat) => {
    if (seat === bot.seat) return;
    for (const slot of occupied(view, seat)) {
      const value = estimate(bot, view, seat, slot);
      if (!best || value < best.value) best = { seat, slot, value };
    }
  });
  return best;
}

function unknownOwnSlot(bot, view) {
  return occupied(view, bot.seat).find((slot) => !isKnown(bot, bot.seat, slot)) ?? null;
}

function unknownOtherCard(bot, view) {
  const seats = view.players
    .map((_player, seat) => seat)
    .filter((seat) => seat !== bot.seat)
    .sort((a, b) => estimateHand(bot, view, a) - estimateHand(bot, view, b));
  for (const seat of seats) {
    const slot = occupied(view, seat).find((s) => !isKnown(bot, seat, s));
    if (slot !== undefined) return { seat, slot };
  }
  return null;
}

function powerValue(bot, view, kind) {
  if (kind === 'peekOwn') return unknownOwnSlot(bot, view) !== null ? 2.5 : 0;
  if (kind === 'peekOther') return unknownOtherCard(bot, view) ? 1 : 0;
  const own = worstOwnSlot(bot, view);
  const other = bestOtherCard(bot, view);
  if (!own || !other) return 0;
  const gain = Math.max(0, own.value - other.value);
  return kind === 'queen' ? gain + 1 : gain;
}

function chooseDraw(bot, view) {
  if (view.legal.includes('takeDiscard')) {
    const own = worstOwnSlot(bot, view);
    const score = scoreCard(view.discardTop, view.rules);
    // With no cards its total is 0, so only a card that scores below zero is worth having.
    if (own ? own.value - score >= TAKE_DISCARD_GAIN : score < 0) return { type: 'takeDiscard' };
  }
  return { type: 'draw' };
}

function decideDrawn(bot, view) {
  const own = worstOwnSlot(bot, view);
  if (!own) return { type: 'discard' };
  if (view.drawnFrom === 'discard') return { type: 'swap', slot: own.slot };
  const gain = own.value - scoreCard(view.drawn, view.rules);
  const kind = powerOf(view.drawn);
  const value = kind ? powerValue(bot, view, kind) : 0;
  if (gain > 0.5 && gain >= value) return { type: 'swap', slot: own.slot };
  return { type: 'discard' };
}

function choosePower(bot, view) {
  const { kind } = view.power;
  if (kind === 'peekOwn') {
    const slot = unknownOwnSlot(bot, view);
    if (slot === null) return { type: 'skipPower' };
    return { type: 'peek', target: { seat: bot.seat, slot } };
  }
  if (kind === 'peekOther') {
    const target = unknownOtherCard(bot, view);
    return target ? { type: 'peek', target } : { type: 'skipPower' };
  }
  const own = worstOwnSlot(bot, view);
  const other = bestOtherCard(bot, view);
  // Matches can take away the last cards it could have used this power on.
  if (!own || !other) return { type: 'skipPower' };
  if (kind === 'blindSwap') {
    if (own.value - other.value < 1.5) return { type: 'skipPower' };
    return { type: 'blindSwap', own: own.slot, other: { seat: other.seat, slot: other.slot } };
  }
  return { type: 'queenLook', own: own.slot, other: { seat: other.seat, slot: other.slot } };
}

function shouldCall(bot, view) {
  const mine = occupied(view, bot.seat);
  if (mine.length === 0) return true;
  const rounds = view.turnCount / view.players.length;
  if (rounds < 2) return false;
  if (rounds >= 12) return true;
  const unknown = mine.filter((slot) => !isKnown(bot, bot.seat, slot)).length;
  if (unknown > 1 && rounds < 7) return false;
  const total = estimateHand(bot, view, bot.seat);
  let lowestOther = Infinity;
  view.players.forEach((_player, seat) => {
    if (seat !== bot.seat) lowestOther = Math.min(lowestOther, estimateHand(bot, view, seat));
  });
  if (total <= 3) return true;
  if (total <= lowestOther - 3) return true;
  return rounds >= 6 && total <= lowestOther;
}

/** The bot's next move on its own turn or in the opening peek, or null if it has none. */
export function botAct(bot, view) {
  const { legal } = view;
  // It gives away the card it thinks is worth the most, unless that card is
  // better than an average card, which is what the draw pile would hand over.
  if (legal.includes('giveCard')) {
    const worst = worstOwnSlot(bot, view);
    if (worst && worst.value > averageCardScore(view.rules)) return { type: 'giveCard', slot: worst.slot };
    return { type: 'keepCards' };
  }
  if (legal.includes('ready')) {
    view.players[bot.seat].slots.forEach((entry, slot) => {
      if (entry?.card) bot.memory[spot(bot.seat, slot)] = entry.card;
    });
    return { type: 'ready' };
  }
  if (legal.includes('draw')) return chooseDraw(bot, view);
  if (legal.includes('place')) return { type: 'place', slot: view.players[bot.seat].slots.findIndex((entry) => !entry) };
  if (legal.includes('discard') || legal.includes('swap')) return decideDrawn(bot, view);
  if (legal.includes('skipPower')) return choosePower(bot, view);
  if (legal.includes('powerDone')) return { type: 'powerDone' };
  if (legal.includes('queenDecide')) {
    const [own, other] = view.power.seen;
    return { type: 'queenDecide', swap: scoreCard(other.card, view.rules) < scoreCard(own.card, view.rules) };
  }
  if (legal.includes('endTurn')) return shouldCall(bot, view) ? { type: 'callJacks' } : { type: 'endTurn' };
  return null;
}

/**
 * The slot the bot believes matches the top discard, or null. It never throws
 * away a card that scores below zero, because keeping one lowers its total.
 */
export function botMatchSlot(bot, view) {
  if (!view.legal.includes('match') || !view.discardTop) return null;
  for (const slot of occupied(view, bot.seat)) {
    const remembered = bot.memory[spot(bot.seat, slot)];
    if (remembered && remembered.rank === view.discardTop.rank && scoreCard(remembered, view.rules) > 0) return slot;
  }
  return null;
}

/**
 * Someone else's card the bot remembers matching the top discard, or null. It only
 * knows cards it has looked at, seen revealed by a wrong match, or watched being
 * taken from the discard pile. A right match means giving up its worst card, which
 * also helps the card's owner, so it leaves the card alone if that wouldn't pay.
 */
export function botMatchOther(bot, view) {
  if (!view.legal.includes('match') || !view.discardTop) return null;
  const given = worstOwnSlot(bot, view)?.value ?? 0;
  for (let seat = 0; seat < view.players.length; seat++) {
    if (seat === bot.seat) continue;
    for (const slot of occupied(view, seat)) {
      const remembered = bot.memory[spot(seat, slot)];
      if (!remembered || remembered.rank !== view.discardTop.rank) continue;
      if (2 * given - scoreCard(remembered, view.rules) > 0) return { seat, slot };
    }
  }
  return null;
}

export function botNoticesMatch(bot) {
  return nextRandom(bot) < bot.reactChance;
}
