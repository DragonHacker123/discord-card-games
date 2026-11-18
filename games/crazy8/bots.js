// Computer players for Crazy Eights. They see only their own view. They keep
// their eights for when nothing else fits, and steer play towards the suit
// they hold most of.

export function createBot(seat) {
  return { seat };
}

export function botAct(bot, view) {
  if (!view.legal.length) return null;
  const hand = view.players[bot.seat].hand;
  const counts = { S: 0, H: 0, D: 0, C: 0 };
  for (const card of hand) if (card.rank !== '8') counts[card.suit] += 1;
  const bestSuit = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const options = view.playable.map((index) => ({ index, card: hand[index] }));
  const plain = options.filter(({ card }) => card.rank !== '8').sort((a, b) => counts[b.card.suit] - counts[a.card.suit]);
  if (plain.length) return { type: 'play', card: plain[0].index };
  // Draw before spending an eight, unless it's the way out.
  if (options.length && (hand.length <= 2 || !view.legal.includes('draw'))) return { type: 'play', card: options[0].index, suit: bestSuit };
  if (view.legal.includes('draw')) return { type: 'draw' };
  if (options.length) return { type: 'play', card: options[0].index, suit: bestSuit };
  return { type: 'pass' };
}
