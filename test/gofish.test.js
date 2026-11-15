// Go Fish: the rules, what a cheating client could send, the computer players
// and the dealer on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, eventFor, forfeit, legalActions, nextRandom, startCards, viewFor } from '../games/gofish/engine.js';
import { botAct, botObserve, createBot } from '../games/gofish/bots.js';
import { createDealer } from '../games/gofish/dealer.js';

const PLAYERS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];
const card = (rank, suit = 'S') => ({ rank, suit });

function checkSound(state) {
  const cards = [...state.pile, ...state.players.flatMap((player) => player.hand)];
  const booked = state.players.reduce((sum, player) => sum + player.books.length, 0);
  assert.equal(cards.length + booked * 4, 52, 'a card was lost or copied');
  assert.equal(new Set(cards.map((c) => c.rank + c.suit)).size, cards.length);
  for (const player of state.players) {
    for (const rank of new Set(player.hand.map((c) => c.rank))) {
      assert.ok(player.hand.filter((c) => c.rank === rank).length < 4, 'a book was left in a hand');
    }
  }
}

/** A game with hands set by the test. Seat 0 is to play. */
function rigged(hands, pile = []) {
  const state = createGame({ players: PLAYERS.slice(0, hands.length), seed: 1 });
  state.players.forEach((player, seat) => {
    player.hand = hands[seat].map((c) => ({ ...c }));
    player.books = [];
  });
  state.pile = pile.map((c) => ({ ...c }));
  state.turn = 0;
  return state;
}

test('the deal gives seven cards to two or three players and five to more', () => {
  assert.equal(startCards(2), 7);
  assert.equal(startCards(3), 7);
  assert.equal(startCards(4), 5);
  for (const count of [2, 3, 4, 6]) {
    const players = Array.from({ length: count }, (_x, i) => ({ id: `p${i}`, name: `P${i}` }));
    const state = createGame({ players, seed: 7 });
    checkSound(state);
    assert.equal(state.players.reduce((sum, p) => sum + p.hand.length + p.books.length * 4, 0), count * startCards(count));
  }
  assert.throws(() => createGame({ players: PLAYERS.slice(0, 1) }));
  assert.deepEqual(createGame({ players: PLAYERS, seed: 4 }), createGame({ players: PLAYERS, seed: 4 }));
});

test('a right ask takes every card of that rank and you go again', () => {
  const state = rigged([[card('7'), card('K')], [card('7', 'H'), card('7', 'D'), card('2')], [card('9')]], [card('3')]);
  const result = applyAction(state, 0, { type: 'ask', target: 1, rank: '7' });
  assert.ok(result.ok);
  assert.deepEqual(result.events.map((e) => e.type), ['asked', 'gave']);
  assert.equal(result.events[1].count, 2);
  assert.equal(state.players[0].hand.filter((c) => c.rank === '7').length, 3);
  assert.deepEqual(state.players[1].hand, [card('2')]);
  assert.equal(state.turn, 0);
  assert.deepEqual(legalActions(state, 0), ['ask']);
});

test('a wrong ask means go fish, and the turn moves on', () => {
  const state = rigged([[card('7'), card('K')], [card('2')], [card('9')]], [card('5'), card('3')]);
  const result = applyAction(state, 0, { type: 'ask', target: 1, rank: '7' });
  assert.ok(result.ok);
  assert.deepEqual(result.events.map((e) => e.type), ['asked', 'goFish', 'turn']);
  assert.equal(state.players[0].hand.length, 3);
  assert.equal(state.turn, 1);
  assert.deepEqual(state.last, { seat: 0, target: 1, rank: '7', got: 0, lucky: false });
  // Only the player who drew sees the card.
  const fished = result.events[1];
  assert.deepEqual(eventFor(fished, 0).card, card('3'));
  assert.equal(eventFor(fished, 1).card, null);
  assert.equal(eventFor(fished, -1).card, null);
});

test('fishing the rank you asked for is shown and you go again', () => {
  const state = rigged([[card('7'), card('K')], [card('2')], [card('9')]], [card('5'), card('7', 'H')]);
  const result = applyAction(state, 0, { type: 'ask', target: 1, rank: '7' });
  assert.ok(result.ok);
  assert.equal(state.turn, 0);
  assert.equal(result.events[1].lucky, true);
  assert.deepEqual(eventFor(result.events[1], 2).card, card('7', 'H'));
});

test('four of a rank is laid down as a book', () => {
  const state = rigged([[card('7'), card('7', 'H'), card('7', 'D'), card('K')], [card('7', 'C'), card('2')], [card('9')]], [card('3')]);
  const result = applyAction(state, 0, { type: 'ask', target: 1, rank: '7' });
  assert.ok(result.ok);
  assert.deepEqual(state.players[0].books, ['7']);
  assert.deepEqual(state.players[0].hand, [card('K')]);
  assert.ok(result.events.some((e) => e.type === 'book' && e.seat === 0 && e.rank === '7'));
});

test('a player with no cards draws one, or is passed over when the pile is empty', () => {
  // Seat 0 gives away its last card's rank by booking, then draws to carry on.
  const state = rigged([[card('7'), card('7', 'H'), card('7', 'D')], [card('7', 'C'), card('2')], [card('9')]], [card('3'), card('4')]);
  const result = applyAction(state, 0, { type: 'ask', target: 1, rank: '7' });
  assert.ok(result.ok);
  assert.deepEqual(state.players[0].hand, [card('4')]);
  assert.equal(state.turn, 0);
  assert.ok(result.events.some((e) => e.type === 'drew' && e.seat === 0));

  const dry = rigged([[card('7'), card('K')], [], [card('9'), card('K', 'H')]], []);
  assert.equal(applyAction(dry, 0, { type: 'ask', target: 1, rank: '7' }).error, 'They have no cards.');
  assert.ok(applyAction(dry, 0, { type: 'ask', target: 2, rank: '7' }).ok);
  assert.equal(dry.turn, 2, 'the player with no cards and no pile is skipped');
});

test('bad asks are refused and change nothing', () => {
  const state = rigged([[card('7'), card('K')], [card('2')], [card('9')]], [card('5')]);
  const before = JSON.stringify(state);
  const bad = [
    null, undefined, 5, 'ask', [], {}, { type: 'draw' }, { type: 'ask' },
    { type: 'ask', target: 0, rank: '7' }, { type: 'ask', target: 3, rank: '7' }, { type: 'ask', target: '1', rank: '7' },
    { type: 'ask', target: 1.5, rank: '7' }, { type: 'ask', target: 'length', rank: '7' }, { type: 'ask', target: 1, rank: '2' },
    { type: 'ask', target: 1, rank: 7 }, { type: 'ask', target: 1, rank: 'JOKER' }, { type: 'ask', target: 1, rank: '__proto__' },
    { type: 'ask', target: 1, rank: ['7'] }, { type: 'ask', target: { seat: 1 }, rank: '7' },
  ];
  for (const action of bad) assert.equal(applyAction(state, 0, action).ok, false, JSON.stringify(action));
  assert.equal(applyAction(state, 1, { type: 'ask', target: 0, rank: '2' }).ok, false, 'not your turn');
  for (const seat of [-1, 3, '0', null, {}, 'length']) assert.equal(applyAction(state, seat, { type: 'ask', target: 1, rank: '7' }).ok, false);
  assert.equal(JSON.stringify(state), before);
});

test('nobody sees another hand', () => {
  const state = createGame({ players: PLAYERS, seed: 3 });
  const mine = viewFor(state, 0);
  assert.ok(Array.isArray(mine.players[0].hand));
  assert.equal(mine.players[1].hand, null);
  assert.equal(mine.players[1].count, state.players[1].hand.length);
  const watcher = viewFor(state, -1);
  assert.ok(watcher.players.every((player) => player.hand === null));
  assert.deepEqual(watcher.legal, []);
});

test('leaving puts your cards under the draw pile and play passes you by', () => {
  const state = createGame({ players: PLAYERS, seed: 11 });
  const leaver = state.turn;
  const mine = [...state.players[leaver].hand];
  assert.ok(forfeit(state, leaver).ok);
  assert.deepEqual(state.pile.slice(0, mine.length), mine);
  assert.notEqual(state.turn, leaver);
  assert.equal(applyAction(state, leaver, { type: 'ask', target: state.turn, rank: 'A' }).ok, false);
  assert.equal(forfeit(state, leaver).ok, false);
  checkSound(state);
  const asker = state.turn;
  assert.equal(applyAction(state, asker, { type: 'ask', target: leaver, rank: state.players[asker].hand[0].rank }).ok, false);
  // A second leaver ends it, and the one who stayed wins.
  const other = [0, 1, 2].find((seat) => seat !== leaver && seat !== asker);
  assert.ok(forfeit(state, other).ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [asker]);
});

test('computer players finish every game with all thirteen books, and never get refused', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const count = 2 + (seed % 5);
    const players = Array.from({ length: count }, (_x, i) => ({ id: `p${i}`, name: `P${i}` }));
    const state = createGame({ players, seed });
    const bots = players.map((_p, seat) => createBot(seat, seed * 31 + seat));
    let steps = 0;
    while (state.phase !== 'finished') {
      assert.ok(++steps < 3000, `seed ${seed} never ended`);
      const seat = state.turn;
      const action = botAct(bots[seat], viewFor(state, seat));
      assert.ok(action, `seed ${seed}: no move`);
      const result = applyAction(state, seat, action);
      assert.ok(result.ok, `seed ${seed}: ${result.error}`);
      assert.equal(result.bug, undefined);
      for (const event of result.events) bots.forEach((bot, viewer) => botObserve(bot, eventFor(event, viewer)));
      checkSound(state);
    }
    assert.equal(state.players.reduce((sum, p) => sum + p.books.length, 0), 13);
    assert.ok(state.results.winners.length >= 1);
    const best = Math.max(...state.players.map((p) => p.books.length));
    assert.deepEqual(state.results.winners, state.players.map((p, i) => (p.books.length === best ? i : -1)).filter((i) => i !== -1));
  }
});

test('random hostile moves never throw, never change a refused game and never lose a card', () => {
  const NASTY = [undefined, null, true, 0, 1, 2, 5, -1, 1.5, NaN, '', '1', 'length', '__proto__', {}, [], [1], 'A', '7', 'K', '10'];
  for (let seed = 1; seed <= 40; seed++) {
    const dice = { rng: seed * 991 };
    const pick = (items) => items[Math.floor(nextRandom(dice) * items.length)];
    const state = createGame({ players: PLAYERS, seed });
    for (let step = 0; step < 600 && state.phase !== 'finished'; step++) {
      const seat = nextRandom(dice) < 0.85 ? Math.floor(nextRandom(dice) * 3) : pick(NASTY);
      const action = nextRandom(dice) < 0.5 && state.players[seat]?.hand?.length
        ? { type: 'ask', target: Math.floor(nextRandom(dice) * 3), rank: pick(state.players[seat].hand).rank }
        : { type: pick(['ask', 'ask', 'draw', '__proto__']), target: pick(NASTY), rank: pick(NASTY) };
      const before = JSON.stringify(state);
      let result;
      assert.doesNotThrow(() => {
        result = applyAction(state, seat, action);
      });
      assert.equal(result.bug, undefined, result.bug);
      if (!result.ok) assert.equal(JSON.stringify(state), before);
      checkSound(state);
      if (nextRandom(dice) < 0.004) forfeit(state, Math.floor(nextRandom(dice) * 3));
    }
  }
});

function fakeClock() {
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
    /** Runs timers in order until the time is reached. */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

test('the dealer plays a whole game of computer players on its own', () => {
  const clock = fakeClock();
  let seed = 5;
  const random = () => nextRandom({ get rng() { return seed; }, set rng(v) { seed = v; } });
  const dealer = createDealer({ players: PLAYERS.map((p) => ({ ...p, bot: true })), random, clock });
  for (let i = 0; i < 2000 && !dealer.finished(); i++) clock.advance(3000);
  assert.ok(dealer.finished());
  dealer.stop();
});

test('the dealer plays for a person who goes quiet, and hands the seat back when they move', () => {
  const clock = fakeClock();
  let seed = 9;
  const random = () => nextRandom({ get rng() { return seed; }, set rng(v) { seed = v; } });
  const updates = [];
  const dealer = createDealer({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', bot: true }],
    random,
    clock,
    timeouts: { idleMs: 1000 },
    onUpdate: (events) => updates.push(events),
  });
  for (let i = 0; i < 400 && !dealer.isAuto(0) && !dealer.finished(); i++) clock.advance(500);
  assert.ok(dealer.isAuto(0), 'the quiet player was taken over');
  // Wait for their turn, then move as them.
  for (let i = 0; i < 400 && dealer.view(0).turn !== 0 && !dealer.finished(); i++) clock.advance(200);
  if (!dealer.finished()) {
    const view = dealer.view(0);
    const rank = view.players[0].hand[0].rank;
    assert.ok(dealer.act(0, { type: 'ask', target: 1, rank }).ok);
    assert.equal(dealer.isAuto(0), false);
  }
  assert.equal(dealer.act(1, { type: 'ask', target: 0, rank: 'A' }).ok, false, 'nobody plays a computer seat');
  dealer.forfeit(0);
  assert.ok(dealer.finished());
  assert.ok(dealer.hasLeft(0));
  dealer.stop();
});
