// One test per rule, written from Cameron's description of Jacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction,
  buildDeck,
  closeLastCall,
  createGame,
  eventFor,
  legalActions,
  scoreCard,
  viewFor,
} from '../games/jacks/engine.js';

const c = (text) => {
  if (text === 'JOKER') return { rank: 'JOKER', suit: 'R' };
  return { rank: text.slice(0, -1), suit: text.slice(-1) };
};
const hand = (...cards) => cards.map(c);

function newGame(count = 3, first = 0) {
  const state = createGame({
    players: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
    seed: 42,
  });
  state.turn = first;
  return state;
}

/** A game past the opening peek, with the first player about to draw. */
function started(count = 3, first = 0) {
  const state = newGame(count, first);
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

const topOfDrawPile = (state, text) => state.drawPile.push(c(text));
const top = (state) => state.discardPile[state.discardPile.length - 1];

/** Plays a whole plain turn: draw this card and discard it, then pass. */
function playTurn(state, seat, text = '2C') {
  topOfDrawPile(state, text);
  must(state, seat, { type: 'draw' });
  must(state, seat, { type: 'discard' });
  must(state, seat, { type: 'endTurn' });
}

test('deck is 52 cards plus two jokers, and everyone is dealt four', () => {
  assert.equal(buildDeck().length, 54);
  const state = newGame(4);
  for (const player of state.players) assert.equal(player.slots.length, 4);
  assert.equal(state.drawPile.length, 54 - 16);
  assert.equal(state.discardPile.length, 0);
});

test('scoring: jokers -5, red kings -1, aces 1, J/Q/black K 10, the rest face value', () => {
  assert.equal(scoreCard(c('JOKER')), -5);
  assert.equal(scoreCard(c('KH')), -1);
  assert.equal(scoreCard(c('KD')), -1);
  assert.equal(scoreCard(c('KS')), 10);
  assert.equal(scoreCard(c('KC')), 10);
  assert.equal(scoreCard(c('AS')), 1);
  assert.equal(scoreCard(c('JH')), 10);
  assert.equal(scoreCard(c('QC')), 10);
  assert.equal(scoreCard(c('2D')), 2);
  assert.equal(scoreCard(c('10S')), 10);
});

test('at the start you see only your two nearest cards, and never again once ready', () => {
  const state = newGame(3);
  const view = viewFor(state, 0);
  assert.ok(view.players[0].slots[2].card);
  assert.ok(view.players[0].slots[3].card);
  assert.equal(view.players[0].slots[0].card, undefined);
  assert.equal(view.players[0].slots[1].card, undefined);
  for (const slot of view.players[1].slots) assert.equal(slot.card, undefined);

  must(state, 0, { type: 'ready' });
  for (const slot of viewFor(state, 0).players[0].slots) assert.equal(slot.card, undefined);
});

test('nobody can play until everyone has looked at their cards', () => {
  const state = newGame(2, 0);
  must(state, 1, { type: 'ready' });
  refuse(state, 0, { type: 'draw' });
  must(state, 0, { type: 'ready' });
  must(state, 0, { type: 'draw' });
});

test('play moves clockwise and only the player whose turn it is can draw', () => {
  const state = started(3, 1);
  refuse(state, 0, { type: 'draw' });
  playTurn(state, 1);
  assert.equal(state.turn, 2);
  playTurn(state, 2);
  assert.equal(state.turn, 0);
  playTurn(state, 0);
  assert.equal(state.turn, 1);
});

test('only the player who drew can see the drawn card', () => {
  const state = started(3);
  topOfDrawPile(state, '5H');
  const [event] = must(state, 0, { type: 'draw' });
  assert.deepEqual(viewFor(state, 0).drawn, c('5H'));
  assert.equal(viewFor(state, 1).drawn, null);
  assert.deepEqual(eventFor(event, 0).card, c('5H'));
  assert.equal(eventFor(event, 1).card, undefined);
});

test('swapping puts the drawn card in your slot and the old card face up on the discard pile', () => {
  const state = started(3);
  state.players[0].slots = hand('9S', '3D', '4D', '6C');
  topOfDrawPile(state, 'AH');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'swap', slot: 0 });
  assert.deepEqual(state.players[0].slots[0], c('AH'));
  assert.deepEqual(top(state), c('9S'));
  assert.deepEqual(viewFor(state, 1).discardTop, c('9S'));
  assert.equal(viewFor(state, 0).players[0].slots[0].card, undefined, 'the new card goes face down');
});

test('a 7 or 8 swapped out of your hand gives no power', () => {
  const state = started(3);
  state.players[0].slots = hand('7S', '3D', '4D', '6C');
  topOfDrawPile(state, 'AH');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'swap', slot: 0 });
  assert.equal(state.power, null);
  assert.equal(state.phase, 'endTurn');
});

test('a drawn card you swap in gives no power, even if it is a power card', () => {
  const state = started(3);
  topOfDrawPile(state, '7H');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'swap', slot: 1 });
  assert.equal(state.power, null);
});

for (const rank of ['7S', '8D']) {
  test(`a drawn ${rank} put straight on the pile lets you look at one of your own cards`, () => {
    const state = started(3);
    state.players[0].slots = hand('2S', '3D', '4D', '6C');
    topOfDrawPile(state, rank);
    must(state, 0, { type: 'draw' });
    must(state, 0, { type: 'discard' });
    assert.equal(state.power.kind, 'peekOwn');

    refuse(state, 0, { type: 'peek', target: { seat: 1, slot: 0 } });
    const [event] = must(state, 0, { type: 'peek', target: { seat: 0, slot: 1 } });
    assert.deepEqual(viewFor(state, 0).power.seen[0].card, c('3D'));
    assert.deepEqual(viewFor(state, 1).power.seen, [], 'nobody else sees it');
    assert.equal(eventFor(event, 1).cards, undefined);

    must(state, 0, { type: 'powerDone' });
    assert.equal(state.phase, 'endTurn');
    assert.equal(viewFor(state, 0).power, null, 'the card goes back to being hidden');
  });
}

for (const rank of ['9C', '10H']) {
  test(`a drawn ${rank} put straight on the pile lets you look at someone else's card`, () => {
    const state = started(3);
    state.players[1].slots = hand('KS', 'QD', '4D', '6C');
    topOfDrawPile(state, rank);
    must(state, 0, { type: 'draw' });
    must(state, 0, { type: 'discard' });
    assert.equal(state.power.kind, 'peekOther');

    refuse(state, 0, { type: 'peek', target: { seat: 0, slot: 0 } });
    must(state, 0, { type: 'peek', target: { seat: 1, slot: 0 } });
    assert.deepEqual(viewFor(state, 0).power.seen[0].card, c('KS'));
    assert.deepEqual(viewFor(state, 1).power.seen, [], 'not even the owner sees it');
    must(state, 0, { type: 'powerDone' });
  });
}

test('a jack swaps one of yours with an opponent’s, with neither card shown', () => {
  const state = started(3);
  state.players[0].slots = hand('KS', '3D', '4D', '6C');
  state.players[2].slots = hand('AH', '2H', '5H', '6H');
  topOfDrawPile(state, 'JD');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  assert.equal(state.power.kind, 'blindSwap');

  refuse(state, 0, { type: 'blindSwap', own: 0, other: { seat: 0, slot: 1 } });
  const [event] = must(state, 0, { type: 'blindSwap', own: 0, other: { seat: 2, slot: 1 } });
  assert.deepEqual(state.players[0].slots[0], c('2H'));
  assert.deepEqual(state.players[2].slots[1], c('KS'));
  const leak = JSON.stringify([eventFor(event, 0), viewFor(state, 0)]);
  assert.ok(!leak.includes('"rank":"K"') && !leak.includes('"suit":"H","rank"'), 'no card is revealed');
  assert.equal(state.phase, 'endTurn');
});

test('a queen lets you look at one of yours and one of theirs, then choose to swap', () => {
  const state = started(3);
  state.players[0].slots = hand('KS', '3D', '4D', '6C');
  state.players[1].slots = hand('AH', '2H', '5H', '6H');
  topOfDrawPile(state, 'QC');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  assert.equal(state.power.kind, 'queen');

  must(state, 0, { type: 'queenLook', own: 0, other: { seat: 1, slot: 0 } });
  const seen = viewFor(state, 0).power.seen.map((entry) => entry.card);
  assert.deepEqual(seen, [c('KS'), c('AH')]);
  assert.deepEqual(viewFor(state, 1).power.seen, []);

  must(state, 0, { type: 'queenDecide', swap: true });
  assert.deepEqual(state.players[0].slots[0], c('AH'));
  assert.deepEqual(state.players[1].slots[0], c('KS'));
});

test('after a queen you can choose to leave both cards where they are', () => {
  const state = started(3);
  state.players[0].slots = hand('AS', '3D', '4D', '6C');
  state.players[1].slots = hand('KH', '2H', '5H', '6H');
  topOfDrawPile(state, 'QC');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'queenLook', own: 0, other: { seat: 1, slot: 0 } });
  must(state, 0, { type: 'queenDecide', swap: false });
  assert.deepEqual(state.players[0].slots[0], c('AS'));
  assert.deepEqual(state.players[1].slots[0], c('KH'));
});

test('powers are optional', () => {
  const state = started(3);
  topOfDrawPile(state, '8C');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'skipPower' });
  assert.equal(state.phase, 'endTurn');
});

test('a card with no power, like a 2 or a king, just ends the action', () => {
  for (const rank of ['2C', 'KS', 'AD', 'JOKER']) {
    const state = started(3);
    topOfDrawPile(state, rank);
    must(state, 0, { type: 'draw' });
    must(state, 0, { type: 'discard' });
    assert.equal(state.power, null, rank);
    assert.equal(state.phase, 'endTurn', rank);
  }
});

test('a correct match leaves your card on the pile and is not replaced', () => {
  const state = started(3);
  state.players[1].slots = hand('6S', '3D', '4D', '6C');
  playTurn(state, 0, '6H');
  const count = state.discardPile.length;
  must(state, 1, { type: 'match', slot: 0 });
  assert.equal(state.players[1].slots[0], null, 'the slot stays empty');
  assert.equal(state.players[1].slots.length, 4, 'other cards keep their places');
  assert.deepEqual(top(state), c('6S'));
  assert.equal(state.discardPile.length, count + 1);
});

test('you can match all the way down to no cards', () => {
  const state = started(2);
  state.players[1].slots = hand('6S', '6D', '6C', 'KH');
  state.players[1].slots[3] = null;
  playTurn(state, 0, '6H');
  must(state, 1, { type: 'match', slot: 0 });
  must(state, 1, { type: 'match', slot: 1 });
  must(state, 1, { type: 'match', slot: 2 });
  assert.equal(state.players[1].slots.filter(Boolean).length, 0);
  assert.ok(legalActions(state, 1).includes('match'), 'you can still try someone else’s card');
  refuse(state, 1, { type: 'match', slot: 0 });
});

/** A game where seat 1 has just correctly matched seat 2's top-left 6. */
function afterMatchingSomeoneElse() {
  const state = started(3);
  state.players[1].slots = hand('2S', '3D', '4D', '5C');
  state.players[2].slots = hand('6S', '3S', '4S', '6C');
  playTurn(state, 0, '6H');
  const events = must(state, 1, { type: 'match', owner: 2, slot: 0 });
  return { state, events };
}

test('matching another player’s card puts it on the pile, then you owe them a card', () => {
  const { state, events } = afterMatchingSomeoneElse();
  const matched = events.find((event) => event.type === 'matched');
  assert.equal(matched.seat, 1, 'the event says who tried');
  assert.equal(matched.owner, 2, 'and whose card it was');
  assert.equal(state.players[2].slots[0], null, 'their place is empty until you fill it');
  assert.deepEqual(top(state), c('6S'));
  assert.deepEqual(state.give, { seat: 1, owner: 2, slot: 0 });
  assert.deepEqual(viewFor(state, 0).give, state.give, 'everyone can see who owes whom');
});

test('you choose which card to give, and it fills the empty place', () => {
  const { state } = afterMatchingSomeoneElse();
  const events = must(state, 1, { type: 'giveCard', slot: 2 });
  assert.deepEqual(state.players[2].slots[0], c('4D'), 'it takes the empty place');
  assert.equal(state.players[1].slots[2], null, 'your place stays empty');
  assert.equal(state.players[1].slots.length, 4);
  assert.equal(state.give, null);
  const gave = events.find((event) => event.type === 'gaveCard');
  assert.deepEqual(
    { seat: gave.seat, slot: gave.slot, owner: gave.owner, ownerSlot: gave.ownerSlot },
    { seat: 1, slot: 2, owner: 2, ownerSlot: 0 },
  );
});

test('nobody gets to see the card you give', () => {
  const { state } = afterMatchingSomeoneElse();
  const events = must(state, 1, { type: 'giveCard', slot: 2 });
  const gave = events.find((event) => event.type === 'gaveCard');
  assert.equal(gave.card, undefined, 'the event doesn’t name the card');
  for (const viewer of [0, 1, 2]) {
    assert.equal(viewFor(state, viewer).players[2].slots[0].card, undefined);
  }
});

test('everyone waits while a card is being given', () => {
  const { state } = afterMatchingSomeoneElse();
  assert.deepEqual(legalActions(state, 1), ['giveCard', 'keepCards']);
  assert.deepEqual(legalActions(state, 0), []);
  assert.deepEqual(legalActions(state, 2), []);
  refuse(state, 1, { type: 'draw' });
  refuse(state, 2, { type: 'match', slot: 3 });
  refuse(state, 0, { type: 'giveCard', slot: 0 });
  must(state, 1, { type: 'giveCard', slot: 0 });
  assert.ok(legalActions(state, 1).includes('draw'), 'play carries on from where it was');
});

test('you can only give one of your own cards, from a place that has one', () => {
  const { state } = afterMatchingSomeoneElse();
  state.players[1].slots[3] = null;
  refuse(state, 1, { type: 'giveCard', slot: 3 });
  refuse(state, 1, { type: 'giveCard', slot: 9 });
  refuse(state, 1, { type: 'giveCard' });
});

test('you can’t give a card when you don’t owe one', () => {
  const state = started(3);
  refuse(state, 0, { type: 'giveCard', slot: 0 });
});

test('with no cards to give, the other player gets a card from the draw pile', () => {
  const state = started(3);
  state.players[1].slots = [null, null, null, null];
  state.players[2].slots = hand('6S', '3S', '4S', '6C');
  playTurn(state, 0, '6H');
  topOfDrawPile(state, 'QH');
  const events = must(state, 1, { type: 'match', owner: 2, slot: 0 });
  assert.equal(state.give, null, 'nobody waits');
  assert.deepEqual(state.players[2].slots[0], c('QH'));
  const refilled = events.find((event) => event.type === 'refilled');
  assert.deepEqual(refilled, { type: 'refilled', owner: 2, slot: 0 });
  assert.equal(viewFor(state, 2).players[2].slots[0].card, undefined, 'not even its new owner sees it');
});

test('matching your own card, or getting one wrong, owes nobody anything', () => {
  const state = started(3);
  state.players[1].slots = hand('6S', '3D', '4D', '5C');
  state.players[2].slots = hand('9S', '3S', '4S', '6C');
  playTurn(state, 0, '6H');
  must(state, 1, { type: 'match', slot: 0 });
  assert.equal(state.give, null, 'your own card');
  must(state, 1, { type: 'match', owner: 2, slot: 0 });
  assert.equal(state.give, null, 'a wrong try');
});

test('the cards can’t turn over until a card owed in the last chance is given', () => {
  const state = started(2);
  state.players[1].slots = hand('6S', '3S', '4S', '6C');
  topOfDrawPile(state, '2C');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'callJacks' });
  topOfDrawPile(state, '6H');
  must(state, 1, { type: 'draw' });
  must(state, 1, { type: 'discard' });
  assert.equal(state.phase, 'lastCall');
  must(state, 0, { type: 'match', owner: 1, slot: 0 });
  assert.equal(closeLastCall(state).ok, false);
  assert.equal(state.phase, 'lastCall');
  must(state, 0, { type: 'giveCard', slot: 0 });
  assert.equal(closeLastCall(state).ok, true);
  assert.equal(state.phase, 'finished');
});

test('a queen swap is cancelled if a looked-at card has been replaced by a given card', () => {
  const state = started(3);
  state.players[0].slots = hand('2S', '3D', '4D', '5C');
  state.players[1].slots = hand('7S', '3H', '4H', '5H');
  state.players[2].slots = hand('QS', '3S', '4S', '6C');
  topOfDrawPile(state, 'QH');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'queenLook', own: 0, other: { seat: 2, slot: 0 } });
  must(state, 1, { type: 'match', owner: 2, slot: 0 });
  must(state, 1, { type: 'giveCard', slot: 0 });
  assert.deepEqual(state.players[2].slots[0], c('7S'), 'a different card now sits there');
  const events = must(state, 0, { type: 'queenDecide', swap: true });
  const resolved = events.find((event) => event.type === 'queenResolved');
  assert.equal(resolved.swapped, false);
  assert.equal(resolved.cardGone, true);
  assert.deepEqual(state.players[0].slots[0], c('2S'), 'your card stays where it was');
  assert.deepEqual(state.players[2].slots[0], c('7S'));
});

test('a wrong try at another player’s card goes back to them, and you take the penalty', () => {
  const state = started(3);
  state.players[2].slots = hand('9S', '3D', '4D', '6C');
  const yours = state.players[1].slots.length;
  playTurn(state, 0, '6H');
  topOfDrawPile(state, 'AC');
  const events = must(state, 1, { type: 'match', owner: 2, slot: 0 });
  const failed = events.find((event) => event.type === 'matchFailed');
  assert.equal(failed.seat, 1);
  assert.equal(failed.owner, 2);
  assert.deepEqual(eventFor(failed, 0).card, c('9S'), 'everyone sees the wrong card');
  assert.deepEqual(state.players[2].slots[0], c('9S'), 'it goes back to its owner');
  assert.equal(state.players[2].slots.length, 4, 'the owner gets no extra card');
  assert.deepEqual(state.players[1].slots[yours], c('AC'), 'whoever tried takes the penalty');
  assert.equal(failed.penaltySlot, yours);
});

test('you can’t match an empty place on another player’s side', () => {
  const state = started(3);
  state.players[2].slots = hand('6S', '3D', '4D', '6C');
  state.players[2].slots[0] = null;
  playTurn(state, 0, '6H');
  refuse(state, 1, { type: 'match', owner: 2, slot: 0 });
  refuse(state, 1, { type: 'match', owner: 7, slot: 0 });
});

test('a wrong match shows the card to everyone, then you keep it and take a penalty card', () => {
  const state = started(3);
  state.players[1].slots = hand('9S', '3D', '4D', '6C');
  playTurn(state, 0, '6H');
  topOfDrawPile(state, 'AC');
  const events = must(state, 1, { type: 'match', slot: 0 });
  const failed = events.find((event) => event.type === 'matchFailed');
  assert.deepEqual(eventFor(failed, 2).card, c('9S'), 'everyone sees the wrong card');
  assert.deepEqual(state.players[1].slots[0], c('9S'), 'it goes back where it was');
  assert.deepEqual(state.players[1].slots[4], c('AC'), 'the penalty card takes a new place');
  assert.equal(failed.penaltySlot, 4);
  assert.deepEqual(top(state), c('6H'), 'the discard pile is unchanged');
  assert.equal(viewFor(state, 1).players[1].slots[4].card, undefined, 'the penalty card stays hidden');
});

test('wrong matches can take you past five cards', () => {
  const state = started(3);
  state.players[1].slots = hand('9S', '3D', '4D', '5C');
  playTurn(state, 0, '6H');
  must(state, 1, { type: 'match', slot: 0 });
  must(state, 1, { type: 'match', slot: 1 });
  must(state, 1, { type: 'match', slot: 2 });
  assert.equal(state.players[1].slots.filter(Boolean).length, 7);
});

test('matching goes by rank alone', () => {
  const state = started(3);
  state.players[1].slots = hand('KS', '3D', '4D', '5C');
  playTurn(state, 0, 'KH');
  must(state, 1, { type: 'match', slot: 0 });
  assert.equal(state.players[1].slots[0], null, 'a black king matches a red king');
});

test('you can try a match until the next card lands on the pile, not after', () => {
  const state = started(3);
  state.players[2].slots = hand('6S', '5D', '4D', '3C');
  playTurn(state, 0, '6H');

  // Player 1 is now mid-turn. The 6 is still on top in every step of that turn.
  topOfDrawPile(state, 'AH');
  must(state, 1, { type: 'draw' });
  assert.ok(legalActions(state, 2).includes('match'));
  assert.deepEqual(viewFor(state, 2).discardTop, c('6H'));

  // Once player 1 discards, the 6 is buried and the same attempt is wrong.
  must(state, 1, { type: 'discard' });
  assert.deepEqual(viewFor(state, 2).discardTop, c('AH'));
  const events = must(state, 2, { type: 'match', slot: 0 });
  assert.ok(events.some((event) => event.type === 'matchFailed'));
});

test('you can match your own discard, and match during your own turn', () => {
  const state = started(3);
  state.players[0].slots = hand('6S', '6D', '4D', '3C');
  topOfDrawPile(state, 'AH');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'swap', slot: 0 });
  assert.deepEqual(top(state), c('6S'));
  must(state, 0, { type: 'match', slot: 1 });
  assert.equal(state.players[0].slots[1], null);
  assert.equal(state.phase, 'endTurn', 'a match does not end your turn');
});

test('several players can match the same rank, one after another', () => {
  const state = started(3);
  state.players[1].slots = hand('6S', '5D', '4D', '3C');
  state.players[2].slots = hand('6D', '5C', '4C', '3D');
  playTurn(state, 0, '6H');
  must(state, 1, { type: 'match', slot: 0 });
  must(state, 2, { type: 'match', slot: 0 });
  assert.equal(state.players[1].slots[0], null);
  assert.equal(state.players[2].slots[0], null);
});

test('nothing can be matched before the first discard', () => {
  const state = started(3);
  refuse(state, 1, { type: 'match', slot: 0 });
});

test('a matched 7 gives no power', () => {
  const state = started(3);
  state.players[1].slots = hand('7S', '5D', '4D', '3C');
  playTurn(state, 0, '2C');
  state.discardPile.push(c('7H'));
  must(state, 1, { type: 'match', slot: 0 });
  assert.equal(state.power, null);
});

test('you can only call jacks at the end of your own turn', () => {
  const state = started(3);
  refuse(state, 0, { type: 'callJacks' });
  topOfDrawPile(state, '2C');
  must(state, 0, { type: 'draw' });
  refuse(state, 0, { type: 'callJacks' });
  must(state, 0, { type: 'discard' });
  refuse(state, 1, { type: 'callJacks' });
  must(state, 0, { type: 'callJacks' });
  assert.equal(state.caller, 0);
});

test('after jacks is called everyone else gets one more go, and the caller gets none', () => {
  const state = started(4, 1);
  topOfDrawPile(state, '2C');
  must(state, 1, { type: 'draw' });
  must(state, 1, { type: 'discard' });
  must(state, 1, { type: 'callJacks' });

  for (const seat of [2, 3, 0]) {
    assert.equal(state.turn, seat);
    assert.equal(state.phase, 'draw');
    topOfDrawPile(state, '3C');
    must(state, seat, { type: 'draw' });
    must(state, seat, { type: 'discard' });
  }
  assert.equal(state.phase, 'lastCall', 'the turn never returns to the caller');
});

test('nobody else can call once jacks has been called', () => {
  const state = started(3);
  topOfDrawPile(state, '2C');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'callJacks' });
  topOfDrawPile(state, '3C');
  must(state, 1, { type: 'draw' });
  must(state, 1, { type: 'discard' });
  assert.equal(state.turn, 2, 'the last-go player moves straight on');
  refuse(state, 1, { type: 'callJacks' });
});

test('in the last round the caller can still be swapped with, and can still match', () => {
  const state = started(2);
  state.players[0].slots = hand('AS', '6D', '4D', '3C');
  state.players[1].slots = hand('KS', '5D', '4H', '3H');
  topOfDrawPile(state, '2C');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'callJacks' });

  topOfDrawPile(state, 'JD');
  must(state, 1, { type: 'draw' });
  must(state, 1, { type: 'discard' });
  must(state, 1, { type: 'blindSwap', own: 0, other: { seat: 0, slot: 0 } });
  assert.deepEqual(state.players[0].slots[0], c('KS'), 'the caller got the black king');
  assert.equal(state.phase, 'lastCall');

  state.discardPile.push(c('6H'));
  must(state, 0, { type: 'match', slot: 1 });
  assert.equal(state.players[0].slots[1], null, 'the caller matched during the last chance');
});

test('all cards are shown at the end and the lowest total wins', () => {
  const state = started(2);
  state.players[0].slots = hand('10S', 'KS', '2D', '3C');
  state.players[1].slots = hand('JOKER', 'KH', 'AD', '2C');
  topOfDrawPile(state, '4C');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'callJacks' });
  topOfDrawPile(state, '4D');
  must(state, 1, { type: 'draw' });
  must(state, 1, { type: 'discard' });

  const [finished] = closeLastCall(state).events;
  assert.equal(state.phase, 'finished');
  assert.deepEqual(finished.results.winners, [1]);
  assert.equal(finished.results.standings[0].total, -5 - 1 + 1 + 2);
  assert.equal(finished.results.standings[1].total, 10 + 10 + 2 + 3);
  assert.ok(finished.results.standings[1].called, 'the caller lost, with no extra penalty');
  for (const slot of viewFor(state, 1).players[0].slots) assert.ok(slot.card, 'all cards turned over');
});

/** Seat 0 calls, everyone else takes their last go, and the cards turn over. */
function finishWithHands(...hands) {
  const state = started(hands.length);
  hands.forEach((cards, seat) => {
    state.players[seat].slots = hand(...cards);
  });
  topOfDrawPile(state, '4H');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'callJacks' });
  for (let seat = 1; seat < hands.length; seat++) {
    topOfDrawPile(state, '5H');
    must(state, seat, { type: 'draw' });
    must(state, seat, { type: 'discard' });
  }
  return closeLastCall(state).events[0].results;
}

test('if you call and tie for lowest, you lose', () => {
  const results = finishWithHands(['2S', '3D', '4D', '6C'], ['2D', '3S', '4C', '6D']);
  assert.deepEqual(results.winners, [1]);
  assert.equal(results.best, 15);
  assert.deepEqual(results.standings.map((row) => row.seat), [1, 0], 'the caller is listed below whoever they tied with');
});

test('if you call and tie with two players, those two share the win', () => {
  const results = finishWithHands(['2S', '3D', '4D', '6C'], ['2D', '3S', '4C', '6D'], ['2C', '3C', '4S', '6H']);
  assert.deepEqual(results.winners, [1, 2]);
});

test('if you call and you’re the only one lowest, you win', () => {
  const results = finishWithHands(['2S', '3D', '4D', '5C'], ['2D', '3S', '4C', '6D']);
  assert.deepEqual(results.winners, [0]);
});

test('two players who didn’t call can still tie for the win', () => {
  const results = finishWithHands(['KS', '3D', '4D', '6C'], ['2D', '3S', '4C', '6D'], ['2C', '3C', '4S', '6H']);
  assert.deepEqual(results.winners, [1, 2]);
});

test('a player with no cards still draws and discards, and cannot swap', () => {
  const state = started(2);
  state.players[0].slots = [null, null, null, null];
  topOfDrawPile(state, '5H');
  must(state, 0, { type: 'draw' });
  assert.ok(!legalActions(state, 0).includes('swap'));
  refuse(state, 0, { type: 'swap', slot: 0 });
  must(state, 0, { type: 'discard' });
  assert.equal(state.phase, 'endTurn');
});

test('with no cards, a drawn jack or queen has no power but a 9 still does', () => {
  for (const [rank, kind] of [['JS', null], ['QS', null], ['9S', 'peekOther'], ['7S', null]]) {
    const state = started(2);
    state.players[0].slots = [null, null, null, null];
    topOfDrawPile(state, rank);
    must(state, 0, { type: 'draw' });
    must(state, 0, { type: 'discard' });
    assert.equal(state.power?.kind ?? null, kind, rank);
  }
});

test('when the draw pile runs out the discards are shuffled back, keeping the top card', () => {
  const state = started(2);
  state.discardPile = hand('2S', '3S', '4S', '5S');
  state.drawPile = [];
  const events = must(state, 0, { type: 'draw' });
  assert.ok(events.some((event) => event.type === 'reshuffled'));
  assert.deepEqual(state.discardPile, [c('5S')]);
  assert.equal(state.drawPile.length, 2);
  assert.ok(state.drawn);
});

test('a looked-at card that gets matched away cancels a queen swap safely', () => {
  const state = started(3);
  state.players[0].slots = hand('KS', '3D', '4D', '6C');
  state.players[1].slots = hand('QH', '2H', '5H', '6H');
  topOfDrawPile(state, 'QC');
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'queenLook', own: 0, other: { seat: 1, slot: 0 } });
  must(state, 1, { type: 'match', slot: 0 });
  const [event] = must(state, 0, { type: 'queenDecide', swap: true });
  assert.equal(event.swapped, false);
  assert.equal(event.cardGone, true);
  assert.deepEqual(state.players[0].slots[0], c('KS'));
});

test('a refused action never changes the game', () => {
  const state = started(3);
  refuse(state, 1, { type: 'draw' });
  refuse(state, 0, { type: 'discard' });
  refuse(state, 0, { type: 'swap', slot: 0 });
  refuse(state, 0, { type: 'endTurn' });
  refuse(state, 0, { type: 'nonsense' });
  refuse(state, 9, { type: 'draw' });
});

test('a player’s view holds no hidden cards from anyone', () => {
  const state = started(3);
  topOfDrawPile(state, '5H');
  must(state, 0, { type: 'draw' });
  const view = viewFor(state, 1);
  for (const player of view.players) {
    for (const slot of player.slots) assert.equal(slot.card, undefined);
  }
  assert.equal(view.drawn, null);
  assert.equal(view.drawPile, undefined);
  assert.equal(view.rng, undefined, 'the shuffle seed would reveal the whole deck');
  assert.equal(view.seed, undefined);
});

test('after matching someone else’s card you can keep your cards, and they get one from the draw pile', () => {
  const state = started(3);
  state.players[2].slots = hand('6S', '3D', '4D', '6C');
  playTurn(state, 0, '6H');
  topOfDrawPile(state, 'AC');
  must(state, 1, { type: 'match', owner: 2, slot: 0 });
  assert.deepEqual(legalActions(state, 1), ['giveCard', 'keepCards']);
  refuse(state, 0, { type: 'keepCards' });
  const mine = state.players[1].slots.filter(Boolean).length;
  const events = must(state, 1, { type: 'keepCards' });
  assert.equal(state.give, null);
  assert.deepEqual(state.players[2].slots[0], c('AC'), 'the draw pile fills the gap');
  assert.equal(state.players[1].slots.filter(Boolean).length, mine, 'you keep all your cards');
  assert.ok(events.some((event) => event.type === 'refilled' && event.owner === 2 && event.slot === 0));
  refuse(state, 1, { type: 'keepCards' });
});
