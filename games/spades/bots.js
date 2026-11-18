// Computer players for Spades. They see only their own view. They bid from
// their high cards and their spades, try to win tricks until their side's bid
// is made, and then keep out of the way to avoid bags.
import { highValue } from '../shared/cards.js';

export function createBot(seat) {
  return { seat };
}

function chooseBid(hand) {
  const suit = (letter) => hand.filter((card) => card.suit === letter);
  let tricks = 0;
  for (const letter of ['H', 'D', 'C']) {
    const cards = suit(letter);
    if (cards.some((card) => card.rank === 'A')) tricks += 1;
    if (cards.some((card) => card.rank === 'K') && cards.length >= 2) tricks += 0.7;
    if (cards.some((card) => card.rank === 'Q') && cards.length >= 3 && cards.length <= 4) tricks += 0.3;
  }
  const spades = suit('S');
  for (const card of spades) if (highValue(card) >= 12) tricks += 1;
  // Long spades win by lasting, and spare ones ruff a short suit.
  tricks += Math.max(0, spades.length - 4);
  const lowSpades = spades.filter((card) => highValue(card) < 12).length;
  const short = ['H', 'D', 'C'].filter((letter) => suit(letter).length <= 1).length;
  tricks += Math.min(lowSpades, short) * 0.8;
  return Math.max(1, Math.min(13, Math.round(tricks)));
}

function choosePlay(hand, view, seat) {
  const value = (index) => highValue(hand[index]);
  const lowFirst = (list) => list.slice().sort((a, b) => value(a) - value(b));
  const options = view.playable;
  const partner = (seat + 2) % 4;
  const side = [seat, partner];
  const bid = side.reduce((sum, who) => sum + (view.players[who].bid ?? 0), 0);
  const won = side.reduce((sum, who) => sum + view.players[who].tricks, 0);
  const wantTricks = won < bid && view.players[seat].bid !== 0;
  const plain = options.filter((index) => hand[index].suit !== 'S');

  if (!view.trick.length) {
    if (wantTricks) {
      const aces = plain.filter((index) => hand[index].rank === 'A');
      if (aces.length) return aces[0];
      const top = lowFirst(options).at(-1);
      if (hand[top].suit === 'S' && value(top) >= 13) return top;
    }
    return lowFirst(plain.length ? plain : options)[0];
  }

  // Who is winning so far, and with what?
  const lead = view.trick[0].card.suit;
  let best = view.trick[0];
  for (const play of view.trick.slice(1)) {
    const beats = play.card.suit === best.card.suit ? highValue(play.card) > highValue(best.card) : play.card.suit === 'S';
    if (beats) best = play;
  }
  const beatsBest = (index) => (hand[index].suit === best.card.suit ? value(index) > highValue(best.card) : hand[index].suit === 'S');
  const winners = options.filter(beatsBest);
  const losers = options.filter((index) => !beatsBest(index));
  const partnerWinning = best.seat === partner;
  const last = view.trick.length === 3;

  if (wantTricks && !partnerWinning && winners.length) {
    const following = hand[winners[0]].suit === lead;
    // Last to play wins as cheaply as possible; otherwise play high in the suit, or the lowest spade that ruffs.
    return last || !following ? lowFirst(winners)[0] : lowFirst(winners).at(-1);
  }
  if (losers.length) {
    // Throw the biggest card that can't win, keeping spades back when there's a choice.
    const spare = losers.filter((index) => hand[index].suit !== 'S');
    return wantTricks ? lowFirst(spare.length ? spare : losers)[0] : lowFirst(spare.length ? spare : losers).at(-1);
  }
  return lowFirst(winners)[0];
}

export function botAct(bot, view) {
  const hand = view.players[bot.seat].hand;
  if (view.legal.includes('bid')) return { type: 'bid', amount: chooseBid(hand) };
  if (view.legal.includes('play')) return { type: 'play', card: choosePlay(hand, view, bot.seat) };
  return null;
}
