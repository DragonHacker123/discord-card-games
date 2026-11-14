// The setting that lets you pick up the top card of the discard pile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, closeMatchWindow, createGame, eventFor, legalActions, normaliseRules, viewFor } from '../games/jacks/engine.js';

const c = (text) => ({ rank: text.slice(0, -1), suit: text.slice(-1) });
const ON = { drawFromDiscard: true };

function started(rules = ON, count = 3) {
  const state = createGame({
    players: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
    seed: 42,
    rules,
  });
  state.turn = 0;
  for (let seat = 0; seat < count; seat++) must(state, seat, { type: 'ready' });
  return state;
}

function must(state, seat, action) {
  const result = applyAction(state, seat, action);
  assert.ok(result.ok, `${action.type} by seat ${seat} was rejected: ${result.error}`);
  return result.events;
}

function refuse(state, seat, action) {
  const before = JSON.stringify(state);
  const result = applyAction(state, seat, action);
  assert.equal(result.ok, false, `${action.type} by seat ${seat} should have been refused`);
  assert.equal(JSON.stringify(state), before, 'a refused action must not change the game');
}

/** Puts a card on the discard pile, ready for seat 0 to pick up. */
function withDiscard(text, rules = ON, count = 3) {
  const state = started(rules, count);
  state.discardPile.push(c(text));
  return state;
}

test('the setting is off unless it’s turned on', () => {
  assert.equal(normaliseRules({}).drawFromDiscard, false);
  assert.equal(normaliseRules({ drawFromDiscard: 'yes' }).drawFromDiscard, false);
  assert.equal(normaliseRules(ON).drawFromDiscard, true);
});

test('with the setting off, you can only draw from the draw pile', () => {
  const state = withDiscard('5H', {});
  assert.ok(!legalActions(state, 0).includes('takeDiscard'));
  refuse(state, 0, { type: 'takeDiscard' });
});

test('with the setting on, you choose which pile to take from', () => {
  const state = withDiscard('5H');
  const legal = legalActions(state, 0);
  assert.ok(legal.includes('draw') && legal.includes('takeDiscard'));
});

test('you can only pick up on your own turn, before drawing, from a pile with a card on it', () => {
  const empty = started();
  assert.ok(!legalActions(empty, 0).includes('takeDiscard'));
  refuse(empty, 0, { type: 'takeDiscard' });

  const state = withDiscard('5H');
  assert.ok(!legalActions(state, 1).includes('takeDiscard'));
  refuse(state, 1, { type: 'takeDiscard' });
  must(state, 0, { type: 'draw' });
  refuse(state, 0, { type: 'takeDiscard' });
});

test('with no cards of your own, a card you pick up goes into an empty place', () => {
  const state = withDiscard('JOKERR');
  state.players[0].slots = [null, null, null, null];
  assert.ok(legalActions(state, 0).includes('takeDiscard'));
  must(state, 0, { type: 'takeDiscard' });
  assert.deepEqual(legalActions(state, 0), ['place']);
  refuse(state, 0, { type: 'discard' });
  refuse(state, 0, { type: 'swap', slot: 0 });
  refuse(state, 0, { type: 'place', slot: 9 });
  const [event] = must(state, 0, { type: 'place', slot: 3 });
  assert.deepEqual(state.players[0].slots[3], c('JOKERR'));
  assert.deepEqual(eventFor(event, 1), { type: 'placed', seat: 0, slot: 3, card: c('JOKERR') });
  assert.equal(state.discardPile.length, 0);
  assert.equal(state.phase, 'endTurn');
  assert.equal(viewFor(state, 1).players[0].slots[3].card, undefined, 'it’s face down once it lands');
});

test('you can’t place a card when you have cards to swap it with, or drew it from the draw pile', () => {
  const state = withDiscard('5H');
  must(state, 0, { type: 'takeDiscard' });
  refuse(state, 0, { type: 'place', slot: 0 });

  const drew = withDiscard('5H');
  drew.players[0].slots = [null, null, null, null];
  must(drew, 0, { type: 'draw' });
  refuse(drew, 0, { type: 'place', slot: 0 });
});

test('in countdown mode, you wait for matching to close before picking up', () => {
  const state = withDiscard('5H', { ...ON, matchMode: 'countdown', matchSeconds: 3 });
  state.matchOpen = true;
  assert.ok(!legalActions(state, 0).includes('takeDiscard'));
  refuse(state, 0, { type: 'takeDiscard' });
  closeMatchWindow(state);
  must(state, 0, { type: 'takeDiscard' });
});

test('everyone sees which card you picked up', () => {
  const state = withDiscard('JOKERR');
  const [event] = must(state, 0, { type: 'takeDiscard' });
  assert.equal(event.type, 'tookDiscard');
  assert.deepEqual(eventFor(event, 2).card, c('JOKERR'));
  assert.equal(state.discardPile.length, 0);
  for (const seat of [0, 1, 2]) {
    const view = viewFor(state, seat);
    assert.deepEqual(view.drawn, c('JOKERR'), `seat ${seat}`);
    assert.equal(view.drawnFrom, 'discard');
    assert.equal(view.holding, 0);
  }
});

test('everyone sees where the card you picked up went', () => {
  const state = withDiscard('JOKERR');
  state.players[0].slots[2] = c('KS');
  must(state, 0, { type: 'takeDiscard' });
  const [event] = must(state, 0, { type: 'swap', slot: 2 });
  assert.deepEqual(state.players[0].slots[2], c('JOKERR'));
  assert.deepEqual(state.discardPile.at(-1), c('KS'));
  const seen = eventFor(event, 1);
  assert.equal(seen.slot, 2);
  assert.equal(seen.fromDiscard, true);
  assert.deepEqual(seen.drawnCard, c('JOKERR'));
  assert.equal(state.phase, 'endTurn');
  assert.equal(viewFor(state, 1).drawnFrom, null);
  assert.equal(viewFor(state, 1).players[0].slots[2].card, undefined, 'it’s face down again once it lands');
});

test('a card from the draw pile stays secret, with the setting on or off', () => {
  const state = withDiscard('5H');
  state.drawPile.push(c('JOKERR'));
  must(state, 0, { type: 'draw' });
  assert.equal(viewFor(state, 1).drawn, null);
  assert.equal(viewFor(state, 1).drawnFrom, 'draw');
  const [event] = must(state, 0, { type: 'swap', slot: 0 });
  assert.equal(eventFor(event, 1).drawnCard, undefined);
  assert.equal(eventFor(event, 1).fromDiscard, undefined);
  assert.deepEqual(eventFor(event, 0).drawnCard, c('JOKERR'));
});

test('a card you picked up must be swapped in, so it can’t go straight back', () => {
  const state = withDiscard('7H');
  must(state, 0, { type: 'takeDiscard' });
  const legal = legalActions(state, 0);
  assert.ok(legal.includes('swap'));
  assert.ok(!legal.includes('discard'));
  refuse(state, 0, { type: 'discard' });
});

test('picking up doesn’t reopen matching on the card underneath', () => {
  const state = withDiscard('2H');
  state.discardPile.unshift(c('6D'));
  state.players[1].slots = [c('6S'), c('3D'), c('4D'), c('5D')];
  must(state, 0, { type: 'takeDiscard' });
  assert.deepEqual(state.discardPile.at(-1), c('6D'), 'the 6 underneath is on top again');
  for (const seat of [0, 1, 2]) assert.ok(!legalActions(state, seat).includes('match'), `seat ${seat}`);
  refuse(state, 1, { type: 'match', slot: 0 });
});

test('matching opens again with the next discard', () => {
  const state = withDiscard('2H');
  state.discardPile.unshift(c('6D'));
  state.players[0].slots = [c('9S'), c('3D'), c('4D'), c('5D')];
  state.players[1].slots = [c('9D'), c('3S'), c('4S'), c('5S')];
  must(state, 0, { type: 'takeDiscard' });
  must(state, 0, { type: 'swap', slot: 0 });
  assert.ok(legalActions(state, 1).includes('match'));
  must(state, 1, { type: 'match', slot: 0 });
  assert.equal(state.players[1].slots[0], null);
});

test('after a pick-up is placed with no discard, matching stays shut until someone discards', () => {
  const state = withDiscard('JOKERR');
  state.discardPile.unshift(c('6D'));
  state.players[0].slots = [null, null, null, null];
  state.players[1].slots = [c('6S'), c('3D'), c('4D'), c('5D')];
  must(state, 0, { type: 'takeDiscard' });
  must(state, 0, { type: 'place', slot: 0 });
  refuse(state, 1, { type: 'match', slot: 0 });
  must(state, 0, { type: 'endTurn' });
  refuse(state, 1, { type: 'match', slot: 0 });
  state.drawPile.push(c('6H'));
  must(state, 1, { type: 'draw' });
  must(state, 1, { type: 'discard' });
  must(state, 1, { type: 'match', slot: 0 });
});

test('with one card left on the pile, picking it up leaves nothing to match', () => {
  const state = withDiscard('7H');
  must(state, 0, { type: 'takeDiscard' });
  assert.ok(!legalActions(state, 1).includes('match'));
  refuse(state, 1, { type: 'match', slot: 0 });
});
