// What computer players know about other people's cards, and what they do with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame, eventFor, viewFor } from '../games/jacks/engine.js';
import { botAct, botMatchOther, botObserve, createBot } from '../games/jacks/bots.js';

const c = (text) => ({ rank: text.slice(0, -1), suit: text.slice(-1) });
const hand = (...cards) => cards.map(c);

function started(rules, count = 3) {
  const state = createGame({
    players: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
    seed: 42,
    rules,
  });
  state.turn = 0;
  for (let seat = 0; seat < count; seat++) applyAction(state, seat, { type: 'ready' });
  return state;
}

/** A game with a watching bot in seat 1, which is told about every move made. */
function table(rules, count = 3) {
  const state = started(rules, count);
  const bot = createBot(1, 7, { forgetOwn: 0, forgetOthers: 0 });
  const play = (seat, action) => {
    const result = applyAction(state, seat, action);
    assert.ok(result.ok, `${action.type} by seat ${seat} was rejected: ${result.error}`);
    for (const event of result.events) botObserve(bot, eventFor(event, bot.seat));
    return result;
  };
  return { state, bot, play, view: () => viewFor(state, bot.seat) };
}

/** Has the bot look at this card of seat 0's with a 9, on its own turn. */
function botPeeksAt(game, slot) {
  const { state, play } = game;
  state.turn = 1;
  state.phase = 'draw';
  state.drawPile.push(c('9H'));
  play(1, { type: 'draw' });
  play(1, { type: 'discard' });
  play(1, { type: 'peek', target: { seat: 0, slot } });
  play(1, { type: 'powerDone' });
  play(1, { type: 'endTurn' });
}

test('a bot won’t try a card it knows nothing about, even if it would match', () => {
  const { state, bot, view } = table();
  state.players[0].slots = hand('6S', '3D', '4D', '5C');
  state.players[1].slots = hand('KS', 'KC', 'QD', 'JD');
  state.discardPile.push(c('6H'));
  assert.equal(botMatchOther(bot, view()), null);
});

test('a bot can match a card it has looked at', () => {
  const game = table();
  const { state, bot, view } = game;
  state.players[0].slots = hand('6S', '3D', '4D', '5C');
  state.players[1].slots = hand('KS', 'KC', 'QD', 'JD');
  botPeeksAt(game, 0);
  state.discardPile.push(c('6H'));
  assert.deepEqual(botMatchOther(bot, view()), { seat: 0, slot: 0 });
});

test('a bot can match a card it saw go wrong and get taken back', () => {
  const { state, bot, play, view } = table();
  state.players[0].slots = hand('6S', '3D', '4D', '5C');
  state.players[1].slots = hand('KS', 'KC', 'QD', 'JD');
  state.discardPile.push(c('2H'));
  play(2, { type: 'match', owner: 0, slot: 0 });
  assert.deepEqual(state.players[0].slots[0], c('6S'), 'the wrong try left it there');
  state.discardPile.push(c('6H'));
  assert.deepEqual(botMatchOther(bot, view()), { seat: 0, slot: 0 });
});

test('a bot follows a card it knows when it moves', () => {
  const game = table();
  const { state, bot, play, view } = game;
  state.players[0].slots = hand('6S', '3D', '4D', '5C');
  state.players[2].slots = hand('2S', '2D', '2C', '2H');
  state.players[1].slots = hand('KS', 'KC', 'QD', 'JD');
  botPeeksAt(game, 0);
  state.turn = 2;
  state.phase = 'draw';
  state.drawPile.push(c('JH'));
  play(2, { type: 'draw' });
  play(2, { type: 'discard' });
  play(2, { type: 'blindSwap', own: 1, other: { seat: 0, slot: 0 } });
  state.discardPile.push(c('6H'));
  assert.deepEqual(botMatchOther(bot, view()), { seat: 2, slot: 1 });
});

test('a bot forgets a card once it has been swapped out', () => {
  const game = table();
  const { state, bot, play, view } = game;
  state.players[0].slots = hand('6S', '3D', '4D', '5C');
  state.players[1].slots = hand('KS', 'KC', 'QD', 'JD');
  botPeeksAt(game, 0);
  state.turn = 0;
  state.phase = 'draw';
  state.drawPile.push(c('6C'));
  play(0, { type: 'draw' });
  play(0, { type: 'swap', slot: 0 });
  assert.equal(botMatchOther(bot, view()), null, 'the 6 it knew has gone, and the new card is unknown');
});

test('a bot remembers a card it watched being picked up from the discard pile', () => {
  const { state, bot, play, view } = table({ drawFromDiscard: true });
  state.players[0].slots = hand('KS', '3D', '4D', '5C');
  state.players[1].slots = hand('KC', 'KD', 'QD', 'JD');
  state.discardPile.push(c('6H'));
  play(0, { type: 'takeDiscard' });
  play(0, { type: 'swap', slot: 3 });
  state.discardPile.push(c('6C'));
  assert.deepEqual(botMatchOther(bot, view()), { seat: 0, slot: 3 });
});

test('a bot steals a joker it watched being picked up', () => {
  const { state, bot, play, view } = table({ drawFromDiscard: true });
  state.players[0].slots = hand('KS', '3D', '4D', '5C');
  state.players[1].slots = hand('KC', '2D', '2S', '2H');
  state.discardPile.push(c('JOKERR'));
  play(0, { type: 'takeDiscard' });
  play(0, { type: 'swap', slot: 2 });
  play(0, { type: 'endTurn' });
  state.drawPile.push(c('JH'));
  play(1, { type: 'draw' });
  play(1, { type: 'discard' });
  const move = botAct(bot, view());
  assert.equal(move.type, 'blindSwap');
  assert.deepEqual(move.other, { seat: 0, slot: 2 });
});

test('a bot won’t match if the card it has to give up is worth too little', () => {
  const game = table();
  const { state, bot, view } = game;
  state.players[0].slots = hand('KS', '3D', '4D', '5C');
  state.players[1].slots = [{ rank: 'JOKER', suit: 'R' }, null, null, null];
  bot.memory['1:0'] = { rank: 'JOKER', suit: 'R' };
  bot.memory['0:0'] = c('KS');
  state.discardPile.push(c('KD'));
  assert.equal(botMatchOther(bot, view()), null);
});

test('a bot skips a jack or queen if a match has taken its last card', () => {
  for (const rank of ['JH', 'QH']) {
    const { state, bot, play, view } = table();
    state.players[1].slots = [c('6S'), null, null, null];
    bot.memory['1:0'] = c('6S');
    state.turn = 1;
    state.phase = 'draw';
    state.drawPile.push(c(rank));
    play(1, { type: 'draw' });
    play(1, { type: 'discard' });
    assert.ok(view().power, rank);
    state.discardPile.push(c('6H'));
    play(1, { type: 'match', slot: 0 });
    assert.deepEqual(botAct(bot, view()), { type: 'skipPower' }, rank);
  }
});

test('a bot gives away the card it thinks is worth the most', () => {
  const game = table();
  const { state, bot, play, view } = game;
  state.players[0].slots = hand('6S', '3D', '4D', '5C');
  state.players[1].slots = hand('2S', 'KC', '3S', '4S');
  Object.assign(bot.memory, { '1:0': c('2S'), '1:1': c('KC'), '1:2': c('3S'), '1:3': c('4S'), '0:0': c('6S') });
  state.discardPile.push(c('6H'));
  const target = botMatchOther(bot, view());
  play(1, { type: 'match', owner: target.seat, slot: target.slot });
  assert.deepEqual(state.give, { seat: 1, owner: 0, slot: 0 });
  const move = botAct(bot, view());
  assert.deepEqual(move, { type: 'giveCard', slot: 1 });
  play(1, move);
  assert.deepEqual(state.players[0].slots[0], c('KC'));
  assert.equal(state.players[1].slots[1], null);
});

test('a bot picks up a discard that beats its worst card by enough, and swaps it in', () => {
  const { state, bot, play, view } = table({ drawFromDiscard: true });
  state.players[1].slots = hand('KC', '2D', '2S', '2H');
  Object.assign(bot.memory, { '1:0': c('KC'), '1:1': c('2D'), '1:2': c('2S'), '1:3': c('2H') });
  state.turn = 1;
  state.phase = 'draw';
  state.discardPile.push(c('AH'));
  const move = botAct(bot, view());
  assert.deepEqual(move, { type: 'takeDiscard' });
  play(1, move);
  assert.deepEqual(botAct(bot, view()), { type: 'swap', slot: 0 });
});

test('a bot with no cards only picks up a card that scores below zero, and places it', () => {
  const { state, bot, play, view } = table({ drawFromDiscard: true });
  state.players[1].slots = [null, null, null, null];
  state.turn = 1;
  state.phase = 'draw';
  state.discardPile.push(c('AH'));
  assert.deepEqual(botAct(bot, view()), { type: 'draw' });
  state.discardPile.push(c('KH'));
  assert.deepEqual(botAct(bot, view()), { type: 'takeDiscard' });
  play(1, { type: 'takeDiscard' });
  const move = botAct(bot, view());
  assert.deepEqual(move, { type: 'place', slot: 0 });
  play(1, move);
  assert.deepEqual(state.players[1].slots[0], c('KH'));
});

test('a bot draws instead if the discard isn’t much better than its worst card', () => {
  const { state, bot, view } = table({ drawFromDiscard: true });
  state.players[1].slots = hand('4C', '2D', '2S', '2H');
  Object.assign(bot.memory, { '1:0': c('4C'), '1:1': c('2D'), '1:2': c('2S'), '1:3': c('2H') });
  state.turn = 1;
  state.phase = 'draw';
  state.discardPile.push(c('3H'));
  assert.deepEqual(botAct(bot, view()), { type: 'draw' });
});
