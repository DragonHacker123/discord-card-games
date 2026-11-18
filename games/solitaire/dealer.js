// The dealer for Solitaire. Unlike the other games nobody takes turns: every
// player works on their own board at once, against one clock. The dealer owns
// the state, moves the computer players at a human sort of pace, and calls
// time. It has the same shape as the other games' dealers. No network or
// browser code.

import { applyAction, createGame, eventFor, forfeit, timeUp, viewFor } from './engine.js';
import { botAct, createBot } from './bots.js';

export const BOT_PACE = [1500, 2800];

const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function createDealer({ players, rules, random = Math.random, clock = REAL_CLOCK, timeouts = {}, onUpdate = () => {} }) {
  const state = createGame({ players: players.map(({ id, name }) => ({ id, name })), seed: Math.floor(random() * 2 ** 31), rules, random });
  const brains = players.map((_player, seat) => createBot(seat));
  const isBot = players.map((player) => Boolean(player.bot));
  const auto = players.map(() => false);
  const botTimers = new Map();
  const limitMs = timeouts.limitMs ?? state.rules.minutes * 60000;
  const endsAt = clock.now() + limitMs;
  let stopped = false;

  function clearAll() {
    for (const id of botTimers.values()) clock.clearTimeout(id);
    botTimers.clear();
    clock.clearTimeout(limitTimer);
  }

  function emit(events) {
    if (state.phase === 'finished') clearAll();
    try {
      onUpdate(events);
    } catch (error) {
      console.error('Solitaire dealer: onUpdate failed', error);
    }
  }

  function apply(seat, action) {
    if (stopped) return { ok: false, error: 'This game has ended.' };
    const result = applyAction(state, seat, action);
    if (result.bug) console.error('Solitaire dealer: engine bug', JSON.stringify(action), result.bug);
    if (result.ok) emit(result.events);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  function botTurn(seat) {
    botTimers.delete(seat);
    if (stopped || state.phase !== 'play' || state.players[seat].done) return;
    const action = botAct(brains[seat], viewFor(state, seat));
    if (!action || !apply(seat, action).ok) apply(seat, { type: 'giveUp' });
    if (!stopped && state.phase === 'play' && !state.players[seat].done) wake(seat);
  }

  function wake(seat) {
    botTimers.set(seat, clock.setTimeout(() => botTurn(seat), BOT_PACE[0] + random() * (BOT_PACE[1] - BOT_PACE[0])));
  }

  const limitTimer = clock.setTimeout(() => {
    if (stopped) return;
    const result = timeUp(state);
    if (result.ok) emit(result.events);
  }, limitMs);
  isBot.forEach((bot, seat) => {
    if (bot) wake(seat);
  });

  return {
    act(seat, action) {
      if (!Number.isInteger(seat) || seat < 0 || seat >= players.length || isBot[seat]) return { ok: false, error: 'Unknown player.' };
      return apply(seat, action);
    },
    view: (seat) => viewFor(state, seat),
    redact: (event, seat) => eventFor(event, seat),
    /** Nobody plays your board for you; being away only shows on the room's list. */
    setAuto(seat, on) {
      if (isBot[seat] || auto[seat] === Boolean(on) || stopped) return;
      auto[seat] = Boolean(on);
      emit([]);
    },
    forfeit(seat) {
      if (stopped || !Number.isInteger(seat) || isBot[seat]) return;
      const result = forfeit(state, seat);
      if (!result.ok) return;
      auto[seat] = false;
      emit(result.events);
    },
    hasLeft: (seat) => Boolean(state.players[seat]?.out),
    isAuto: (seat) => auto[seat],
    isBot: (seat) => isBot[seat],
    phase: () => state.phase,
    finished: () => state.phase === 'finished',
    /** The time left on the clock. */
    deadline: () => (state.phase === 'play' && !stopped ? { kind: 'clock', ms: Math.max(0, endsAt - clock.now()) } : null),
    stop() {
      stopped = true;
      clearAll();
    },
    /** Tests only. */
    _state: state,
  };
}
