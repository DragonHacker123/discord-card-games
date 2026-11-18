// Hearts: the rules, what a cheating client could send, the computer players
// and the shared dealer on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../games/hearts/engine.js';
import * as bots from '../games/hearts/bots.js';
import { createDealer } from '../games/hearts/dealer.js';
import { trickWinner } from '../games/shared/tricks.js';
import { NONSENSE, fakeClock, named, playOut, seeded } from '../games/shared/testing.js';

const { applyAction, createGame, forfeit, normaliseRules, playable, step, viewFor } = engine;
const card = (text) => ({ rank: text.slice(0, -1), suit: text.slice(-1) });
const cards = (text) => (text ? text.split(' ').map(card) : []);

function checkSound(state) {
  const held = state.players.reduce((sum, player) => sum + player.hand.length, 0);
  assert.equal(held + state.trick.length + state.tricksPlayed * 4, 52, 'a card was lost or copied');
  const seen = [...state.players.flatMap((player) => player.hand), ...state.trick.map((play) => play.card)];
  assert.equal(new Set(seen.map((c) => c.rank + c.suit)).size, seen.length);
}

/** A round in play with the hands set by the test. */
function rigged(hands, { turn = 0, tricksPlayed = 1, heartsBroken = false, trick = [] } = {}) {
  const state = createGame({ players: named(4), seed: 1 });
  state.players.forEach((player, seat) => {
    player.hand = cards(hands[seat]);
    player.passing = null;
  });
  Object.assign(state, { phase: 'play', turn, tricksPlayed, heartsBroken, trick });
  return state;
}

test('rules from a stranger come out sane', () => {
  assert.deepEqual(normaliseRules(null), { target: 50 });
  assert.deepEqual(normaliseRules({ target: 100 }), { target: 100 });
  assert.deepEqual(normaliseRules({ target: 3 }), { target: 50 });
  assert.throws(() => createGame({ players: named(3) }));
});

test('the highest card of the suit led wins a trick, and trumps beat it', () => {
  const plays = cards('5D KD AS 9D').map((c, seat) => ({ seat, card: c }));
  assert.equal(trickWinner(plays), 1);
  assert.equal(trickWinner(plays, 'S'), 2);
  assert.equal(trickWinner(cards('2S AH').map((c, seat) => ({ seat, card: c })), 'S'), 0);
});

test('everyone passes three cards, in turn left, right, across, then not at all', () => {
  const state = createGame({ players: named(4), seed: 5 });
  assert.equal(state.phase, 'pass');
  assert.equal(viewFor(state, 0).passTo, 1);
  const gave = state.players.map((player) => player.hand.slice(0, 3).map((c) => c.rank + c.suit));
  assert.equal(applyAction(state, 0, { type: 'pass', cards: [0, 0, 1] }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'pass', cards: [0, 1] }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'pass', cards: [0, 1, 13] }).ok, false);
  for (let seat = 0; seat < 4; seat++) assert.ok(applyAction(state, seat, { type: 'pass', cards: [0, 1, 2] }).ok);
  assert.equal(state.phase, 'play');
  checkSound(state);
  for (let seat = 0; seat < 4; seat++) {
    const got = state.players[(seat + 1) % 4].hand.map((c) => c.rank + c.suit);
    assert.ok(gave[seat].every((key) => got.includes(key)), 'the cards went to the left');
    assert.equal(state.players[seat].hand.length, 13);
  }
  assert.equal(viewFor(state, 1).received.length, 3);
  const leader = state.turn;
  assert.ok(state.players[leader].hand.some((c) => c.rank === '2' && c.suit === 'C'));
  // Later rounds.
  const directions = [];
  for (let round = 0; round < 4; round++) {
    directions.push(state.passDir);
    state.phase = 'roundEnd';
    step(state);
  }
  assert.deepEqual(directions, ['left', 'right', 'across', 'none']);
});

test('the 2 of clubs leads, you follow suit, and no points go on the first trick', () => {
  const state = rigged(['2C 5H QS', '9C KH', 'QS 4H 7D', '3H 5H'], { tricksPlayed: 0 });
  state.players[2].hand = cards('QS 4H 7D');
  state.players[0].hand = cards('2C 5H 6S');
  assert.equal(applyAction(state, 0, { type: 'play', card: 1 }).ok, false);
  assert.ok(applyAction(state, 0, { type: 'play', card: 0 }).ok);
  assert.equal(applyAction(state, 1, { type: 'play', card: 1 }).ok, false, 'has a club');
  assert.ok(applyAction(state, 1, { type: 'play', card: 0 }).ok);
  assert.deepEqual(playable(state, 2), [2], 'no queen of spades or heart while there is something else');
  assert.ok(applyAction(state, 2, { type: 'play', card: 2 }).ok);
  assert.deepEqual(playable(state, 3), [0, 1], 'only hearts left, so a heart may go');
});

test('hearts can’t be led until one has been played', () => {
  const state = rigged(['5H 6S', '9C KH', '4H 7D', '3H 5D']);
  assert.equal(applyAction(state, 0, { type: 'play', card: 0 }).error, 'Hearts haven’t been broken yet.');
  state.heartsBroken = true;
  assert.ok(applyAction(state, 0, { type: 'play', card: 0 }).ok);
  const only = rigged(['5H 6H', '9C KH', '4H 7D', '3H 5D']);
  assert.ok(applyAction(only, 0, { type: 'play', card: 0 }).ok, 'nothing but hearts');
});

test('the trick goes to its winner, who takes the points and leads next', () => {
  const state = rigged(['5D 2S', 'KD 3S', 'QS 4S', '9H 5S']);
  for (let seat = 0; seat < 4; seat++) assert.ok(applyAction(state, seat, { type: 'play', card: 0 }).ok);
  assert.equal(state.phase, 'trickEnd');
  assert.equal(state.trickWinner, 1);
  assert.equal(applyAction(state, 1, { type: 'play', card: 0 }).ok, false);
  assert.ok(step(state).ok);
  assert.equal(state.players[1].roundPoints, 14);
  assert.equal(state.turn, 1);
  assert.equal(state.phase, 'play');
});

test('a round adds its points, and taking all 26 gives them to everyone else', () => {
  const state = rigged(['2D', '3D', '4D', '5D'], { tricksPlayed: 12 });
  state.players[0].roundPoints = 20;
  state.players[2].roundPoints = 6;
  for (let seat = 0; seat < 4; seat++) applyAction(state, seat, { type: 'play', card: 0 });
  step(state);
  assert.equal(state.phase, 'roundEnd');
  assert.deepEqual(state.players.map((p) => p.score), [20, 0, 6, 0]);
  const moon = rigged(['2D', '3D', '4D', '5D'], { tricksPlayed: 12 });
  moon.players[3].roundPoints = 26;
  for (let seat = 0; seat < 4; seat++) applyAction(moon, seat, { type: 'play', card: 0 });
  step(moon);
  assert.deepEqual(moon.players.map((p) => p.score), [26, 26, 26, 0]);
  assert.equal(moon.moon, 3);
});

test('the game ends when someone reaches the target, and the lowest score wins', () => {
  const state = rigged(['2D', '3D', '4D', '5D'], { tricksPlayed: 12 });
  state.players.forEach((player, seat) => {
    player.score = [45, 12, 30, 12][seat];
  });
  state.players[0].roundPoints = 26 - 1;
  state.players[1].roundPoints = 1;
  for (let seat = 0; seat < 4; seat++) applyAction(state, seat, { type: 'play', card: 0 });
  const result = step(state);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [3]);
  assert.equal(result.events.at(-1).type, 'finished');
  assert.equal(applyAction(state, 0, { type: 'play', card: 0 }).ok, false);
});

test('nobody sees another player’s hand', () => {
  const state = createGame({ players: named(4), seed: 2 });
  const view = viewFor(state, 2);
  assert.equal(view.players[2].hand.length, 13);
  assert.ok(view.players.every((player, seat) => seat === 2 || player.hand === null));
  const text = JSON.stringify(viewFor(state, -1));
  assert.equal(text.includes('"hand":['), false);
  assert.deepEqual(viewFor(state, -1).legal, []);
});

test('nonsense from a client is refused and changes nothing', () => {
  const state = createGame({ players: named(4), seed: 3 });
  const before = JSON.stringify(state);
  for (const action of NONSENSE) assert.equal(applyAction(state, 0, action).ok, false);
  for (const bad of [null, 'abc', [0, 1, '2'], [0, 1, -1], [0, 1, 2, 3], { length: 3 }]) assert.equal(applyAction(state, 0, { type: 'pass', cards: bad }).ok, false);
  assert.equal(applyAction(state, 0, { type: 'play', card: 0 }).ok, false);
  assert.equal(applyAction(state, 7, { type: 'pass', cards: [0, 1, 2] }).ok, false);
  assert.equal(JSON.stringify(state), before);
});

test('a player who leaves can’t win, and their seat is played out', () => {
  const state = createGame({ players: named(4), seed: 3 });
  assert.ok(forfeit(state, 1).ok);
  assert.equal(forfeit(state, 1).ok, false);
  assert.ok(engine.actors(state).includes(1), 'their seat still has to pass');
  state.players.forEach((player, seat) => {
    player.score = [60, 0, 20, 30][seat];
  });
  const events = [];
  state.phase = 'trickEnd';
  state.tricksPlayed = 12;
  state.trick = cards('2D 3D 4D 5D').map((c, seat) => ({ seat, card: c }));
  state.trickWinner = 3;
  for (const player of state.players) player.hand = [];
  events.push(...step(state).events);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [2]);
});

test('computer players get through whole games; every round shares out 26 points', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const state = playOut(engine, bots, { players: named(4), seed, rules: { target: seed % 2 ? 50 : 100 }, check: checkSound });
    const total = state.players.reduce((sum, player) => sum + player.score, 0);
    assert.equal(total % 26, 0);
    assert.ok(state.players.some((player) => player.score >= state.rules.target));
    assert.ok(state.results.winners.length >= 1);
  }
});

test('the dealer runs a whole game of computer players and leaves no timers', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: named(4).map((p) => ({ ...p, bot: true })), rules: { target: 50 }, random: seeded(7), clock });
  for (let i = 0; i < 6000 && !dealer.finished(); i++) clock.advance(1000);
  assert.ok(dealer.finished());
  assert.equal(clock.pending(), 0);
});

test('the dealer passes and plays for a quiet person, and for one who left', () => {
  const clock = fakeClock();
  const dealer = createDealer({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', bot: true }, { id: 'c', name: 'C' }, { id: 'd', name: 'D', bot: true }],
    rules: { target: 50 },
    random: seeded(3),
    clock,
    timeouts: { idleMs: 5000 },
  });
  assert.equal(dealer.phase(), 'pass');
  clock.advance(3000);
  assert.deepEqual(dealer.view(0).waiting, [0, 2], 'the computers have passed');
  assert.ok(dealer.act(0, { type: 'pass', cards: [0, 1, 2] }).ok);
  assert.equal(dealer.deadline().kind, 'turn');
  clock.advance(5100);
  assert.equal(dealer.isAuto(2), true);
  assert.equal(dealer.isAuto(0), false);
  assert.notEqual(dealer.phase(), 'pass');
  dealer.forfeit(0);
  assert.equal(dealer.act(0, { type: 'play', card: 0 }).error, 'You’ve left this game.');
  for (let i = 0; i < 6000 && !dealer.finished(); i++) clock.advance(1000);
  assert.ok(dealer.finished(), 'the game plays out without them');
  assert.equal(dealer.view(0).results.winners.includes(0), false);
  assert.equal(clock.pending(), 0);
});
