// One dealer for every game where players take turns (or all act at once, as
// when passing cards). It owns the state, moves the computer players, runs the
// short pauses a game asks for, and plays for a person who has gone quiet or
// left. No network or browser code, so tests can run it on a fake clock.
//
// What a game's engine must provide:
//   createGame({ players, seed, rules, random })
//   applyAction(state, seat, action, { random })  -> { ok, events } | { ok: false, error }
//   forfeit(state, seat, { random })              -> the same
//   viewFor(state, seat), eventFor(event, seat)
//   actors(state)   -> the seats that have to act now
//   pause(state)    -> when nobody has to act: milliseconds to wait before step(), or 0
//   step(state, { random })                       -> moves on after a pause
//   anyLegal(state, seat) -> a move that is always accepted, for when a bot is refused
// and its bots: createBot(seat, seed), botAct(bot, view), and optionally botObserve(bot, event).

const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export function makeDealer(engine, bots, { name, pace = [900, 1700], idleMs = 30000 }) {
  return function createDealer({ players, rules, random = Math.random, clock = REAL_CLOCK, timeouts = {}, onUpdate = () => {} }) {
    const patience = timeouts.idleMs ?? idleMs;
    const state = engine.createGame({ players: players.map(({ id, name: playerName }) => ({ id, name: playerName })), seed: Math.floor(random() * 2 ** 31), rules, random });
    const brains = players.map((_player, seat) => bots.createBot(seat, Math.floor(random() * 2 ** 31)));
    const isBot = players.map((player) => Boolean(player.bot));
    const auto = players.map(() => false);
    const seatTimers = new Map(); // seat -> { id, key, at }
    let pauseTimer = null;
    let pauseKey = '';
    let version = 0; // goes up whenever the game changes, so stale timers can tell
    let stopped = false;

    // A computer plays the seat of a computer player, of someone away, and of someone who left mid-game.
    const driven = (seat) => isBot[seat] || auto[seat] || Boolean(state.players[seat]?.out);

    function clearAll() {
      for (const timer of seatTimers.values()) clock.clearTimeout(timer.id);
      seatTimers.clear();
      if (pauseTimer !== null) clock.clearTimeout(pauseTimer);
      pauseTimer = null;
      pauseKey = '';
    }

    function emit(events) {
      version += 1;
      if (bots.botObserve) for (const event of events) brains.forEach((brain, seat) => bots.botObserve(brain, engine.eventFor(event, seat)));
      schedule();
      try {
        onUpdate(events);
      } catch (error) {
        console.error(`${name} dealer: onUpdate failed`, error);
      }
    }

    function apply(seat, action) {
      if (stopped) return { ok: false, error: 'This game has ended.' };
      const result = engine.applyAction(state, seat, action, { random });
      if (result.bug) console.error(`${name} dealer: engine bug`, JSON.stringify(action), result.bug);
      if (result.ok) emit(result.events);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }

    function play(seat) {
      const action = bots.botAct(brains[seat], engine.viewFor(state, seat));
      if (action && apply(seat, action).ok) return;
      const safe = engine.anyLegal(state, seat);
      if (safe) apply(seat, safe);
    }

    function schedule() {
      if (stopped || state.phase === 'finished') return clearAll();
      const acting = engine.actors(state);
      for (const [seat, timer] of seatTimers) {
        if (acting.includes(seat) && timer.key === `${version}:${driven(seat)}`) continue;
        clock.clearTimeout(timer.id);
        seatTimers.delete(seat);
      }
      for (const seat of acting) {
        if (seatTimers.has(seat)) continue;
        const quick = driven(seat);
        const key = `${version}:${quick}`;
        const ms = quick ? pace[0] + random() * (pace[1] - pace[0]) : patience;
        const id = clock.setTimeout(() => {
          if (stopped || seatTimers.get(seat)?.key !== key) return;
          seatTimers.delete(seat);
          if (!quick) auto[seat] = true;
          play(seat);
          if (!quick) emit([]);
          else if (!stopped && !seatTimers.size && pauseTimer === null) schedule();
        }, ms);
        seatTimers.set(seat, { id, key, at: quick ? null : clock.now() + ms });
      }
      if (acting.length) {
        if (pauseTimer !== null) clock.clearTimeout(pauseTimer);
        pauseTimer = null;
        pauseKey = '';
        return undefined;
      }
      const key = `pause:${version}`;
      if (key === pauseKey) return undefined;
      pauseKey = key;
      if (pauseTimer !== null) clock.clearTimeout(pauseTimer);
      pauseTimer = clock.setTimeout(() => {
        pauseTimer = null;
        if (stopped || pauseKey !== key) return;
        pauseKey = '';
        const result = engine.step(state, { random });
        if (result.ok) emit(result.events);
        else if (!stopped) schedule();
      }, Math.max(1, engine.pause(state)));
      return undefined;
    }

    schedule();

    return {
      /** A person's own move. Playing again takes their seat back from the computer. */
      act(seat, action) {
        if (!Number.isInteger(seat) || seat < 0 || seat >= players.length || isBot[seat]) return { ok: false, error: 'Unknown player.' };
        if (state.players[seat].out) return { ok: false, error: 'You’ve left this game.' };
        const wasAuto = auto[seat];
        auto[seat] = false;
        const result = apply(seat, action);
        if (wasAuto && !result.ok) emit([]);
        return result;
      },
      view: (seat) => engine.viewFor(state, seat),
      redact: (event, seat) => engine.eventFor(event, seat),
      setAuto(seat, on) {
        if (isBot[seat] || auto[seat] === Boolean(on) || stopped) return;
        auto[seat] = Boolean(on);
        emit([]);
      },
      forfeit(seat) {
        if (stopped || !Number.isInteger(seat) || isBot[seat]) return;
        const result = engine.forfeit(state, seat, { random });
        if (!result.ok) return;
        auto[seat] = false;
        emit(result.events);
      },
      hasLeft: (seat) => Boolean(state.players[seat]?.out),
      isAuto: (seat) => auto[seat],
      isBot: (seat) => isBot[seat],
      phase: () => state.phase,
      finished: () => state.phase === 'finished',
      /** The countdown for whoever is being waited on, as time left rather than a clock reading. */
      deadline() {
        const times = [...seatTimers.values()].map((timer) => timer.at).filter((at) => at !== null);
        return times.length ? { kind: 'turn', ms: Math.max(0, Math.min(...times) - clock.now()) } : null;
      },
      stop() {
        stopped = true;
        clearAll();
      },
      /** Tests only. */
      _state: state,
    };
  };
}
