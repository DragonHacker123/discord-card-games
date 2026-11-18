// Computer players for Rummy. They see only their own view. They take the
// discard when it completes something, lay down whatever they can, and throw
// away the card least likely to become part of a meld.
import { lowValue, sameCard } from '../shared/cards.js';
import { cardPoints, meldKind } from './engine.js';

export function createBot(seat) {
  return { seat };
}

/** The positions of a meld somewhere in these cards, or null. Longest runs first, then sets. */
export function findMeld(cards) {
  let best = null;
  for (const suit of ['S', 'H', 'D', 'C']) {
    const same = cards.map((card, index) => ({ card, index })).filter((entry) => entry.card.suit === suit).sort((a, b) => lowValue(a.card) - lowValue(b.card));
    let run = [];
    for (const entry of same) {
      if (run.length && lowValue(entry.card) === lowValue(run.at(-1).card) + 1) run.push(entry);
      else run = [entry];
      if (run.length >= 3 && (!best || run.length > best.length)) best = run.map((item) => item.index);
    }
  }
  if (best) return best;
  for (const card of cards) {
    const same = cards.map((other, index) => (other.rank === card.rank ? index : -1)).filter((index) => index !== -1);
    if (same.length >= 3) return same;
  }
  return null;
}

const fits = (card, melds) => melds.findIndex((meld) => meldKind([...meld.cards, card]) !== null);

export function botAct(bot, view) {
  if (!view.legal.length) return null;
  const hand = view.players[bot.seat].hand;
  if (view.legal.includes('draw')) {
    if (view.top) {
      const withTop = [...hand, view.top];
      const meld = findMeld(withTop);
      if ((meld && meld.includes(hand.length)) || fits(view.top, view.melds) !== -1) return { type: 'draw', from: 'discard' };
    }
    return { type: 'draw', from: view.stockCount ? 'stock' : 'discard' };
  }
  const meld = findMeld(hand);
  if (meld) return { type: 'meld', cards: meld };
  for (let index = 0; index < hand.length; index++) {
    const where = fits(hand[index], view.melds);
    if (where !== -1) return { type: 'layoff', card: index, meld: where };
  }
  // Throw the card with the least going for it; among equals, the most expensive.
  const promise = (card) =>
    hand.reduce((sum, other) => {
      if (other === card) return sum;
      if (other.rank === card.rank) return sum + 2;
      const gap = Math.abs(lowValue(other) - lowValue(card));
      return other.suit === card.suit && gap <= 2 ? sum + (3 - gap) : sum;
    }, 0);
  const choices = hand.map((card, index) => ({ index, card })).filter(({ card }) => !view.taken || !sameCard(card, view.taken));
  const pool = choices.length ? choices : hand.map((card, index) => ({ index, card }));
  pool.sort((a, b) => promise(a.card) - promise(b.card) || cardPoints(b.card) - cardPoints(a.card));
  return { type: 'discard', card: pool[0].index };
}
