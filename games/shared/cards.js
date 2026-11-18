// Small pieces every newer game uses: the deck, a seeded shuffle and index checks.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const SUIT_NAMES = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };

/** A small seeded generator, so tests and bug reports replay exactly. */
export function nextRandom(holder) {
  holder.rng = (holder.rng + 0x6d2b79f5) | 0;
  let t = holder.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const isIndex = (value, length) => Number.isInteger(value) && value >= 0 && value < length;

export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  return deck;
}

/** Shuffles in place. roll() returns a number in [0, 1). */
export function shuffle(cards, roll) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(roll() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/** The engine's own random source: the caller's if given, else the seeded one in the state. */
export const roller = (state, random) => (random ? random : () => nextRandom(state));

/** Ace high: 2 is 2, ace is 14. */
export const highValue = (card) => (card.rank === 'A' ? 14 : RANKS.indexOf(card.rank) + 1);
/** Ace low: ace is 1, king is 13. */
export const lowValue = (card) => RANKS.indexOf(card.rank) + 1;

/** Sorts a hand by suit, then by value. */
export function sortHand(hand, value = highValue, suitOrder = ['S', 'H', 'C', 'D']) {
  hand.sort((a, b) => suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit) || value(a) - value(b));
  return hand;
}

export const sameCard = (a, b) => a.rank === b.rank && a.suit === b.suit;
