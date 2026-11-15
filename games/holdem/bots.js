// Computer players for Hold'em. They see the same view a person would: their
// own two cards, the board and the bets. They judge how strong their hand is,
// weigh it against the price of staying in, and bluff now and then.

import { cardValue, evaluate, nextRandom } from './engine.js';

export function createBot(seat, seed) {
  return { seat, rng: seed | 0 };
}

/** 0 (rubbish) to 1 (aces) for two hole cards. */
function preflopStrength([a, b]) {
  const high = Math.max(cardValue(a), cardValue(b));
  const low = Math.min(cardValue(a), cardValue(b));
  if (high === low) return Math.min(1, 0.5 + high / 28); // 22 = 0.57, AA = 1
  let score = (high - 2) / 24 + (low - 2) / 40; // AK = 0.5 + 0.275
  if (a.suit === b.suit) score += 0.08;
  if (high - low === 1) score += 0.06;
  else if (high - low === 2) score += 0.03;
  return Math.min(0.95, score);
}

/** 0 to 1 for hole cards plus a board of three to five cards. */
function postflopStrength(cards, board) {
  const score = evaluate([...cards, ...board]);
  const boardOnly = board.length >= 5 ? evaluate(board) : null;
  // A hand the board makes by itself is worth little.
  if (boardOnly && boardOnly[0] === score[0] && boardOnly[1] === score[1]) return 0.25;
  if (score[0] >= 4) return 0.97;
  if (score[0] === 3) return 0.9;
  if (score[0] === 2) return 0.8;
  if (score[0] === 1) {
    const top = Math.max(...board.map(cardValue));
    const mine = cards.some((card) => cardValue(card) === score[1]);
    if (!mine) return 0.3; // the pair is on the board
    return score[1] >= top ? 0.68 : 0.5;
  }
  // No pair: a draw is worth something while cards are still to come.
  if (board.length < 5) {
    const suits = {};
    for (const card of [...cards, ...board]) suits[card.suit] = (suits[card.suit] ?? 0) + 1;
    if (Object.values(suits).some((count) => count === 4)) return 0.45;
    const values = [...new Set([...cards, ...board].map(cardValue))].sort((x, y) => x - y);
    for (let i = 0; i + 3 < values.length; i++) if (values[i + 3] - values[i] === 3) return 0.42;
  }
  return 0.12 + Math.max(...cards.map(cardValue)) / 100;
}

/** The bot's move for this view, or null when it isn't its turn. */
export function botAct(bot, view) {
  if (!view.legal.length) return null;
  const me = view.players[bot.seat];
  const strength = view.board.length ? postflopStrength(me.cards, view.board) : preflopStrength(me.cards);
  const can = (type) => view.legal.includes(type);
  const roll = nextRandom(bot);
  const { toCall, pot, bigBlind } = view;
  const price = toCall / Math.max(1, pot + toCall); // share of the pot we'd be paying
  const raiseTo = (fraction) => {
    const want = view.currentBet + Math.max(bigBlind, Math.round(((pot + toCall) * fraction) / 10) * 10);
    return { type: 'raise', to: Math.max(view.minRaiseTo, Math.min(view.maxRaiseTo, want)) };
  };

  if (strength >= 0.9) {
    if (can('raise') && roll < 0.8) return raiseTo(roll < 0.25 ? 1 : 0.6);
    return { type: can('call') ? 'call' : 'check' };
  }
  if (strength >= 0.66) {
    if (can('raise') && toCall <= bigBlind * 2 && roll < 0.55) return raiseTo(0.5);
    if (can('call')) return price < 0.45 || toCall <= bigBlind * 3 ? { type: 'call' } : { type: 'fold' };
    return { type: 'check' };
  }
  if (strength >= 0.4) {
    if (can('check')) return can('raise') && roll < 0.2 ? raiseTo(0.4) : { type: 'check' };
    return price < 0.3 && toCall <= me.chips * 0.25 ? { type: 'call' } : { type: 'fold' };
  }
  if (can('check')) return can('raise') && roll < 0.07 ? raiseTo(0.5) : { type: 'check' };
  // Weak: pay a small price to see a flop, otherwise fold.
  if (!view.board.length && toCall <= bigBlind && strength >= 0.22) return { type: 'call' };
  return { type: 'fold' };
}
