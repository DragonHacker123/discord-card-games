// Computer players for Hearts. They see only their own view. They pass their
// most dangerous cards, duck tricks when they can, and throw the queen of
// spades and high hearts on tricks they aren't going to win.
import { highValue } from '../shared/cards.js';
import { isQueen, pointsOf } from './engine.js';

export function createBot(seat) {
  return { seat };
}

function choosePass(hand) {
  const count = (suit) => hand.filter((card) => card.suit === suit).length;
  const danger = (card) => {
    let score = highValue(card);
    if (card.suit === 'S') score += isQueen(card) ? 40 : highValue(card) > 12 && count('S') < 5 ? 30 : -6;
    if (card.suit === 'H') score += 4;
    if (count(card.suit) <= 2) score += 3;
    return score;
  };
  return hand
    .map((card, index) => ({ index, score: danger(card) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.index);
}

function choosePlay(hand, view) {
  const value = (index) => highValue(hand[index]);
  const lowFirst = (list) => list.slice().sort((a, b) => value(a) - value(b));
  const options = view.playable;
  if (!view.trick.length) return lowFirst(options)[0];
  const lead = view.trick[0].card.suit;
  const follow = options.filter((index) => hand[index].suit === lead);
  if (follow.length) {
    const top = Math.max(...view.trick.filter((play) => play.card.suit === lead).map((play) => highValue(play.card)));
    const under = follow.filter((index) => value(index) < top);
    if (under.length) return under.find((index) => isQueen(hand[index])) ?? lowFirst(under).at(-1);
    // Every card here would be the highest so far.
    const calm = follow.filter((index) => !isQueen(hand[index]));
    const pool = lowFirst(calm.length ? calm : follow);
    const points = view.trick.some((play) => pointsOf(play.card) > 0);
    return view.trick.length === 3 && !points ? pool.at(-1) : pool[0];
  }
  // Can't follow: get rid of the worst card.
  const queen = options.find((index) => isQueen(hand[index]));
  if (queen !== undefined) return queen;
  const hearts = options.filter((index) => hand[index].suit === 'H');
  return lowFirst(hearts.length ? hearts : options).at(-1);
}

export function botAct(bot, view) {
  const hand = view.players[bot.seat].hand;
  if (view.legal.includes('pass')) return { type: 'pass', cards: choosePass(hand) };
  if (view.legal.includes('play')) return { type: 'play', card: choosePlay(hand, view) };
  return null;
}
