// Computer players for Go Fish. They only ever see what a person in their seat
// would: their own view and the events everyone at the table sees.
//
// A bot remembers who is known to hold a rank (they asked for it or were given
// it) and who is known not to (they said "go fish"), and forgets a little.

import { nextRandom } from './engine.js';

export function createBot(seat, seed) {
  return {
    seat,
    rng: seed | 0,
    holds: {}, // rank -> seats known to hold it
    lacks: {}, // rank -> seats known not to hold it
  };
}

const list = (map, rank) => (map[rank] ??= []);
const add = (map, rank, seat) => {
  if (!list(map, rank).includes(seat)) map[rank].push(seat);
};
const drop = (map, rank, seat) => {
  if (map[rank]) map[rank] = map[rank].filter((other) => other !== seat);
};

export function botObserve(bot, event) {
  if (event.type === 'asked') {
    add(bot.holds, event.rank, event.seat);
    drop(bot.lacks, event.rank, event.seat);
  } else if (event.type === 'gave') {
    drop(bot.holds, event.rank, event.from);
    add(bot.lacks, event.rank, event.from);
    add(bot.holds, event.rank, event.to);
  } else if (event.type === 'goFish' || event.type === 'drew') {
    // They hold a new card, so what they lacked is no longer certain.
    for (const rank of Object.keys(bot.lacks)) drop(bot.lacks, rank, event.seat);
    if (event.type === 'goFish' && event.lucky && event.card) add(bot.holds, event.card.rank, event.seat);
  } else if (event.type === 'book') {
    delete bot.holds[event.rank];
    delete bot.lacks[event.rank];
  } else if (event.type === 'left') {
    for (const map of [bot.holds, bot.lacks]) for (const rank of Object.keys(map)) drop(map, rank, event.seat);
  }
  // A go-fish answer also says the player asked doesn't hold the rank.
  if (event.type === 'asked') bot.pending = { target: event.target, rank: event.rank };
  if (event.type === 'goFish' && bot.pending) add(bot.lacks, bot.pending.rank, bot.pending.target);
  if (event.type === 'gave' || event.type === 'goFish') bot.pending = null;
}

/** The bot's move for this view, or null when it isn't its turn. */
export function botAct(bot, view) {
  if (!view.legal.includes('ask')) return null;
  const me = view.players[bot.seat];
  const targets = view.players.map((player, seat) => ({ player, seat })).filter(({ player, seat }) => seat !== bot.seat && !player.out && player.count > 0);
  if (!me.hand?.length || !targets.length) return null;
  const counts = {};
  for (const card of me.hand) counts[card.rank] = (counts[card.rank] ?? 0) + 1;
  const ranks = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

  // Ask someone known to hold a rank we hold. Now and then the bot forgets.
  if (nextRandom(bot) > 0.15) {
    for (const rank of ranks) {
      const known = targets.find(({ seat }) => bot.holds[rank]?.includes(seat));
      if (known) return { type: 'ask', target: known.seat, rank };
    }
  }
  // Otherwise ask for the rank we hold most of, from someone not known to lack it.
  for (const rank of ranks) {
    const open = targets.filter(({ seat }) => !bot.lacks[rank]?.includes(seat));
    if (open.length) return { type: 'ask', target: open[Math.floor(nextRandom(bot) * open.length)].seat, rank };
  }
  return { type: 'ask', target: targets[Math.floor(nextRandom(bot) * targets.length)].seat, rank: ranks[0] };
}
