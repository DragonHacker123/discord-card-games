// The dealer runs one game of Go Fish: it owns the state, moves the computer
// players, and plays for a person who has gone quiet. It has the same shape as
// the Jacks dealer, so a room can run either. No network or browser code.

import { applyAction, createGame, eventFor, forfeit, viewFor } from './engine.js';
import { botAct, botObserve, createBot } from './bots.js';

export const BOT_PACE = [1500, 2600];
export const DEFAULT_TIMEOUTS = { idleMs: 45000 };

const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function createDealer({ players, random = Math.random, clock = REAL_CLOCK, timeouts = {}, onUpdate = () => {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const state = createGame({ players: players.map(({ id, name }) => ({ id, name })), seed: Math.floor(random() * 2 ** 31), random });
  const brains = players.map((_player, seat) => createBot(seat, Math.floor(random() * 2 ** 31)));
  const isBot = players.map((player) => Boolean(player.bot));
  const auto = players.map(() => false);
  let stopped = false;
  let timer = null;
  let timerKey = '';

  const driven = (seat) => isBot[seat] || auto[seat];

  function emit(events) {
    for (const event of events) brains.forEach((brain, seat) => botObserve(brain, eventFor(event, seat)));
    schedule();
    try {
      onUpdate(events);
    } catch (error) {
      console.error('Go Fish dealer: onUpdate failed', error);
    }
  }

  function apply(seat, action) {
    if (stopped) return { ok: false, error: 'This game has ended.' };
    const result = applyAction(state, seat, action);
    if (result.bug) console.error('Go Fish dealer: engine bug', JSON.stringify(action), result.bug);
    if (result.ok) emit(result.events);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  function play(seat) {
    const view = viewFor(state, seat);
    const action = botAct(brains[seat], view);
    if (action && apply(seat, action).ok) return;
    // A computer player should never be refused. If one is, ask anyone for anything.
    const rank = view.players[seat].hand?.[0]?.rank;
    const target = view.players.findIndex((player, index) => index !== seat && !player.out && player.count > 0);
    if (rank && target !== -1) apply(seat, { type: 'ask', target, rank });
  }

  function schedule() {
    if (stopped || state.phase === 'finished') {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      return;
    }
    const seat = state.turn;
    // Each ask gets a fresh wait, even when the same player goes again.
    const key = `${state.turnCount}:${state.pile.length}:${state.players.map((player) => player.hand.length).join()}:${driven(seat)}`;
    if (key === timerKey) return;
    timerKey = key;
    if (timer !== null) clock.clearTimeout(timer);
    const quick = driven(seat);
    const wait = quick ? BOT_PACE[0] + random() * (BOT_PACE[1] - BOT_PACE[0]) : limits.idleMs;
    timer = clock.setTimeout(() => {
      timer = null;
      if (stopped || timerKey !== key) return;
      if (!quick) auto[seat] = true;
      timerKey = '';
      play(seat);
      if (!quick) emit([]);
    }, wait);
  }

  schedule();

  return {
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
    deadline: () => null,
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
    /** Tests only. */
    _state: state,
  };
}
