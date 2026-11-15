// The dealer runs one game of Blackjack: it owns the state, moves the computer
// players, plays the house's turn one card at a time, pauses on the payout and
// plays for a person who has gone quiet. It has the same shape as the other
// games' dealers, so a room can run any of them. No network or browser code.

import { MIN_BET, applyAction, createGame, dealerStep, eventFor, forfeit, nextRound, viewFor } from './engine.js';
import { botAct, createBot } from './bots.js';

export const BOT_PACE = { bet: [600, 1600], play: [900, 1600] };
export const DEFAULT_TIMEOUTS = { betMs: 25000, idleMs: 30000, stepMs: 900, payoutMs: 5000 };

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
  const timers = new Set();
  const betTimers = new Map(); // seat -> { id, quick }
  let stopped = false;
  let betRound = 0;
  let betCloses = 0;
  let phaseTimer = null;
  let phaseKey = '';
  let deadline = null; // { kind: 'bet' | 'turn', at }

  const driven = (seat) => isBot[seat] || auto[seat];
  const jitter = ([low, high]) => low + random() * (high - low);

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
    schedule();
    try {
      onUpdate(events);
    } catch (error) {
      console.error('Blackjack dealer: onUpdate failed', error);
    }
  }

  function apply(seat, action) {
    if (stopped) return { ok: false, error: 'This game has ended.' };
    const result = applyAction(state, seat, action, { random });
    if (result.bug) console.error('Blackjack dealer: engine bug', JSON.stringify(action), result.bug);
    if (result.ok) emit(result.events);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /** Plays one move for a seat with its computer brain. */
  function play(seat) {
    const view = viewFor(state, seat);
    const action = botAct(brains[seat], view);
    if (action && apply(seat, action).ok) return;
    // A computer player should never be refused. If one is, do the safe thing.
    if (view.legal.includes('bet')) apply(seat, { type: 'bet', amount: MIN_BET });
    else if (view.legal.includes('stand')) apply(seat, { type: 'stand' });
  }

  function scheduleBets() {
    cancel(phaseTimer);
    phaseTimer = null;
    phaseKey = '';
    if (betRound !== state.round) {
      betRound = state.round;
      betCloses = clock.now() + limits.betMs;
      for (const timer of betTimers.values()) cancel(timer.id);
      betTimers.clear();
    }
    const round = state.round;
    let peopleWaiting = false;
    state.players.forEach((player, seat) => {
      const waiting = player.inRound && !player.out && player.bet === 0;
      const quick = driven(seat);
      const existing = betTimers.get(seat);
      if (waiting && !quick) peopleWaiting = true;
      if (existing && (!waiting || existing.quick !== quick)) {
        cancel(existing.id);
        betTimers.delete(seat);
      }
      if (!waiting || betTimers.has(seat)) return;
      const id = later(
        () => {
          betTimers.delete(seat);
          if (state.phase !== 'bet' || state.round !== round || player.bet !== 0 || player.out) return;
          if (!quick) auto[seat] = true;
          play(seat);
          if (!quick) emit([]);
        },
        quick ? jitter(BOT_PACE.bet) : Math.max(0, betCloses - clock.now()),
      );
      betTimers.set(seat, { id, quick });
    });
    deadline = peopleWaiting ? { kind: 'bet', at: betCloses } : null;
  }

  function schedule() {
    if (stopped || state.phase === 'finished') {
      for (const id of timers) clock.clearTimeout(id);
      timers.clear();
      betTimers.clear();
      phaseTimer = null;
      deadline = null;
      return;
    }
    if (state.phase === 'bet') return scheduleBets();
    for (const timer of betTimers.values()) cancel(timer.id);
    betTimers.clear();

    let key;
    let ms;
    let run;
    let nextDeadline = null;
    if (state.phase === 'play') {
      const seat = state.turn;
      const player = state.players[seat];
      const quick = driven(seat);
      key = `play:${state.round}:${seat}:${player.hand}:${player.hands.length}:${player.hands[player.hand].cards.length}:${quick}`;
      ms = quick ? jitter(BOT_PACE.play) : limits.idleMs;
      if (!quick) nextDeadline = { kind: 'turn', at: clock.now() + ms };
      run = () => {
        if (!quick) auto[seat] = true;
        play(seat);
        if (!quick) emit([]);
      };
    } else if (state.phase === 'dealer') {
      key = `house:${state.round}:${state.house.cards.length}:${state.house.revealed}`;
      ms = limits.stepMs;
      run = () => {
        const result = dealerStep(state, { random });
        if (result.ok) emit(result.events);
      };
    } else {
      key = `payout:${state.round}`;
      ms = limits.payoutMs;
      run = () => {
        const result = nextRound(state);
        if (result.ok) emit(result.events);
      };
    }
    if (key === phaseKey) return undefined;
    phaseKey = key;
    deadline = nextDeadline;
    cancel(phaseTimer);
    phaseTimer = later(() => {
      phaseTimer = null;
      if (phaseKey !== key) return;
      phaseKey = '';
      run();
      // Whatever happened, never leave the table without a timer.
      if (phaseKey === '' && !stopped) schedule();
    }, ms);
    return undefined;
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
      const result = forfeit(state, seat, { random });
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
      for (const id of timers) clock.clearTimeout(id);
      timers.clear();
    },
    /** Tests only. */
    _state: state,
  };
}
