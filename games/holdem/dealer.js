// The dealer runs one game of Hold'em: it owns the state, moves the computer
// players, deals out the board when everyone is all in, pauses after each hand
// and checks or folds for a person who has gone quiet. It has the same shape
// as the other games' dealers. No network or browser code.

import { applyAction, createGame, eventFor, forfeit, nextHand, step, viewFor } from './engine.js';
import { botAct, createBot } from './bots.js';

export const BOT_PACE = [1000, 2000];
export const DEFAULT_TIMEOUTS = { idleMs: 30000, awayMs: 1200, stepMs: 1300, showdownMs: 6000, foldWinMs: 3000 };

const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function createDealer({ players, rules, random = Math.random, clock = REAL_CLOCK, timeouts = {}, onUpdate = () => {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const state = createGame({ players: players.map(({ id, name }) => ({ id, name })), seed: Math.floor(random() * 2 ** 31), rules, random });
  const brains = players.map((_player, seat) => createBot(seat, Math.floor(random() * 2 ** 31)));
  const isBot = players.map((player) => Boolean(player.bot));
  const auto = players.map(() => false);
  let stopped = false;
  let timer = null;
  let timerKey = '';
  let deadline = null;

  function emit(events) {
    schedule();
    try {
      onUpdate(events);
    } catch (error) {
      console.error('Hold’em dealer: onUpdate failed', error);
    }
  }

  function apply(seat, action) {
    if (stopped) return { ok: false, error: 'This game has ended.' };
    const result = applyAction(state, seat, action);
    if (result.bug) console.error('Hold’em dealer: engine bug', JSON.stringify(action), result.bug);
    if (result.ok) emit(result.events);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /** A computer player uses its brain. A person who is away checks when it's free and folds when it isn't. */
  function play(seat) {
    const view = viewFor(state, seat);
    const safe = { type: view.legal.includes('check') ? 'check' : 'fold' };
    const action = isBot[seat] ? (botAct(brains[seat], view) ?? safe) : safe;
    if (!apply(seat, action).ok) apply(seat, safe);
  }

  function schedule() {
    if (stopped || state.phase === 'finished') {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      deadline = null;
      return;
    }
    let key;
    let ms;
    let run;
    let nextDeadline = null;
    if (state.phase === 'play') {
      const seat = state.turn;
      const person = !isBot[seat] && !auto[seat];
      key = `play:${state.hand}:${state.street}:${seat}:${state.currentBet}:${state.players.map((player) => player.said).join()}:${person}`;
      ms = isBot[seat] ? BOT_PACE[0] + random() * (BOT_PACE[1] - BOT_PACE[0]) : auto[seat] ? limits.awayMs : limits.idleMs;
      if (person) nextDeadline = { kind: 'turn', at: clock.now() + ms };
      run = () => {
        if (person) auto[seat] = true;
        play(seat);
        if (person) emit([]);
      };
    } else if (state.phase === 'runout') {
      key = `runout:${state.hand}:${state.board.length}`;
      ms = limits.stepMs;
      run = () => {
        const result = step(state);
        if (result.ok) emit(result.events);
      };
    } else {
      key = `showdown:${state.hand}`;
      ms = state.last?.shown.length ? limits.showdownMs : limits.foldWinMs;
      run = () => {
        const result = nextHand(state, { random });
        if (result.ok) emit(result.events);
      };
    }
    if (key === timerKey) return;
    timerKey = key;
    deadline = nextDeadline;
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      if (stopped || timerKey !== key) return;
      timerKey = '';
      run();
      // Whatever happened, never leave the table without a timer.
      if (timerKey === '' && !stopped) schedule();
    }, ms);
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
    /** The countdown showing on the table, as time left rather than a clock reading. */
    deadline: () => (deadline ? { kind: deadline.kind, ms: Math.max(0, deadline.at - clock.now()) } : null),
    stop() {
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
    /** Tests only. */
    _state: state,
  };
}
