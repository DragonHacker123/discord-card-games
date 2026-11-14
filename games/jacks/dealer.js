// The dealer runs one game of Jacks for a table of people and computer players.
// It owns the game state and every timer: computer player moves, the matching
// countdown, the last chance to match, and taking over for someone who has gone
// quiet. It has no network or browser code, so tests can run it on a fake clock.
//
// Nobody outside gets the state. They get view(seat) and events already cut down
// by eventFor(), which is what keeps hidden cards hidden.

import { applyAction, closeLastCall, closeMatchWindow, createGame, eventFor, forfeit, lastCallSeconds, viewFor } from './engine.js';
import { botAct, botMatchOther, botMatchSlot, botNoticesMatch, botObserve, createBot } from './bots.js';

export const BOT_PACE = {
  peek: [900, 2200],
  draw: [800, 1300],
  decide: [900, 1700],
  power: [900, 1400],
  endTurn: [400, 800],
  give: [900, 1600],
};
// A rule, not a pace: computer players wait this long before matching someone else's card.
export const BOT_OTHER_MATCH_MS = [3000, 5000];
export const DEFAULT_TIMEOUTS = { idleMs: 45000, peekMs: 40000, giveMs: 20000 };

const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/**
 * players: [{ id, name, bot }] in seat order.
 * onUpdate(events): called after anything changes. events are unredacted, so
 * pass each one through dealer.redact(event, seat) before sending it anywhere.
 */
export function createDealer({ players, rules, random = Math.random, clock = REAL_CLOCK, timeouts = {}, onUpdate = () => {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const seed = Math.floor(random() * 2 ** 31);
  const state = createGame({ players: players.map(({ id, name }) => ({ id, name })), seed, rules, random });
  const brains = players.map((_player, seat) => createBot(seat, Math.floor(random() * 2 ** 31)));
  const isBot = players.map((player) => Boolean(player.bot));
  const auto = players.map(() => false); // a person's seat being played for them
  const timers = new Set();
  let stopped = false;
  let deadline = null; // { kind: 'match' | 'lastCall', at }
  let turnKey = '';
  let turnTimer = null;
  let giveTimer = null;
  const peekTimers = new Map();

  const jitter = (low, high) => low + random() * (high - low);
  const driven = (seat) => isBot[seat] || auto[seat];

  function later(fn, ms) {
    const id = clock.setTimeout(() => {
      timers.delete(id);
      if (!stopped) fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function cancel(id) {
    if (id === null || id === undefined) return;
    clock.clearTimeout(id);
    timers.delete(id);
  }

  function emit(events) {
    for (const event of events) {
      brains.forEach((brain, seat) => botObserve(brain, eventFor(event, seat)));
      if (event.type === 'matchWindowOpened') openCountdown(event.seconds);
      if (event.type === 'matchWindowClosed' && deadline?.kind === 'match') deadline = null;
      if (event.type === 'lastCall') openLastCall();
      if (event.type === 'finished') deadline = null;
    }
    considerMatches(events);
    schedule();
    try {
      onUpdate(events);
    } catch (error) {
      console.error('Jacks dealer: onUpdate failed', error);
    }
  }

  function apply(seat, action) {
    if (stopped) return { ok: false, error: 'This game has ended.' };
    const result = applyAction(state, seat, action, { random });
    if (result.bug) console.error('Jacks dealer: engine bug', JSON.stringify(action), result.bug);
    if (result.ok) emit(result.events);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  function openCountdown(seconds) {
    // A final discard goes straight to the last chance, which has its own timer.
    if (!state.matchOpen) return;
    deadline = { kind: 'match', at: clock.now() + seconds * 1000 };
    const mine = deadline;
    later(() => {
      if (deadline !== mine || !state.matchOpen) return;
      const result = closeMatchWindow(state);
      if (result.ok) emit(result.events);
    }, seconds * 1000);
  }

  function openLastCall() {
    const seconds = lastCallSeconds(state.rules);
    deadline = { kind: 'lastCall', at: clock.now() + seconds * 1000 };
    const close = () => {
      if (state.phase !== 'lastCall') return;
      // Time can run out while someone is still choosing a card to give.
      if (state.give) {
        later(close, 300);
        return;
      }
      const result = closeLastCall(state);
      if (result.ok) emit(result.events);
    };
    later(close, seconds * 1000);
  }

  /** Plays one move for a seat with its computer brain. */
  function play(seat) {
    const view = viewFor(state, seat);
    const action = botAct(brains[seat], view);
    if (action && apply(seat, action).ok) return;
    // A computer player should never be refused. If one is, keep the game moving.
    const fallback = ['giveCard', 'ready', 'draw', 'discard', 'place', 'skipPower', 'powerDone', 'endTurn'].find((type) => view.legal.includes(type));
    if (!fallback) return;
    const slot = view.players[seat].slots.findIndex((entry) => (fallback === 'place' ? !entry : Boolean(entry)));
    apply(seat, { type: fallback, slot });
  }

  /** Moves now if a computer plays this seat. Otherwise waits, then takes over for a quiet person. */
  function wait(seat, pace, patience, isCurrent) {
    const quick = driven(seat);
    return later(
      () => {
        if (!isCurrent()) return;
        if (!quick) auto[seat] = true;
        play(seat);
        if (!quick) emit([]);
      },
      quick ? jitter(...pace) : patience,
    );
  }

  function schedule() {
    if (stopped || state.phase === 'finished') return;
    if (state.give) {
      // Everyone waits for the card to be handed over, so the turn gets a new timer afterwards.
      cancel(turnTimer);
      turnKey = '';
      if (giveTimer === null) {
        const giver = state.give.seat;
        giveTimer = wait(giver, BOT_PACE.give, limits.giveMs, () => {
          giveTimer = null;
          return state.give?.seat === giver;
        });
      }
      return;
    }
    if (giveTimer !== null) {
      cancel(giveTimer);
      giveTimer = null;
    }
    if (state.phase === 'peek') {
      state.players.forEach((player, seat) => {
        if (player.ready || peekTimers.has(seat)) return;
        peekTimers.set(seat, wait(seat, BOT_PACE.peek, limits.peekMs, () => state.phase === 'peek' && !player.ready));
      });
      return;
    }
    if (state.phase === 'lastCall') return;
    const seat = state.turn;
    const key = `${state.turnCount}:${state.phase}:${state.power?.stage ?? ''}:${state.matchOpen}:${driven(seat)}`;
    if (key === turnKey) return;
    turnKey = key;
    cancel(turnTimer);
    // The draw has to wait for the matching countdown, and gets a new timer when it ends.
    if (state.phase === 'draw' && state.matchOpen) return;
    turnTimer = wait(seat, BOT_PACE[state.phase], limits.idleMs, () => turnKey === key && !state.give);
  }

  function considerMatches(events) {
    if (!events.some((event) => ['swapped', 'discardedDrawn', 'matched', 'gaveCard', 'keptCards'].includes(event.type))) return;
    const windowMs = state.rules.matchMode === 'countdown' ? state.rules.matchSeconds * 1000 : 3000;
    brains.forEach((brain, seat) => {
      if (!driven(seat)) return;
      const view = viewFor(state, seat);
      if (!view.discardTop) return;
      const rank = view.discardTop.rank;
      const count = view.discardCount;
      const stillThere = () => driven(seat) && state.discardPile.length === count && !state.give;
      if (botMatchSlot(brain, view) !== null) {
        if (!botNoticesMatch(brain)) return;
        later(() => {
          if (!stillThere()) return;
          const slot = botMatchSlot(brain, viewFor(state, seat));
          if (slot !== null) apply(seat, { type: 'match', slot });
        }, jitter(700, Math.min(2600, windowMs * 0.8)));
        return;
      }
      if (botMatchOther(brain, view) && botNoticesMatch(brain)) {
        later(() => {
          if (!stillThere()) return;
          const fresh = viewFor(state, seat);
          if (fresh.discardTop?.rank !== rank) return;
          const target = botMatchOther(brain, fresh);
          if (target) apply(seat, { type: 'match', owner: target.seat, slot: target.slot });
        }, jitter(...BOT_OTHER_MATCH_MS));
      }
    });
  }

  schedule();

  return {
    /** A person's own move. Playing again takes their seat back from the computer. */
    act(seat, action) {
      if (!Number.isInteger(seat) || seat < 0 || seat >= players.length || isBot[seat]) return { ok: false, error: 'Unknown player.' };
      const wasAuto = auto[seat];
      auto[seat] = false;
      const result = apply(seat, action);
      if (wasAuto && !result.ok) emit([]);
      return result;
    },
    view: (seat) => viewFor(state, seat),
    redact: (event, seat) => eventFor(event, seat),
    /** Hands a person's seat to the computer (they left), or gives it back. */
    setAuto(seat, on) {
      if (isBot[seat] || auto[seat] === Boolean(on) || stopped) return;
      auto[seat] = Boolean(on);
      // Timers already running for this seat were set with the other patience.
      cancel(peekTimers.get(seat));
      peekTimers.delete(seat);
      if (state.give?.seat === seat) {
        cancel(giveTimer);
        giveTimer = null;
      }
      emit([]);
    },
    /** A person has left for good: their cards go under the discard pile and play passes them by. */
    forfeit(seat) {
      if (stopped || !Number.isInteger(seat) || isBot[seat]) return;
      const result = forfeit(state, seat);
      if (!result.ok) return;
      auto[seat] = false;
      if (state.give === null && giveTimer !== null) {
        cancel(giveTimer);
        giveTimer = null;
      }
      emit(result.events);
    },
    hasLeft: (seat) => Boolean(state.players[seat]?.out),
    isAuto: (seat) => auto[seat],
    isBot: (seat) => isBot[seat],
    phase: () => state.phase,
    finished: () => state.phase === 'finished',
    /** The countdown showing on the table, as time left rather than a clock reading. */
    deadline: () => (deadline ? { kind: deadline.kind, ms: Math.max(0, deadline.at - clock.now()) } : null),
    stop() {
      stopped = true;
      for (const id of timers) clock.clearTimeout(id);
      timers.clear();
    },
    /** Tests only. */
    _state: state,
  };
}
