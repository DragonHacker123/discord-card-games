// Crazy Eights: the rules, what a cheating client could send, the computer
// players and the shared dealer on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../games/crazy8/engine.js';
import * as bots from '../games/crazy8/bots.js';
import { createDealer } from '../games/crazy8/dealer.js';
import { NONSENSE, fakeClock, named, playOut, seeded } from '../games/shared/testing.js';

const { applyAction, createGame, eventFor, forfeit, viewFor } = engine;
const card = (text) => ({ rank: text.slice(0, -1), suit: text.slice(-1) });
const cards = (text) => (text ? text.split(' ').map(card) : []);

function checkSound(state) {
  const all = [...state.stock, ...state.discard, ...state.players.flatMap((player) => player.hand)];
  assert.equal(all.length, 52, 'a card was lost or copied');
  assert.equal(new Set(all.map((c) => c.rank + c.suit)).size, 52);
}

/** A game with the cards set by the test. Seat 0 is to play. */
function rigged(hands, top, stock = '') {
  const state = createGame({ players: named(hands.length), seed: 1 });
  state.players.forEach((player, seat) => {
    player.hand = cards(hands[seat]);
  });
  state.discard = [card(top)];
  state.suit = card(top).suit;
  state.stock = cards(stock);
  state.turn = 0;
  return state;
}

test('the deal gives seven cards to two players and five to more, and never starts on an eight', () => {
  for (const count of [2, 3, 6]) {
    for (let seed = 1; seed < 40; seed++) {
      const state = createGame({ players: named(count), seed });
      checkSound(state);
      assert.ok(state.players.every((player) => player.hand.length === (count === 2 ? 7 : 5)));
      assert.notEqual(state.discard[0].rank, '8');
    }
  }
  assert.throws(() => createGame({ players: named(1) }));
  assert.throws(() => createGame({ players: named(7) }));
  assert.deepEqual(createGame({ players: named(3), seed: 4 }), createGame({ players: named(3), seed: 4 }));
});

test('a card has to match the suit or the rank', () => {
  const state = rigged(['5H 9S KD', '2C 3C'], '9H', '4D');
  assert.equal(applyAction(state, 0, { type: 'play', card: 2 }).ok, false);
  assert.ok(applyAction(state, 0, { type: 'play', card: 1 }).ok, 'same rank');
  assert.equal(state.suit, 'S');
  assert.equal(state.turn, 1);
});

test('an eight goes on anything and names the suit', () => {
  const state = rigged(['8C KD', '2C 3D'], '9H', '4D');
  assert.equal(applyAction(state, 0, { type: 'play', card: 0 }).ok, false, 'needs a suit');
  assert.equal(applyAction(state, 0, { type: 'play', card: 0, suit: 'X' }).ok, false);
  assert.ok(applyAction(state, 0, { type: 'play', card: 0, suit: 'D' }).ok);
  assert.equal(state.suit, 'D');
  assert.equal(applyAction(state, 1, { type: 'play', card: 0 }).ok, false, 'a club no longer fits');
  assert.ok(applyAction(state, 1, { type: 'play', card: 1 }).ok);
});

test('you draw one card at most, then play or pass', () => {
  const state = rigged(['KD', '2C 3D'], '9H', '4S 5H');
  assert.equal(applyAction(state, 0, { type: 'pass' }).ok, false, 'draw first');
  assert.ok(applyAction(state, 0, { type: 'draw' }).ok);
  assert.equal(applyAction(state, 0, { type: 'draw' }).ok, false);
  assert.deepEqual(viewFor(state, 0).legal, ['play', 'pass']);
  assert.ok(applyAction(state, 0, { type: 'pass' }).ok);
  assert.equal(state.turn, 1);
});

test('the discard pile is turned over when the draw pile runs out', () => {
  const state = rigged(['KD', '2C 3D'], '9H');
  state.discard = cards('4S 5S 6S 9H');
  const result = applyAction(state, 0, { type: 'draw' });
  assert.ok(result.ok);
  assert.deepEqual(result.events.map((e) => e.type), ['reshuffled', 'drew']);
  assert.equal(state.discard.length, 1);
  assert.equal(state.stock.length, 2);
  checkSoundish(state, 7);
});
function checkSoundish(state, total) {
  const all = [...state.stock, ...state.discard, ...state.players.flatMap((player) => player.hand)];
  assert.equal(all.length, total);
  assert.equal(new Set(all.map((c) => c.rank + c.suit)).size, total);
}

test('playing your last card wins', () => {
  const state = rigged(['9S', '2C 8D KH'], '9H', '4D');
  const result = applyAction(state, 0, { type: 'play', card: 0 });
  assert.ok(result.ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [0]);
  assert.equal(state.results.rows.find((row) => row.seat === 1).points, 2 + 50 + 10);
  assert.equal(applyAction(state, 1, { type: 'draw' }).ok, false);
});

test('when nobody can play and nothing is left to draw, the fewest points wins', () => {
  const state = rigged(['KD QD', '2C'], '9H');
  assert.ok(applyAction(state, 0, { type: 'pass' }).ok);
  assert.equal(state.phase, 'play');
  assert.ok(applyAction(state, 1, { type: 'pass' }).ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [1]);
});

test('nobody sees another hand, the draw pile, or what someone else drew', () => {
  const state = createGame({ players: named(3), seed: 9 });
  const view = viewFor(state, 0);
  assert.ok(view.players[0].hand);
  assert.equal(view.players[1].hand, null);
  assert.equal(JSON.stringify(view).includes('stock"'), false);
  const watcher = viewFor(state, -1);
  assert.ok(watcher.players.every((player) => player.hand === null));
  assert.deepEqual(watcher.legal, []);
  const drew = { type: 'drew', seat: 1, card: card('4D') };
  assert.equal(eventFor(drew, 0).card, null);
  assert.deepEqual(eventFor(drew, 1).card, card('4D'));
});

test('nonsense from a client is refused and changes nothing', () => {
  const state = createGame({ players: named(3), seed: 3 });
  const before = JSON.stringify(state);
  const seat = state.turn;
  for (const action of NONSENSE) assert.equal(applyAction(state, seat, action).ok, false);
  for (const bad of [-1, 1.5, 99, '0', null, 'length']) assert.equal(applyAction(state, seat, { type: 'play', card: bad, suit: 'S' }).ok, false);
  assert.equal(applyAction(state, (seat + 1) % 3, { type: 'draw' }).ok, false, 'not your turn');
  assert.equal(applyAction(state, 9, { type: 'draw' }).ok, false);
  assert.equal(JSON.stringify(state), before);
});

test('leaving puts your cards under the draw pile and you can’t win', () => {
  const state = rigged(['9S 2D', '2C 8D KH', '3H'], '9H', '4D');
  assert.ok(forfeit(state, 0).ok);
  assert.equal(state.turn, 1);
  assert.equal(state.stock.length, 3);
  assert.equal(forfeit(state, 0).ok, false);
  assert.ok(forfeit(state, 1).ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [2]);
});

test('computer players get through whole games without losing a card', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const state = playOut(engine, bots, { players: named(2 + (seed % 5)), seed, check: checkSound });
    assert.ok(state.results.winners.length >= 1);
  }
});

test('the dealer runs a whole game of computer players and leaves no timers', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: named(4).map((p) => ({ ...p, bot: true })), random: seeded(7), clock });
  for (let i = 0; i < 3000 && !dealer.finished(); i++) clock.advance(1000);
  assert.ok(dealer.finished());
  assert.equal(clock.pending(), 0);
});

test('the dealer plays for a quiet person and hands the seat back when they move', () => {
  const clock = fakeClock();
  let updates = 0;
  const dealer = createDealer({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', bot: true }],
    random: seeded(21),
    clock,
    timeouts: { idleMs: 5000 },
    onUpdate: () => {
      updates += 1;
    },
  });
  for (let i = 0; i < 200 && dealer.view(0).turn !== 0; i++) clock.advance(200);
  assert.equal(dealer.view(0).turn, 0);
  assert.equal(dealer.deadline().kind, 'turn');
  assert.ok(dealer.deadline().ms <= 5000);
  clock.advance(5100);
  assert.equal(dealer.isAuto(0), true);
  assert.ok(updates > 0);
  for (let i = 0; i < 400 && !(dealer.view(0).turn === 0 && dealer.view(0).legal.length) && !dealer.finished(); i++) clock.advance(50);
  if (!dealer.finished()) {
    const action = engine.anyLegal(dealer._state, 0);
    assert.ok(dealer.act(0, action).ok);
    assert.equal(dealer.isAuto(0), false);
    assert.equal(dealer.act(1, { type: 'draw' }).ok, false, 'nobody plays a computer seat');
    dealer.forfeit(0);
    assert.ok(dealer.hasLeft(0));
    assert.ok(dealer.finished());
  }
  dealer.stop();
  assert.equal(clock.pending(), 0);
});
