// Texas Hold'em: hand ranking, betting, side pots, what a cheating client could
// send, the computer players and the dealer on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BIG_BLIND, START_CHIPS, applyAction, compareScores, createGame, evaluate, forfeit, handName, legalActions, nextHand, nextRandom, normaliseRules, step, viewFor,
} from '../games/holdem/engine.js';
import { botAct, createBot } from '../games/holdem/bots.js';
import { createDealer } from '../games/holdem/dealer.js';

const named = (count) => Array.from({ length: count }, (_x, i) => ({ id: `p${i}`, name: `P${i}` }));
/** "AS KH 10D" -> cards */
const cards = (text) => text.split(' ').map((code) => ({ rank: code.slice(0, -1), suit: code.slice(-1) }));
const score = (text) => evaluate(cards(text));
const act = (state, type, extra = {}) => {
  const result = applyAction(state, state.turn, { type, ...extra });
  assert.ok(result.ok, `${type}: ${result.error}`);
  return result;
};
const total = (state) => state.players.reduce((sum, player) => sum + player.chips + player.total, 0);

/** Gives chosen hole cards and a chosen board. The board is dealt off the end of the deck. */
function rig(state, holes, board) {
  holes.forEach((text, seat) => {
    state.players[seat].cards = cards(text);
  });
  const [f1, f2, f3, t, r] = cards(board);
  state.deck.push(r, t, f3, f2, f1);
}

test('hands rank in the right order', () => {
  const ladder = [
    'AS KD 9H 7C 4S 3D 2H', // high card
    '2S 2D 9H 7C 4S 3D KH', // pair
    '2S 2D 9H 9C 4S 3D KH', // two pair
    '2S 2D 2H 9C 4S 3D KH', // three of a kind
    '5S 6D 7H 8C 9S 2D KH', // straight
    '2S 9S JS 4S KS 3D KH', // flush
    '2S 2D 2H 9C 9S 3D KH', // full house
    '2S 2D 2H 2C 9S 3D KH', // four of a kind
    '5S 6S 7S 8S 9S 2D KH', // straight flush
  ];
  const scores = ladder.map(score);
  scores.forEach((value, index) => assert.equal(value[0], index, ladder[index]));
  for (let i = 1; i < scores.length; i++) assert.ok(compareScores(scores[i], scores[i - 1]) > 0);
  assert.equal(handName(score('10S JS QS KS AS 2D 3H')), 'Royal flush');
  assert.equal(handName(score('2S 2D 9H 9C 4S 3D KH')), 'Two pair');
});

test('ties are broken by the right cards', () => {
  assert.deepEqual(score('AS 2D 3H 4C 5S 9D KH'), [4, 5], 'the ace plays low in a wheel');
  assert.ok(compareScores(score('2S 3D 4H 5C 6S'), score('AS 2D 3H 4C 5S')) > 0, 'a six-high straight beats the wheel');
  assert.ok(compareScores(score('AS AD KH 7C 4S'), score('AH AC QH JC 10S')) > 0, 'kicker');
  assert.equal(compareScores(score('AS AD KH 7C 4S 3D 2H'), score('AH AC KD 7D 4D 3C 2S')), 0);
  assert.deepEqual(score('KS KD KH 9C 9S 9D 2H'), [6, 13, 9], 'two sets make the bigger full house');
  assert.deepEqual(score('KS KD 9C 9S 5D 5H AH'), [2, 13, 9, 14], 'three pairs keep the best two and the best kicker');
  assert.deepEqual(score('2S 9S JS 4S KS AS 3S').slice(0, 2), [5, 14], 'a flush uses its five highest');
  assert.deepEqual(score('7S 7D 7H 7C 2S 2D AH'), [7, 7, 14]);
});

test('rules from a stranger come out sane', () => {
  for (const input of [null, undefined, 5, 'x', [], {}, { hands: 'abc' }, { hands: 2.5 }]) assert.deepEqual(normaliseRules(input), { hands: 20 });
  assert.deepEqual(normaliseRules({ hands: 9999 }), { hands: 100 });
  assert.deepEqual(normaliseRules({ hands: 0 }), { hands: 1 });
});

test('the blinds are posted and the player after the big blind acts first', () => {
  const state = createGame({ players: named(4), seed: 3 });
  const { button } = state;
  const small = (button + 1) % 4;
  const big = (button + 2) % 4;
  assert.equal(state.players[small].bet, 10);
  assert.equal(state.players[big].bet, 20);
  assert.equal(state.turn, (button + 3) % 4);
  assert.equal(state.players.every((player) => player.cards.length === 2), true);
  assert.equal(total(state), 4 * START_CHIPS);

  const two = createGame({ players: named(2), seed: 3 });
  assert.equal(two.players[two.button].bet, 10, 'heads-up, the button is the small blind');
  assert.equal(two.turn, two.button, 'and acts first before the flop');
  act(two, 'call');
  assert.equal(two.turn, 1 - two.button, 'the big blind gets the option');
  assert.deepEqual(legalActions(two, two.turn), ['fold', 'check', 'raise']);
  act(two, 'check');
  assert.equal(two.street, 'flop');
  assert.equal(two.board.length, 3);
  assert.equal(two.turn, 1 - two.button, 'after the flop the big blind acts first');
});

test('a hand played to the river goes to the best five cards', () => {
  const state = createGame({ players: named(3), seed: 8 });
  rig(state, ['AS AD', 'KS KD', '7C 2H'], '3S 8D JC 4H 9S');
  for (let i = 0; i < 3; i++) act(state, state.players[state.turn].bet < state.currentBet ? 'call' : 'check');
  assert.equal(state.street, 'flop');
  for (const street of ['turn', 'river']) {
    for (let i = 0; i < 3; i++) act(state, 'check');
    assert.equal(state.street, street);
  }
  for (let i = 0; i < 3; i++) act(state, 'check');
  assert.equal(state.phase, 'showdown');
  assert.deepEqual(state.last.pots, [{ amount: 60, winners: [0] }]);
  assert.equal(state.last.hands[0], 'Pair');
  assert.equal(state.players[0].chips, START_CHIPS + 40);
  assert.equal(total(state), 3 * START_CHIPS);
  // Everyone at the showdown shows; before it, nobody's cards are visible to others.
  assert.deepEqual(viewFor(state, 2).players[0].cards, cards('AS AD'));
});

test('when everyone else folds, the last player wins without showing', () => {
  const state = createGame({ players: named(3), seed: 5 });
  const first = state.turn;
  act(state, 'raise', { to: 60 });
  act(state, 'fold');
  act(state, 'fold');
  assert.equal(state.phase, 'showdown');
  assert.deepEqual(state.last, { pots: [{ amount: 50, winners: [first] }], shown: [], hands: {} }, 'the unmatched 40 goes back and isn’t counted as won');
  assert.equal(state.players[first].chips, START_CHIPS + 30);
  const other = (first + 1) % 3;
  assert.deepEqual(viewFor(state, other).players[first].cards, [null, null]);
});

test('raises have a minimum, and a raise reopens the betting', () => {
  const state = createGame({ players: named(3), seed: 5 });
  const before = JSON.stringify(state);
  for (const to of [20, 30, 39, 0, -40, 1.5, '60', null, NaN, Infinity, START_CHIPS + 1]) {
    assert.equal(applyAction(state, state.turn, { type: 'raise', to }).ok, false, String(to));
  }
  assert.equal(applyAction(state, state.turn, { type: 'check' }).ok, false);
  assert.equal(JSON.stringify(state), before);
  const raiser = state.turn;
  act(state, 'raise', { to: 60 }); // a raise of 40
  assert.equal(applyAction(state, state.turn, { type: 'raise', to: 90 }).error, 'Raise to at least 100.');
  act(state, 'raise', { to: 100 });
  act(state, 'call');
  assert.equal(state.turn, raiser, 'the first raiser has to answer the re-raise');
  act(state, 'call');
  assert.equal(state.street, 'flop');
  assert.equal(state.players.every((player) => player.bet === 0), true);
  assert.equal(viewFor(state, 0).pot, 300);
});

test('going all in for less makes a side pot the short stack can’t win', () => {
  const state = createGame({ players: named(3), seed: 8 });
  // Seat 0 is short and has the best hand; seat 1 beats seat 2.
  state.players[0].chips = 100 - state.players[0].bet;
  rig(state, ['AS AD', 'KS KD', 'QC QH'], '3S 8D JC 4H 9S');
  const started = total(state);
  for (let guard = 0; guard < 12 && state.phase === 'play'; guard++) {
    const seat = state.turn;
    const player = state.players[seat];
    if (seat === 0) act(state, 'raise', { to: player.bet + player.chips });
    else if (player.bet < state.currentBet) act(state, 'call');
    else if (state.street === 'preflop' || state.currentBet > 0) act(state, 'check');
    else act(state, 'raise', { to: 200 });
  }
  while (state.phase === 'runout') assert.ok(step(state).ok);
  assert.equal(state.phase, 'showdown');
  assert.deepEqual(state.last.pots, [
    { amount: 300, winners: [0] },
    { amount: 1200, winners: [1] }, // 200 each on the flop, turn and river
  ]);
  assert.equal(state.players[0].chips, 300);
  assert.equal(total(state), started);
});

test('with everyone all in the cards are turned over and the board is dealt out', () => {
  const state = createGame({ players: named(2), seed: 4 });
  rig(state, ['AS AD', 'KS KD'], '3S 8D JC 4H 9S');
  act(state, 'raise', { to: START_CHIPS });
  const caller = state.turn;
  assert.deepEqual(legalActions(state, caller), ['fold', 'call']);
  act(state, 'call');
  assert.equal(state.phase, 'runout');
  assert.deepEqual(viewFor(state, -1).players.map((player) => player.cards.length), [2, 2]);
  assert.ok(viewFor(state, -1).players.every((player) => player.cards.every(Boolean)), 'both hands face up');
  assert.equal(applyAction(state, 0, { type: 'check' }).ok, false);
  const lengths = [];
  while (state.phase === 'runout') {
    assert.ok(step(state).ok);
    lengths.push(state.board.length);
  }
  assert.deepEqual(lengths, [3, 4, 5, 5]);
  assert.equal(state.players[0].chips, 2 * START_CHIPS);
  // The loser is out of chips, so the game ends there.
  assert.ok(nextHand(state).ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [0]);
});

test('equal hands split the pot', () => {
  const state = createGame({ players: named(2), seed: 4 });
  rig(state, ['AS 2D', 'AH 2C'], 'KS KD QC QH 9S');
  act(state, 'call');
  act(state, 'check');
  for (let i = 0; i < 6; i++) act(state, 'check');
  assert.deepEqual(state.last.pots, [{ amount: 40, winners: [0, 1] }]);
  assert.deepEqual(state.players.map((player) => player.chips), [START_CHIPS, START_CHIPS]);
});

test('nobody sees another player’s cards or the deck', () => {
  const state = createGame({ players: named(3), seed: 6 });
  const view = viewFor(state, 1);
  assert.equal(view.players[1].cards.every(Boolean), true);
  assert.deepEqual(view.players[0].cards, [null, null]);
  assert.ok(!JSON.stringify(view).includes('deck'));
  const watcher = viewFor(state, -1);
  assert.ok(watcher.players.every((player) => player.cards.every((card) => card === null)));
  assert.deepEqual(watcher.legal, []);
});

test('the button moves on, and the game ends after the set number of hands', () => {
  const state = createGame({ players: named(3), seed: 9, rules: { hands: 3 } });
  const buttons = [];
  for (let hand = 1; hand <= 3; hand++) {
    assert.equal(state.hand, hand);
    buttons.push(state.button);
    act(state, 'fold');
    act(state, 'fold');
    assert.equal(state.phase, 'showdown');
    assert.equal(nextHand(state).ok, true);
  }
  assert.deepEqual(buttons, [buttons[0], (buttons[0] + 1) % 3, (buttons[0] + 2) % 3]);
  assert.equal(state.phase, 'finished');
  assert.equal(total(state), 3 * START_CHIPS);
  assert.equal(nextHand(state).ok, false);
});

test('leaving folds your hand, leaves your bet in the pot and stops you winning', () => {
  const state = createGame({ players: named(3), seed: 5 });
  const leaver = state.turn;
  act(state, 'raise', { to: 100 });
  assert.ok(forfeit(state, leaver).ok);
  assert.equal(state.players[leaver].folded, true);
  assert.equal(forfeit(state, leaver).ok, false);
  act(state, 'fold');
  assert.equal(state.phase, 'showdown', 'one player left wins the pot');
  assert.equal(state.last.pots[0].amount, 130);
  nextHand(state);
  assert.equal(state.players[leaver].inHand, false);
  assert.equal(applyAction(state, leaver, { type: 'fold' }).ok, false);
  const [a, b] = [0, 1, 2].filter((seat) => seat !== leaver);
  // Leaving on your turn passes it on; the last opponent leaving ends the game.
  const turn = state.turn;
  assert.ok(forfeit(state, turn).ok);
  assert.equal(state.phase, 'showdown');
  nextHand(state);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [turn === a ? b : a]);
});

test('computer players get through whole games; no chip is ever lost or made', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const count = 2 + (seed % 5);
    const state = createGame({ players: named(count), seed, rules: { hands: 12 } });
    const bots = named(count).map((_p, seat) => createBot(seat, seed * 13 + seat));
    const dice = { rng: seed * 3 };
    let steps = 0;
    while (state.phase !== 'finished') {
      assert.ok(++steps < 6000, `seed ${seed} never ended`);
      assert.equal(total(state), count * START_CHIPS, `seed ${seed}: chips changed`);
      if (state.phase === 'runout') assert.ok(step(state).ok);
      else if (state.phase === 'showdown') {
        assert.equal(state.last.pots.reduce((sum, pot) => sum + pot.amount, 0) > 0, true);
        assert.ok(nextHand(state).ok);
      } else {
        const seat = state.turn;
        // Now and then, a hostile move first: refused without a trace, or a legal one.
        if (nextRandom(dice) < 0.25) {
          const before = JSON.stringify(state);
          const junk = [{ type: 'raise', to: Math.floor(nextRandom(dice) * 3000) - 500 }, { type: 'check' }, { type: 'call' }, { type: 'raise', to: 'all' }, { type: 'bet' }, null];
          const result = applyAction(state, nextRandom(dice) < 0.5 ? seat : (seat + 1) % count, junk[Math.floor(nextRandom(dice) * junk.length)]);
          assert.equal(result.bug, undefined, result.bug);
          if (!result.ok) assert.equal(JSON.stringify(state), before);
          else continue;
        }
        const action = botAct(bots[seat], viewFor(state, seat));
        assert.ok(action, `seed ${seed}: no move`);
        const result = applyAction(state, seat, action);
        assert.ok(result.ok, `seed ${seed}: ${JSON.stringify(action)} ${result.error}`);
        assert.equal(result.bug, undefined);
        for (const player of state.players) assert.ok(player.chips >= 0 && Number.isInteger(player.chips));
      }
    }
    assert.equal(state.players.reduce((sum, player) => sum + player.chips, 0), count * START_CHIPS);
    assert.ok(state.results.winners.length >= 1);
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
  const dealer = createDealer({ players: named(4).map((p) => ({ ...p, bot: true })), rules: { hands: 6 }, random: seeded(7), clock });
  for (let i = 0; i < 2000 && !dealer.finished(); i++) clock.advance(1000);
  assert.ok(dealer.finished());
  assert.equal(clock.pending(), 0, 'no timers left running');
  dealer.stop();
});

test('the dealer checks or folds for a quiet person, and hands the seat back when they move', () => {
  const clock = fakeClock();
  const dealer = createDealer({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', bot: true }, { id: 'c', name: 'C', bot: true }],
    rules: { hands: 50 },
    random: seeded(21),
    clock,
    timeouts: { idleMs: 5000 },
  });
  // Run until the person is on the clock.
  for (let i = 0; i < 400 && dealer.view(0).turn !== 0; i++) clock.advance(200);
  assert.equal(dealer.view(0).turn, 0);
  assert.equal(dealer.deadline().kind, 'turn');
  const chips = dealer.view(0).players[0].chips;
  clock.advance(5100);
  assert.equal(dealer.isAuto(0), true);
  assert.ok(dealer.view(0).players[0].chips <= chips, 'being away never bets more');
  for (let i = 0; i < 600 && !dealer.view(0).legal.length; i++) clock.advance(100);
  const view = dealer.view(0);
  assert.ok(view.legal.length, 'their turn comes round again');
  assert.ok(dealer.act(0, { type: view.legal.includes('check') ? 'check' : 'fold' }).ok);
  assert.equal(dealer.isAuto(0), false);
  assert.equal(dealer.act(1, { type: 'fold' }).ok, false, 'nobody plays a computer seat');
  dealer.forfeit(0);
  assert.ok(dealer.hasLeft(0));
  dealer.stop();
});

test('an all-in nobody can fully match gets the extra back', () => {
  const state = createGame({ players: named(2), seed: 4 });
  rig(state, ['KS KD', 'AS AD'], '3S 8D JC 4H 9S');
  state.players[1].chips = 300 - state.players[1].bet;
  // Seat 0 shoves 1,000 into a 300 stack and loses: only 300 is at risk.
  if (state.turn !== 0) act(state, 'call');
  act(state, 'raise', { to: START_CHIPS });
  if (state.phase === 'play') act(state, 'call');
  while (state.phase === 'runout') step(state);
  assert.deepEqual(state.last.pots, [{ amount: 600, winners: [1] }]);
  assert.deepEqual(state.players.map((player) => player.chips), [700, 600]);
});
