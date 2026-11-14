// Plays the whole tutorial script on the real engine, and checks that what it
// tells the player about the cards is true.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, closeLastCall, legalActions, viewFor } from '../games/jacks/engine.js';
import {
  createTutorialGame,
  stepAllows,
  stepSlots,
  TUTOR_ADA,
  TUTOR_YOU,
  TUTORIAL_STEPS,
} from '../games/jacks/tutorial.js';

const you = TUTOR_YOU;
const code = (card) => `${card.rank}${card.suit}`;
const top = (state) => state.discardPile.at(-1);
const mine = (state, slot) => state.players[you].slots[slot];

// What each step says, checked against the game at the moment the step appears.
const CLAIMS = {
  peek: (s) => {
    assert.equal(code(mine(s, 2)), 'KS');
    assert.equal(mine(s, 3).rank, '4');
  },
  swap1: (s) => assert.equal(s.drawn.rank, '2'),
  match1: (s) => {
    assert.equal(top(s).rank, '4');
    assert.equal(mine(s, 3).rank, '4');
  },
  match3: (s) => assert.equal(mine(s, 3), null),
  wrong1: (s) => assert.equal(top(s).rank, '4'),
  wrong2: (s) => assert.equal(mine(s, 0).rank, '9'),
  wrong3: (s) => {
    assert.equal(mine(s, 0).rank, '9');
    assert.equal(s.players[you].slots.length, 5);
  },
  power7: (s) => assert.equal(s.drawn.rank, '7'),
  seen7: (s) => assert.equal(s.power.seen[0].card.rank, '3'),
  power10: (s) => assert.equal(s.drawn.rank, '10'),
  seen10: (s) => assert.equal(s.power.seen[0].card.rank, 'JOKER'),
  noPower: (s) => assert.equal(top(s).rank, '8'),
  powerJ: (s) => assert.equal(s.drawn.rank, 'J'),
  blind: (s) => {
    assert.equal(mine(s, 0).rank, '9');
    assert.equal(s.players[TUTOR_ADA].slots[2].rank, 'JOKER');
  },
  powerQ: (s) => assert.equal(s.drawn.rank, 'Q'),
  other1: (s) => {
    assert.equal(top(s).rank, '9');
    assert.equal(s.players[TUTOR_ADA].slots[2].rank, '9');
  },
  other3: (s) => {
    assert.deepEqual(s.give, { seat: you, owner: TUTOR_ADA, slot: 2 });
    assert.equal(top(s).rank, '9');
    assert.equal(s.players[you].slots.length, 5);
    assert.ok(mine(s, 4), 'the penalty card is still yours to give');
  },
  ada4End: (s) => {
    assert.equal(s.give, null);
    assert.equal(code(s.players[TUTOR_ADA].slots[2]), 'KC');
    assert.equal(mine(s, 4), null);
  },
  queen1: (s) => assert.equal(mine(s, 2).rank, '2'),
  queen2: (s) => {
    assert.equal(code(s.power.seen[0].card), '2C');
    assert.equal(s.power.seen[1].card.rank, 'A');
  },
  call: (s) => assert.equal(s.phase, 'endTurn'),
  last1: (s) => {
    assert.equal(s.phase, 'lastCall');
    assert.equal(top(s).rank, '3');
    assert.equal(mine(s, 1).rank, '3');
  },
};

function playThrough(queenSwap) {
  const state = createTutorialGame();
  for (const step of TUTORIAL_STEPS) {
    CLAIMS[step.id]?.(state);
    if (step.ada) {
      for (const move of step.ada) {
        const result = applyAction(state, TUTOR_ADA, move);
        assert.ok(result.ok, `${step.id}: Ada's ${move.type} was refused: ${result.error}`);
      }
    } else if (step.expect?.type === 'pickForMatch') {
      assert.ok(legalActions(state, you).includes('match'), `${step.id}: matching isn't open`);
    } else if (step.expect) {
      const action = step.expect.type === 'queenDecide' ? { type: 'queenDecide', swap: queenSwap } : step.expect;
      assert.ok(legalActions(state, you).includes(action.type), `${step.id}: ${action.type} isn't legal`);
      const result = applyAction(state, you, action);
      assert.ok(result.ok, `${step.id}: ${action.type} was refused: ${result.error}`);
    } else if (step.finish) {
      assert.ok(closeLastCall(state).ok);
    }
  }
  return state;
}

function totals(state) {
  return Object.fromEntries(state.results.standings.map((row) => [row.name, row.total]));
}

test('the tutorial uses one ordinary deck', () => {
  const state = createTutorialGame();
  const cards = [...state.players.flatMap((player) => player.slots), ...state.drawPile];
  assert.equal(cards.length, 54);
  assert.equal(new Set(cards.map(code)).size, 54);
});

test('the whole script plays legally, and you win if you swap with the queen', () => {
  const state = playThrough(true);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [you]);
  assert.deepEqual(totals(state), { You: -4, Ada: 16 });
});

test('you also win if you leave the queen’s cards where they are', () => {
  const state = playThrough(false);
  assert.deepEqual(state.results.winners, [you]);
  assert.deepEqual(totals(state), { You: -3, Ada: 15 });
});

test('you start the game and Ada is already ready', () => {
  const view = viewFor(createTutorialGame(), you);
  assert.equal(view.turn, you);
  assert.equal(view.players[TUTOR_ADA].ready, true);
  assert.equal(view.players[you].ready, false);
});

test('a step only allows the move it asks for', () => {
  const step = TUTORIAL_STEPS.find((item) => item.id === 'swap1');
  assert.ok(stepAllows(step, { type: 'swap', slot: 2 }));
  assert.ok(!stepAllows(step, { type: 'swap', slot: 3 }));
  assert.ok(!stepAllows(step, { type: 'discard' }));
  assert.ok(!stepAllows(TUTORIAL_STEPS[0], { type: 'ready' }));

  const blind = TUTORIAL_STEPS.find((item) => item.id === 'blind');
  assert.ok(stepAllows(blind, { type: 'blindSwap', own: 0, other: { seat: TUTOR_ADA, slot: 2 } }));
  assert.ok(!stepAllows(blind, { type: 'blindSwap', own: 1, other: { seat: TUTOR_ADA, slot: 2 } }));
  assert.deepEqual(stepSlots(blind), [
    { seat: you, slot: 0 },
    { seat: TUTOR_ADA, slot: 2 },
  ]);

  const queen = TUTORIAL_STEPS.find((item) => item.id === 'queen2');
  assert.ok(stepAllows(queen, { type: 'queenDecide', swap: true }));
  assert.ok(stepAllows(queen, { type: 'queenDecide', swap: false }));

  const pick = TUTORIAL_STEPS.find((item) => item.id === 'match1');
  assert.ok(stepAllows(pick, { type: 'pickForMatch', seat: you, slot: 3 }));
  assert.ok(!stepAllows(pick, { type: 'pickForMatch', seat: you, slot: 0 }));
  assert.ok(!stepAllows(pick, { type: 'pickForMatch', seat: TUTOR_ADA, slot: 3 }));
  assert.deepEqual(stepSlots(pick), [{ seat: you, slot: 3 }]);

  const press = TUTORIAL_STEPS.find((item) => item.id === 'match2');
  assert.ok(stepAllows(press, { type: 'match', owner: you, slot: 3 }));
  assert.ok(!stepAllows(press, { type: 'match', owner: you, slot: 0 }));
  assert.deepEqual(stepSlots(press), []);
});

test('every step has words and exactly one way forward', () => {
  const ids = TUTORIAL_STEPS.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const step of TUTORIAL_STEPS) {
    assert.ok(step.section && step.title && step.body, `${step.id} is missing words`);
    const ways = [step.next, step.expect, step.ada, step.last].filter(Boolean);
    assert.equal(ways.length, 1, `${step.id} should have one way forward`);
  }
  assert.ok(TUTORIAL_STEPS.at(-1).last);
});
