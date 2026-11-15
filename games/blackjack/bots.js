// Computer players for Blackjack. They see the same view a person would and
// play close to the usual basic strategy, with bets that vary a little.

import { cardValue, nextRandom } from './engine.js';

export function createBot(seat, seed) {
  return { seat, rng: seed | 0 };
}

function chooseBet(bot, view) {
  const me = view.players[bot.seat];
  const options = [10, 20, 20, 50, 50, 100].filter((amount) => amount <= me.chips && amount <= view.maxBet);
  return options.length ? options[Math.floor(nextRandom(bot) * options.length)] : view.minBet;
}

function choosePlay(view, seat) {
  const me = view.players[seat];
  const hand = me.hands[me.hand];
  const up = cardValue(view.house.cards[0]); // 2 to 11
  const can = (type) => view.legal.includes(type);
  const { total, soft } = hand;

  if (can('split')) {
    const rank = hand.cards[0].rank;
    if (rank === 'A' || rank === '8') return 'split';
    if (rank === '9' && up <= 9 && up !== 7) return 'split';
    if (['2', '3', '7'].includes(rank) && up <= 7) return 'split';
    if (rank === '6' && up <= 6) return 'split';
  }
  if (can('double')) {
    if (!soft && total === 11 && up !== 11) return 'double';
    if (!soft && total === 10 && up <= 9) return 'double';
    if (!soft && total === 9 && up >= 3 && up <= 6) return 'double';
    if (soft && total >= 13 && total <= 18 && (up === 5 || up === 6)) return 'double';
  }
  if (soft) {
    if (total <= 17) return 'hit';
    if (total === 18) return up >= 9 ? 'hit' : 'stand';
    return 'stand';
  }
  if (total <= 11) return 'hit';
  if (total === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
  if (total <= 16) return up <= 6 ? 'stand' : 'hit';
  return 'stand';
}

/** The bot's move for this view, or null when it has nothing to do. */
export function botAct(bot, view) {
  if (view.legal.includes('bet')) return { type: 'bet', amount: chooseBet(bot, view) };
  if (view.legal.includes('stand')) return { type: choosePlay(view, bot.seat) };
  return null;
}
