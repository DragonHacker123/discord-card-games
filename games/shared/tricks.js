// What trick-taking games share: who wins a trick, and which cards follow suit.
import { highValue } from './cards.js';

/** The position in plays ([{ seat, card }], in the order played) of the card that wins. */
export function trickWinner(plays, trump = null) {
  let best = 0;
  for (let index = 1; index < plays.length; index++) {
    const card = plays[index].card;
    const leader = plays[best].card;
    if ((card.suit === trump) !== (leader.suit === trump)) {
      if (card.suit === trump) best = index;
    } else if (card.suit === leader.suit && highValue(card) > highValue(leader)) best = index;
  }
  return best;
}

/** The cards in a hand that follow the led suit, by position; every card when the hand has none of it. */
export function following(hand, lead) {
  const same = [];
  hand.forEach((card, index) => {
    if (card.suit === lead) same.push(index);
  });
  return same.length ? same : hand.map((_card, index) => index);
}
