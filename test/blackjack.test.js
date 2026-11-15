// Blackjack: the rules, what a cheating client could send, the computer players
// and the dealer on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  START_CHIPS, applyAction, createGame, dealerStep, forfeit, handTotal, legalActions, nextRandom, nextRound, normaliseRules, viewFor,
} from '../games/blackjack/engine.js';
import { botAct, createBot } from '../games/blackjack/bots.js';
import { createDealer } from '../games/blackjack/dealer.js';

const PLAYERS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
];
const c = (rank, suit = 'S') => ({ rank, suit });

/** Makes the next cards off the shoe come out in this order. */
function stack(state, ranks) {
  state.shoe.push(...ranks.map((rank) => c(rank)).reverse());
}

/** A one-player game with the bet placed. Deal order: player, house (face up), player, house (hidden). */
function solo(ranks, bet = 100, rules) {
  const state = createGame({ players: PLAYERS.slice(0, 1), seed: 1, rules });
  stack(state, ranks);
  assert.ok(applyAction(state, 0, { type: 'bet', amount: bet }).ok);
  return state;
}

function houseTurn(state) {
  for (let i = 0; i < 30 && state.phase === 'dealer'; i++) assert.ok(dealerStep(state).ok);
  assert.equal(state.phase, 'payout');
}

const chips = (state, seat = 0) => state.players[seat].chips;

test('totals count an ace as 11 until that would bust', () => {
  assert.deepEqual(handTotal([c('A'), c('K')]), { total: 21, soft: true });
  assert.deepEqual(handTotal([c('A'), c('6')]), { total: 17, soft: true });
  assert.deepEqual(handTotal([c('A'), c('6'), c('9')]), { total: 16, soft: false });
  assert.deepEqual(handTotal([c('A'), c('A'), c('9')]), { total: 21, soft: true });
  assert.deepEqual(handTotal([c('K'), c('Q'), c('2')]), { total: 22, soft: false });
});

test('rules from a stranger come out sane', () => {
  for (const input of [null, undefined, 5, 'x', [], {}, { rounds: 'abc' }, { rounds: 1.5 }]) assert.deepEqual(normaliseRules(input), { rounds: 10 });
  assert.deepEqual(normaliseRules({ rounds: 999 }), { rounds: 30 });
  assert.deepEqual(normaliseRules({ rounds: -4 }), { rounds: 1 });
  assert.deepEqual(normaliseRules({ rounds: 5 }), { rounds: 5 });
});

test('everyone bets, then the cards are dealt and the house hides one', () => {
  const state = createGame({ players: PLAYERS, seed: 3 });
  stack(state, ['5', '6', '9', '7', '8', 'K']); // A: 5,7  B: 6,8  house: 9,K
  assert.deepEqual(legalActions(state, 0), ['bet']);
  assert.ok(applyAction(state, 0, { type: 'bet', amount: 50 }).ok);
  assert.equal(state.phase, 'bet');
  assert.equal(applyAction(state, 0, { type: 'bet', amount: 50 }).error, 'You’ve already bet.');
  assert.ok(applyAction(state, 1, { type: 'bet', amount: 20 }).ok);
  assert.equal(state.phase, 'play');
  assert.equal(state.turn, 0);
  assert.equal(chips(state, 0), START_CHIPS - 50);
  const view = viewFor(state, 1);
  assert.deepEqual(view.house.cards, [c('9'), null]);
  assert.equal(view.house.total, null);
  assert.equal(view.players[0].hands[0].total, 12);
  assert.equal(view.shoe, undefined);
  assert.ok(!JSON.stringify(view).includes('"shoe"'));
  assert.equal(applyAction(state, 1, { type: 'hit' }).error, 'It isn’t your turn.');
});

test('a win pays the bet, a loss takes it and a push returns it', () => {
  const win = solo(['10', '7', '9', '8']); // player 19, house 7+8=15, draws
  assert.ok(applyAction(win, 0, { type: 'stand' }).ok);
  stack(win, ['3']); // house 18
  houseTurn(win);
  assert.equal(win.players[0].hands[0].outcome, 'win');
  assert.equal(chips(win), START_CHIPS + 100);

  const lose = solo(['10', '10', '8', '9']); // 18 v 19
  applyAction(lose, 0, { type: 'stand' });
  houseTurn(lose);
  assert.equal(lose.players[0].hands[0].outcome, 'lose');
  assert.equal(chips(lose), START_CHIPS - 100);

  const push = solo(['10', '10', '8', '8']);
  applyAction(push, 0, { type: 'stand' });
  houseTurn(push);
  assert.equal(push.players[0].hands[0].outcome, 'push');
  assert.equal(chips(push), START_CHIPS);
});

test('going over 21 loses at once and the house doesn’t draw', () => {
  const state = solo(['10', '6', '6', '5', 'K']);
  assert.ok(applyAction(state, 0, { type: 'hit' }).ok);
  assert.equal(state.players[0].hands[0].outcome, 'bust');
  assert.equal(state.phase, 'dealer');
  houseTurn(state);
  assert.equal(state.house.cards.length, 2, 'house 11 would normally draw');
  assert.equal(chips(state), START_CHIPS - 100);
});

test('the house draws to 17 and stands, and a house bust pays everyone left', () => {
  const state = solo(['10', '6', '2', '5']); // player 12, house 11
  applyAction(state, 0, { type: 'stand' });
  stack(state, ['2', '3', 'K']); // 13, 16, 26
  houseTurn(state);
  assert.equal(handTotal(state.house.cards).total, 26);
  assert.equal(state.players[0].hands[0].outcome, 'win');

  const soft = solo(['10', 'A', '9', '6']); // house soft 17 stands
  applyAction(soft, 0, { type: 'stand' });
  houseTurn(soft);
  assert.equal(soft.house.cards.length, 2);
  assert.equal(soft.players[0].hands[0].outcome, 'win');
});

test('blackjack pays three to two, and the turn is skipped', () => {
  const state = solo(['A', '9', 'K', '7'], 100);
  assert.equal(state.phase, 'dealer');
  houseTurn(state);
  assert.equal(state.players[0].hands[0].outcome, 'blackjack');
  assert.equal(chips(state), START_CHIPS + 150);
  assert.equal(state.house.cards.length, 2, 'nothing left to beat, so no draw');
});

test('a house blackjack ends the hand before anyone plays', () => {
  const state = solo(['10', 'A', '9', 'K']);
  assert.equal(state.phase, 'payout');
  assert.equal(state.players[0].hands[0].outcome, 'lose');
  assert.equal(viewFor(state, 0).house.total, 21);
  const both = solo(['A', 'K', 'Q', 'A']);
  assert.equal(both.players[0].hands[0].outcome, 'push');
  assert.equal(chips(both), START_CHIPS);
});

test('doubling doubles the bet for exactly one more card', () => {
  const state = solo(['5', '6', '6', '10', '9']); // 11, house 16
  assert.ok(legalActions(state, 0).includes('double'));
  assert.ok(applyAction(state, 0, { type: 'double' }).ok);
  assert.equal(state.players[0].hands[0].bet, 200);
  assert.equal(state.players[0].hands[0].cards.length, 3);
  assert.equal(state.phase, 'dealer');
  stack(state, ['K']);
  houseTurn(state);
  assert.equal(chips(state), START_CHIPS + 200);

  const late = solo(['5', '6', '2', '10', '2']);
  applyAction(late, 0, { type: 'hit' });
  assert.equal(applyAction(late, 0, { type: 'double' }).ok, false);
  const poor = solo(['5', '6', '6', '10']);
  poor.players[0].chips = 50;
  const before = JSON.stringify(poor);
  assert.equal(applyAction(poor, 0, { type: 'double' }).ok, false);
  assert.equal(JSON.stringify(poor), before);
});

test('a pair can be split once into two hands', () => {
  const state = solo(['8', '6', '8', '10', '3', '2']); // 8,8 v 16; split draws 3 and 2
  assert.ok(legalActions(state, 0).includes('split'));
  assert.ok(applyAction(state, 0, { type: 'split' }).ok);
  const player = state.players[0];
  assert.equal(player.hands.length, 2);
  assert.deepEqual(player.hands.map((hand) => handTotal(hand.cards).total), [11, 10]);
  assert.equal(chips(state), START_CHIPS - 200);
  assert.ok(!legalActions(state, 0).includes('split'));
  stack(state, ['K', '9']); // first hand 21 (stands itself), second 19
  assert.ok(applyAction(state, 0, { type: 'hit' }).ok);
  assert.equal(player.hand, 1, 'play moves to the second hand');
  assert.ok(applyAction(state, 0, { type: 'hit' }).ok);
  assert.ok(applyAction(state, 0, { type: 'stand' }).ok);
  stack(state, ['4']); // house 20
  houseTurn(state);
  assert.deepEqual(player.hands.map((hand) => hand.outcome), ['win', 'lose']);
  assert.equal(chips(state), START_CHIPS);

  // Split aces get one card each, and 21 from a split is not blackjack.
  const aces = solo(['A', '6', 'A', '10', 'K', '5']);
  assert.ok(applyAction(aces, 0, { type: 'split' }).ok);
  assert.equal(aces.phase, 'dealer');
  stack(aces, ['4']); // house 20
  houseTurn(aces);
  assert.deepEqual(aces.players[0].hands.map((hand) => hand.outcome), ['win', 'lose']);
  assert.equal(chips(aces), START_CHIPS);
});

test('the game runs for the set number of hands, then the most chips wins', () => {
  const state = createGame({ players: PLAYERS, seed: 12, rules: { rounds: 3 } });
  for (let round = 1; round <= 3; round++) {
    assert.equal(state.round, round);
    applyAction(state, 0, { type: 'bet', amount: 10 });
    applyAction(state, 1, { type: 'bet', amount: 500 });
    for (let i = 0; i < 20 && state.phase === 'play'; i++) assert.ok(applyAction(state, state.turn, { type: 'stand' }).ok);
    if (state.phase === 'dealer') houseTurn(state);
    assert.equal(nextRound(state).ok, true);
  }
  assert.equal(state.phase, 'finished');
  const best = Math.max(...state.players.map((player) => player.chips));
  assert.deepEqual(state.results.winners, state.players.map((p, i) => (p.chips === best ? i : -1)).filter((i) => i !== -1));
  assert.equal(nextRound(state).ok, false);
  assert.equal(applyAction(state, 0, { type: 'bet', amount: 10 }).ok, false);
});

test('a player with no chips sits out, and the game ends when nobody can bet', () => {
  const state = createGame({ players: PLAYERS, seed: 2 });
  state.players[0].chips = 10;
  stack(state, ['10', '10', '10', '6', '10', '9']); // A 16 loses to 19; B 20 wins
  applyAction(state, 0, { type: 'bet', amount: 10 });
  applyAction(state, 1, { type: 'bet', amount: 10 });
  applyAction(state, 0, { type: 'stand' });
  applyAction(state, 1, { type: 'stand' });
  houseTurn(state);
  nextRound(state);
  assert.equal(state.players[0].inRound, false);
  assert.deepEqual(legalActions(state, 0), []);
  assert.equal(applyAction(state, 0, { type: 'bet', amount: 10 }).error, 'You’re out of chips.');
  assert.ok(applyAction(state, 1, { type: 'bet', amount: 10 }).ok);
  assert.notEqual(state.phase, 'bet', 'the hand starts without the broke player');

  const broke = solo(['10', '10', '6', '9'], 500);
  broke.players[0].chips = 0;
  applyAction(broke, 0, { type: 'stand' });
  houseTurn(broke);
  nextRound(broke);
  assert.equal(broke.phase, 'finished');
});

test('leaving loses your bet, passes your turn and stops you winning', () => {
  const state = createGame({ players: PLAYERS, seed: 4 });
  stack(state, ['5', '6', '9', '7', '8', '7']);
  applyAction(state, 0, { type: 'bet', amount: 100 });
  applyAction(state, 1, { type: 'bet', amount: 100 });
  assert.equal(state.turn, 0);
  assert.ok(forfeit(state, 0).ok);
  assert.equal(state.turn, 1);
  assert.equal(chips(state, 0), START_CHIPS - 100);
  assert.equal(applyAction(state, 0, { type: 'hit' }).ok, false);
  assert.equal(forfeit(state, 0).ok, false);
  applyAction(state, 1, { type: 'stand' });
  stack(state, ['K']);
  houseTurn(state);
  state.round = state.rules.rounds;
  nextRound(state);
  assert.deepEqual(state.results.winners, [1]);
  assert.equal(state.results.rows.at(-1).out, true);

  // Leaving while the others wait on your bet starts the hand; the last one leaving ends the game.
  const waiting = createGame({ players: PLAYERS, seed: 4 });
  applyAction(waiting, 1, { type: 'bet', amount: 10 });
  assert.ok(forfeit(waiting, 0).ok);
  assert.notEqual(waiting.phase, 'bet');
  assert.ok(forfeit(waiting, 1).ok);
  assert.equal(waiting.phase, 'finished');
  assert.deepEqual(waiting.results.winners, []);
});

test('bad moves are refused and change nothing', () => {
  const state = createGame({ players: PLAYERS, seed: 6 });
  const before = JSON.stringify(state);
  const bad = [
    null, undefined, 5, 'bet', [], {}, { type: 5 }, { type: 'toString' }, { type: '__proto__' }, { type: 'bet' },
    { type: 'bet', amount: 5 }, { type: 'bet', amount: 15 }, { type: 'bet', amount: 510 }, { type: 'bet', amount: -10 },
    { type: 'bet', amount: '50' }, { type: 'bet', amount: 10.5 }, { type: 'bet', amount: NaN }, { type: 'bet', amount: Infinity },
    { type: 'bet', amount: [50] }, { type: 'hit' }, { type: 'stand' }, { type: 'double' }, { type: 'split' },
  ];
  for (const action of bad) assert.equal(applyAction(state, 0, action).ok, false, JSON.stringify(action));
  for (const seat of [-1, 2, '0', null, {}, 'length', 1.5]) assert.equal(applyAction(state, seat, { type: 'bet', amount: 10 }).ok, false);
  assert.equal(JSON.stringify(state), before);
  state.players[0].chips = 30;
  assert.equal(applyAction(state, 0, { type: 'bet', amount: 50 }).error, 'You don’t have that many chips.');
});

test('computer players get through whole games; chips only move by the rules', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const count = 1 + (seed % 6);
    const players = Array.from({ length: count }, (_x, i) => ({ id: `p${i}`, name: `P${i}` }));
    const state = createGame({ players, seed, rules: { rounds: 8 } });
    const bots = players.map((_p, seat) => createBot(seat, seed * 17 + seat));
    const dice = { rng: seed };
    let steps = 0;
    while (state.phase !== 'finished') {
      assert.ok(++steps < 5000, `seed ${seed} never ended`);
      if (state.phase === 'dealer') assert.ok(dealerStep(state).ok);
      else if (state.phase === 'payout') {
        for (const player of state.players) {
          assert.ok(Number.isInteger(player.chips) && player.chips >= 0, `seed ${seed}: chips ${player.chips}`);
          for (const hand of player.hands) assert.ok(['win', 'lose', 'push', 'bust', 'blackjack'].includes(hand.outcome));
        }
        assert.ok(nextRound(state).ok);
      } else {
        const seat = state.phase === 'bet' ? state.players.findIndex((player) => player.inRound && player.bet === 0) : state.turn;
        // Now and then, a nonsense move first: it must be refused without a trace.
        if (nextRandom(dice) < 0.2) {
          const before = JSON.stringify(state);
          const result = applyAction(state, seat, { type: ['bet', 'hit', 'split', 'double'][Math.floor(nextRandom(dice) * 4)], amount: 7 });
          assert.equal(result.bug, undefined);
          if (!result.ok) assert.equal(JSON.stringify(state), before);
          if (result.ok) continue;
        }
        const action = botAct(bots[seat], viewFor(state, seat));
        assert.ok(action, `seed ${seed}: no move in ${state.phase}`);
        const result = applyAction(state, seat, action);
        assert.ok(result.ok, `seed ${seed}: ${JSON.stringify(action)} ${result.error}`);
        assert.equal(result.bug, undefined);
      }
    }
    assert.ok(state.results.rows.length === count);
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
    pending: () => pending.size,
  };
}

function seeded(start) {
  const holder = { rng: start };
  return () => nextRandom(holder);
}

test('the dealer runs a whole game of computer players on its own', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: [{ id: 'a', name: 'A', bot: true }, { id: 'b', name: 'B', bot: true }], rules: { rounds: 4 }, random: seeded(5), clock });
  for (let i = 0; i < 500 && !dealer.finished(); i++) clock.advance(1000);
  assert.ok(dealer.finished());
  assert.equal(dealer._state.round, 4);
  assert.equal(clock.pending(), 0, 'no timers left running');
  dealer.stop();
});

test('the dealer bets and stands for a quiet person, and hands the seat back when they move', () => {
  const clock = fakeClock();
  const dealer = createDealer({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', bot: true }],
    rules: { rounds: 3 },
    random: seeded(11),
    clock,
    timeouts: { betMs: 5000, idleMs: 4000 },
  });
  assert.equal(dealer.deadline().kind, 'bet');
  assert.ok(dealer.deadline().ms <= 5000);
  clock.advance(4000);
  assert.equal(dealer.phase(), 'bet', 'the table waits for the person');
  assert.equal(dealer.isAuto(0), false);
  clock.advance(1500);
  assert.equal(dealer.isAuto(0), true);
  assert.notEqual(dealer.phase(), 'bet');
  // Run to the next betting round, then bet as the person.
  for (let i = 0; i < 200 && !(dealer.phase() === 'bet' && dealer._state.round === 2); i++) clock.advance(250);
  assert.equal(dealer._state.round, 2);
  if (dealer.view(0).legal.includes('bet')) {
    assert.ok(dealer.act(0, { type: 'bet', amount: 20 }).ok);
    assert.equal(dealer.isAuto(0), false);
  }
  assert.equal(dealer.act(1, { type: 'bet', amount: 10 }).ok, false, 'nobody plays a computer seat');
  dealer.forfeit(0);
  assert.ok(dealer.hasLeft(0));
  for (let i = 0; i < 400 && !dealer.finished(); i++) clock.advance(1000);
  assert.ok(dealer.finished(), 'the computer player finishes the game alone');
  dealer.stop();
});
