// The dealer on a fake clock: whole games in a few milliseconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDealer } from '../games/jacks/dealer.js';
import { nextRandom } from '../games/jacks/engine.js';

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const queue = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      queue.set(id, { at: now + Math.max(0, ms), fn, id });
      return id;
    },
    clearTimeout: (id) => queue.delete(id),
    /** Runs timers in order until none are left, the time is up or stop() says so. */
    run(untilMs, stop = () => false) {
      for (;;) {
        if (stop()) return;
        const due = [...queue.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due || due.at > untilMs) {
          now = Math.max(now, untilMs);
          return;
        }
        queue.delete(due.id);
        now = due.at;
        due.fn();
      }
    },
    pending: () => queue.size,
  };
}

function seeded(seed) {
  const holder = { rng: seed };
  return () => nextRandom(holder);
}

const people = (count, bots) => [
  ...Array.from({ length: count }, (_x, i) => ({ id: `u${i}`, name: `Person ${i}`, bot: false })),
  ...Array.from({ length: bots }, (_x, i) => ({ id: `b${i}`, name: `Bot ${i}`, bot: true })),
];

const HOUR = 3600 * 1000;

test('computer players alone play a whole game to the end', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const clock = fakeClock();
    const rules = { matchMode: seed % 2 ? 'countdown' : 'nextDiscard', drawFromDiscard: seed % 3 === 0 };
    const dealer = createDealer({ players: people(0, 2 + (seed % 5)), rules, random: seeded(seed), clock });
    clock.run(HOUR, () => dealer.finished());
    assert.ok(dealer.finished(), `seed ${seed} stuck in ${dealer.phase()}`);
    assert.equal(dealer.deadline(), null);
    dealer.stop();
    assert.equal(clock.pending(), 0);
  }
});

test('people who never touch anything get played for, so the game still ends', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const clock = fakeClock();
    const dealer = createDealer({ players: people(2, 1), rules: { matchMode: seed % 2 ? 'countdown' : 'nextDiscard' }, random: seeded(seed), clock });
    assert.equal(dealer.isAuto(0), false);
    clock.run(HOUR, () => dealer.finished());
    assert.ok(dealer.finished(), `seed ${seed} stuck in ${dealer.phase()}`);
    assert.equal(dealer.isAuto(0), true);
  }
});

test('playing a move yourself takes your seat back', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: people(2, 0), random: seeded(4), clock });
  dealer.setAuto(0, true);
  assert.equal(dealer.isAuto(0), true);
  clock.run(5000);
  assert.equal(dealer.view(0).players[0].ready, true, 'the computer got seat 0 ready');
  assert.equal(dealer.act(1, { type: 'ready' }).ok, true);
  assert.equal(dealer.isAuto(1), false);
  dealer.act(0, { type: 'nonsense' });
  assert.equal(dealer.isAuto(0), false);
});

test('a person can’t move for another seat or for a computer player', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: people(1, 1), random: seeded(2), clock });
  assert.equal(dealer.act(1, { type: 'ready' }).ok, false);
  assert.equal(dealer.act(7, { type: 'ready' }).ok, false);
  assert.equal(dealer.act('0', { type: 'ready' }).ok, false);
  assert.equal(dealer.act(0, { type: 'ready' }).ok, true);
});

test('nothing a player is sent ever shows a card they shouldn’t see', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const clock = fakeClock();
    let dealer = null;
    const check = (events) => {
      if (!dealer) return;
      const state = dealer._state;
      for (let seat = -1; seat < state.players.length; seat++) {
        const view = dealer.view(seat);
        if (view.phase !== 'finished') {
          view.players.forEach((player, owner) => {
            player.slots.forEach((entry, slot) => {
              if (!entry?.card) return;
              assert.ok(view.phase === 'peek' && owner === seat && slot >= 2 && !player.ready, `seat ${seat} saw a card in a view`);
            });
          });
          if (view.drawn) assert.ok(view.turn === seat || view.drawnFrom === 'discard');
          if (view.power?.seen.length) assert.equal(view.power.seat, seat);
        }
        assert.equal(view.drawPile, undefined);
        for (const event of events) {
          const shown = dealer.redact(event, seat);
          assert.equal(shown.secret, undefined);
          if (event.secret && event.secret.to !== seat) {
            assert.equal(shown.drawnCard, undefined);
            assert.equal(shown.cards, undefined);
            if (event.type === 'drew') assert.equal(shown.card, undefined);
          }
        }
      }
    };
    dealer = createDealer({ players: people(1, 3), rules: { drawFromDiscard: seed % 2 === 0 }, random: seeded(seed), clock, onUpdate: check });
    clock.run(HOUR, () => dealer.finished());
    assert.ok(dealer.finished());
  }
});

test('the countdown is reported as time left', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: people(0, 3), rules: { matchMode: 'countdown', matchSeconds: 5 }, random: seeded(11), clock });
  clock.run(HOUR, () => dealer.deadline() !== null);
  const first = dealer.deadline();
  assert.equal(first.kind, 'match');
  assert.equal(first.ms, 5000);
  dealer.stop();
});

test('a person who leaves forfeits, and the others finish the game without them', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const clock = fakeClock();
    const dealer = createDealer({ players: people(1, 2), random: seeded(seed), clock });
    clock.run(seed * 1500);
    dealer.forfeit(0);
    assert.equal(dealer.hasLeft(0), true);
    assert.equal(dealer.act(0, { type: 'ready' }).ok, false);
    clock.run(HOUR, () => dealer.finished());
    assert.ok(dealer.finished(), `seed ${seed} stuck in ${dealer.phase()}`);
    const { results } = dealer.view(-1);
    assert.ok(!results.winners.includes(0));
    assert.equal(dealer._state.drawPile.length + dealer._state.discardPile.length + dealer._state.players.flatMap((p) => p.slots.filter(Boolean)).length, 54);
  }
});
