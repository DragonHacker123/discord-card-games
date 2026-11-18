// Spades: the rules, what a cheating client could send, the computer players
// and the shared dealer on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../games/spades/engine.js';
import * as bots from '../games/spades/bots.js';
import { createDealer } from '../games/spades/dealer.js';
import { NONSENSE, fakeClock, named, playOut, seeded } from '../games/shared/testing.js';

const { applyAction, createGame, forfeit, normaliseRules, playable, step, viewFor } = engine;
const card = (text) => ({ rank: text.slice(0, -1), suit: text.slice(-1) });
const cards = (text) => (text ? text.split(' ').map(card) : []);

function checkSound(state) {
  const held = state.players.reduce((sum, player) => sum + player.hand.length, 0);
  assert.equal(held + state.trick.length + state.tricksPlayed * 4, 52, 'a card was lost or copied');
  assert.equal(state.players.reduce((sum, player) => sum + player.tricks, 0), state.tricksPlayed);
}

/** A round in play with the hands and bids set by the test. Seat 0 leads. */
function rigged(hands, bids = [3, 3, 3, 3], extra = {}) {
  const state = createGame({ players: named(4), seed: 1 });
  state.players.forEach((player, seat) => {
    player.hand = cards(hands[seat]);
    player.bid = bids[seat];
    player.tricks = 0;
  });
  Object.assign(state, { phase: 'play', turn: 0, tricksPlayed: 0, spadesBroken: false, trick: [] }, extra);
  return state;
}

/** Plays the last trick of a round where the tricks so far are set by the test. Seat 0 wins it. */
function lastTrick(bids, tricks, teams) {
  const state = rigged(['AD', '3D', '4D', '5D'], bids, { tricksPlayed: 12 });
  state.players.forEach((player, seat) => {
    player.tricks = tricks[seat];
  });
  if (teams) state.teams = teams;
  for (let seat = 0; seat < 4; seat++) assert.ok(applyAction(state, seat, { type: 'play', card: 0 }).ok);
  assert.ok(step(state).ok);
  return state;
}

test('rules from a stranger come out sane', () => {
  assert.deepEqual(normaliseRules(undefined), { target: 250 });
  assert.deepEqual(normaliseRules({ target: 500 }), { target: 500 });
  assert.deepEqual(normaliseRules({ target: '500' }), { target: 250 });
  assert.throws(() => createGame({ players: named(5) }));
});

test('bidding goes round from the player after the dealer, then that player leads', () => {
  const state = createGame({ players: named(4), seed: 6 });
  const first = (state.dealer + 1) % 4;
  assert.equal(state.turn, first);
  assert.equal(applyAction(state, (first + 1) % 4, { type: 'bid', amount: 2 }).ok, false);
  assert.equal(applyAction(state, first, { type: 'play', card: 0 }).error, 'Bid first.');
  for (const bad of [-1, 14, 2.5, '3', null]) assert.equal(applyAction(state, first, { type: 'bid', amount: bad }).ok, false);
  for (let i = 0; i < 4; i++) assert.ok(applyAction(state, (first + i) % 4, { type: 'bid', amount: i }).ok);
  assert.equal(state.phase, 'play');
  assert.equal(state.turn, first);
  assert.equal(state.players[first].bid, 0);
});

test('spades are trumps, and can’t be led until one has been played', () => {
  const state = rigged(['2S 5D', 'KD 3S', '4D 9S', 'AD 5S']);
  assert.deepEqual(playable(state, 0), [1]);
  assert.equal(applyAction(state, 0, { type: 'play', card: 0 }).error, 'Spades haven’t been broken yet.');
  assert.ok(applyAction(state, 0, { type: 'play', card: 1 }).ok);
  assert.equal(applyAction(state, 1, { type: 'play', card: 1 }).error, 'You have to follow suit.');
  assert.ok(applyAction(state, 1, { type: 'play', card: 0 }).ok);
  assert.ok(applyAction(state, 2, { type: 'play', card: 0 }).ok);
  assert.ok(applyAction(state, 3, { type: 'play', card: 0 }).ok);
  assert.equal(state.trickWinner, 3, 'the ace of the suit led');
  step(state);
  assert.equal(state.turn, 3);
  assert.equal(state.players[3].tricks, 1);

  const ruff = rigged(['5D 2C', '2S 3C', '4D 4C', 'AD 5C']);
  for (let seat = 0; seat < 4; seat++) assert.ok(applyAction(ruff, seat, { type: 'play', card: 0 }).ok);
  assert.equal(ruff.trickWinner, 1, 'a small spade beats the ace');
  assert.equal(ruff.spadesBroken, true);
});

test('making your bid scores 10 a trick and 1 a bag; falling short loses 10 a trick', () => {
  // Seats 0 and 2 bid 5 and take 7; seats 1 and 3 bid 7 and take 6.
  const state = lastTrick([3, 4, 2, 3], [3, 2, 3, 4]);
  assert.deepEqual(state.teams, [{ score: 52, bags: 2 }, { score: -70, bags: 0 }]);
  assert.equal(state.phase, 'roundEnd');
  assert.equal(state.summary[0].change, 52);
});

test('nil is worth 100 either way, and a nil bidder’s tricks are only bags', () => {
  const made = lastTrick([4, 0, 3, 5], [3, 0, 4, 5]);
  assert.deepEqual(made.teams[1], { score: 150, bags: 0 });
  assert.deepEqual(made.teams[0], { score: 71, bags: 1 });
  // Seat 2 bid nil but took 2; their partner bid 4 and took 5 with the last trick.
  const failed = lastTrick([4, 3, 0, 3], [4, 3, 2, 3]);
  assert.deepEqual(failed.teams[0], { score: -100 + 40 + 3, bags: 3 });
});

test('ten bags cost 100', () => {
  const state = lastTrick([2, 3, 2, 3], [3, 3, 4, 2], [{ score: 100, bags: 8 }, { score: 0, bags: 0 }]);
  // Bid 4, took 8: 40 + 4 bags, taking the bags to 12, so 100 comes off and 2 are left.
  assert.deepEqual(state.teams[0], { score: 100 + 44 - 100, bags: 2 });
});

test('the first side to the target wins; a dead heat plays on', () => {
  const state = lastTrick([3, 4, 2, 3], [3, 2, 3, 4], [{ score: 200, bags: 0 }, { score: 240, bags: 0 }]);
  assert.equal(state.phase, 'finished');
  assert.equal(state.results.team, 0);
  assert.deepEqual(state.results.winners, [0, 2]);
  const level = lastTrick([3, 3, 3, 3], [2, 3, 3, 3], [{ score: 190, bags: 0 }, { score: 190, bags: 0 }]);
  assert.equal(level.phase, 'roundEnd');
  const sunk = lastTrick([3, 4, 2, 3], [3, 2, 3, 4], [{ score: 0, bags: 0 }, { score: -190, bags: 0 }]);
  assert.equal(sunk.phase, 'finished');
  assert.equal(sunk.results.team, 0);
});

test('nobody sees another player’s hand', () => {
  const state = createGame({ players: named(4), seed: 2 });
  const view = viewFor(state, 1);
  assert.equal(view.players[1].hand.length, 13);
  assert.ok(view.players.every((player, seat) => seat === 1 || player.hand === null));
  assert.equal(JSON.stringify(viewFor(state, -1)).includes('"hand":['), false);
});

test('nonsense from a client is refused and changes nothing', () => {
  const state = createGame({ players: named(4), seed: 3 });
  const before = JSON.stringify(state);
  for (const action of NONSENSE) assert.equal(applyAction(state, state.turn, action).ok, false);
  assert.equal(applyAction(state, 9, { type: 'bid', amount: 1 }).ok, false);
  assert.equal(JSON.stringify(state), before);
});

test('a player who leaves can’t win, but their partner still can', () => {
  const state = lastTrick([3, 4, 2, 3], [3, 2, 3, 4], [{ score: 240, bags: 0 }, { score: 0, bags: 0 }]);
  assert.deepEqual(state.results.winners, [0, 2]);
  const other = rigged(['AD', '3D', '4D', '5D'], [3, 4, 2, 3], { tricksPlayed: 12 });
  other.teams = [{ score: 240, bags: 0 }, { score: 0, bags: 0 }];
  other.players.forEach((player, seat) => {
    player.tricks = [3, 2, 3, 4][seat];
  });
  assert.ok(forfeit(other, 2).ok);
  assert.equal(forfeit(other, 2).ok, false);
  for (let seat = 0; seat < 4; seat++) applyAction(other, seat, { type: 'play', card: 0 });
  step(other);
  assert.deepEqual(other.results.winners, [0]);
});

test('computer players get through whole games', () => {
  let rounds = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const state = playOut(engine, bots, { players: named(4), seed, rules: { target: [150, 250, 500][seed % 3] }, check: checkSound });
    rounds += state.round;
    assert.equal(state.results.winners.length, 2);
    assert.ok(state.teams[state.results.team].score > state.teams[1 - state.results.team].score);
  }
  assert.ok(rounds / 30 < 25, `games are a sensible length (${rounds / 30} rounds)`);
});

test('the dealer runs a whole game of computer players and leaves no timers', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: named(4).map((p) => ({ ...p, bot: true })), rules: { target: 150 }, random: seeded(7), clock });
  for (let i = 0; i < 9000 && !dealer.finished(); i++) clock.advance(1000);
  assert.ok(dealer.finished());
  assert.equal(clock.pending(), 0);
});

test('the dealer bids and plays for a quiet person', () => {
  const clock = fakeClock();
  const dealer = createDealer({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', bot: true }, { id: 'c', name: 'C', bot: true }, { id: 'd', name: 'D', bot: true }],
    rules: { target: 150 },
    random: seeded(3),
    clock,
    timeouts: { idleMs: 5000 },
  });
  for (let i = 0; i < 100 && dealer.view(0).turn !== 0; i++) clock.advance(200);
  assert.deepEqual(dealer.view(0).legal, ['bid']);
  clock.advance(5100);
  assert.equal(dealer.isAuto(0), true);
  assert.ok(dealer.view(0).players[0].bid >= 1);
  for (let i = 0; i < 400 && !dealer.view(0).legal.includes('play'); i++) clock.advance(100);
  const view = dealer.view(0);
  assert.ok(dealer.act(0, { type: 'play', card: view.playable[0] }).ok);
  assert.equal(dealer.isAuto(0), false);
  dealer.stop();
  assert.equal(clock.pending(), 0);
});
