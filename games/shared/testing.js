// Helpers for the tests of the games that use the shared dealer. Nothing here
// is part of the running game.
import { nextRandom } from './cards.js';

/** A clock that only moves when a test says so. */
export function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      pending.set(nextId, { fn, at: now + ms });
      return nextId++;
    },
    clearTimeout: (id) => pending.delete(id),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    pending: () => pending.size,
  };
}

export function seeded(start) {
  const holder = { rng: start };
  return () => nextRandom(holder);
}

export const named = (count) => Array.from({ length: count }, (_x, index) => ({ id: `p${index}`, name: `P${index}` }));

/**
 * Plays a whole game with computer players, straight through the engine.
 * check(state) runs after every move. Returns the finished state.
 */
export function playOut(engine, bots, { players, rules, seed = 1, check = () => {}, limit = 20000 }) {
  const state = engine.createGame({ players, seed, rules });
  const brains = players.map((_player, seat) => bots.createBot(seat, seed + seat));
  check(state);
  for (let moves = 0; state.phase !== 'finished'; moves++) {
    if (moves > limit) throw new Error(`The game didn't finish in ${limit} moves.`);
    const acting = engine.actors(state);
    let result;
    if (acting.length) {
      const seat = acting[0];
      const action = bots.botAct(brains[seat], engine.viewFor(state, seat));
      result = action ? engine.applyAction(state, seat, action) : { ok: false };
      if (!result.ok) {
        const safe = engine.anyLegal(state, seat);
        result = engine.applyAction(state, seat, safe);
        if (!result.ok) throw new Error(`anyLegal was refused: ${JSON.stringify(safe)} ${result.error} ${result.bug ?? ''}`);
        throw new Error(`A computer player's move was refused: ${JSON.stringify(action)}`);
      }
    } else {
      result = engine.step(state);
      if (!result.ok) throw new Error('Nobody to act and nothing to step.');
    }
    if (bots.botObserve) for (const event of result.events) brains.forEach((brain, seat) => bots.botObserve(brain, engine.eventFor(event, seat)));
    check(state);
  }
  return state;
}

/** Things no engine should accept, whatever the game. */
export const NONSENSE = [null, undefined, 7, 'play', [], {}, { type: 7 }, { type: 'toString' }, { type: '__proto__' }, { type: 'constructor' }, { type: 'nope' }];
