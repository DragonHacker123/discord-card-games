// Rummy: the rules, what a cheating client could send, the computer players
// and the shared dealer on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../games/rummy/engine.js';
import * as bots from '../games/rummy/bots.js';
import { createDealer } from '../games/rummy/dealer.js';
import { NONSENSE, fakeClock, named, playOut, seeded } from '../games/shared/testing.js';

const { applyAction, createGame, eventFor, forfeit, meldKind, startCards, viewFor } = engine;
const card = (text) => ({ rank: text.slice(0, -1), suit: text.slice(-1) });
const cards = (text) => (text ? text.split(' ').map(card) : []);

function checkSound(state) {
  const all = [...state.stock, ...state.discard, ...state.melds.flatMap((meld) => meld.cards), ...state.players.flatMap((player) => player.hand)];
  assert.equal(all.length, 52, 'a card was lost or copied');
  assert.equal(new Set(all.map((c) => c.rank + c.suit)).size, 52);
  for (const meld of state.melds) assert.equal(meldKind(meld.cards), meld.kind);
}

/** A game with the cards set by the test. Seat 0 has just taken a card and is to play. */
function rigged(hands, { top = '9H', stock = '2C 3C 4C', stage = 'play' } = {}) {
  const state = createGame({ players: named(hands.length), seed: 1 });
  state.players.forEach((player, seat) => {
    player.hand = cards(hands[seat]);
  });
  Object.assign(state, { discard: cards(top), stock: cards(stock), melds: [], turn: 0, stage, taken: null });
  return state;
}

test('the deal depends on how many are playing', () => {
  assert.deepEqual([2, 3, 4, 5, 6].map(startCards), [10, 7, 7, 6, 6]);
  for (const count of [2, 4, 6]) {
    const state = createGame({ players: named(count), seed: count });
    checkSound(state);
    assert.ok(state.players.every((player) => player.hand.length === startCards(count)));
    assert.equal(state.discard.length, 1);
  }
  assert.throws(() => createGame({ players: named(1) }));
  assert.throws(() => createGame({ players: named(7) }));
});

test('sets and runs are told apart from rubbish', () => {
  assert.equal(meldKind(cards('7S 7H 7D')), 'set');
  assert.equal(meldKind(cards('7S 7H 7D 7C')), 'set');
  assert.equal(meldKind(cards('5H 3H 4H')), 'run');
  assert.equal(meldKind(cards('AS 2S 3S 4S')), 'run');
  assert.equal(meldKind(cards('QS KS AS')), null, 'the ace is low');
  assert.equal(meldKind(cards('7S 7H')), null);
  assert.equal(meldKind(cards('7S 8H 9S')), null);
  assert.equal(meldKind(cards('7S 9S 10S')), null);
  assert.equal(meldKind('7S 8S 9S'), null);
});

test('a turn is: take a card, then meld or lay off, then discard', () => {
  const state = rigged(['7S 7H 7D KC 2D', '4S 5S 9D'], { stage: 'draw' });
  assert.equal(applyAction(state, 0, { type: 'discard', card: 0 }).error, 'Take a card first.');
  assert.equal(applyAction(state, 0, { type: 'draw', from: 'nowhere' }).ok, false);
  assert.ok(applyAction(state, 0, { type: 'draw', from: 'stock' }).ok);
  assert.equal(applyAction(state, 0, { type: 'draw', from: 'stock' }).ok, false);
  const hand = state.players[0].hand;
  const sevens = hand.map((c, index) => (c.rank === '7' ? index : -1)).filter((index) => index !== -1);
  assert.equal(applyAction(state, 0, { type: 'meld', cards: [0, 1, 2].map((i) => (sevens.includes(i) ? i : 0)) }).ok, false);
  assert.ok(applyAction(state, 0, { type: 'meld', cards: sevens }).ok);
  assert.equal(state.melds[0].kind, 'set');
  assert.equal(state.players[0].hand.length, 3);
  assert.ok(applyAction(state, 0, { type: 'discard', card: 0 }).ok);
  assert.equal(state.turn, 1);
  assert.equal(state.stage, 'draw');
});

test('a card can be added to any meld on the table', () => {
  const state = rigged(['6S 7C KD', '2D 3D']);
  state.melds = [{ kind: 'run', cards: cards('3S 4S 5S') }, { kind: 'set', cards: cards('7S 7H 7D') }];
  assert.equal(applyAction(state, 0, { type: 'layoff', card: 2, meld: 0 }).error, 'That card doesn’t fit there.');
  assert.equal(applyAction(state, 0, { type: 'layoff', card: 0, meld: 5 }).ok, false);
  assert.ok(applyAction(state, 0, { type: 'layoff', card: 0, meld: 0 }).ok);
  assert.deepEqual(state.melds[0].cards.map((c) => c.rank), ['3', '4', '5', '6']);
  assert.ok(applyAction(state, 0, { type: 'layoff', card: 0, meld: 1 }).ok);
  assert.equal(state.melds[1].cards.length, 4);
});

test('the card taken from the discard pile can’t go straight back', () => {
  const state = rigged(['6S KD', '2D 3D'], { stage: 'draw' });
  assert.ok(applyAction(state, 0, { type: 'draw', from: 'discard' }).ok);
  const index = state.players[0].hand.findIndex((c) => c.rank === '9' && c.suit === 'H');
  assert.deepEqual(viewFor(state, 0).taken, card('9H'));
  assert.equal(viewFor(state, 1).taken, null);
  assert.equal(applyAction(state, 0, { type: 'discard', card: index }).error, 'You can’t discard the card you just picked up.');
  assert.ok(applyAction(state, 0, { type: 'discard', card: index === 0 ? 1 : 0 }).ok);
});

test('getting rid of your last card wins, by a discard or by a meld', () => {
  const byDiscard = rigged(['KD', '2D 3D QH']);
  assert.ok(applyAction(byDiscard, 0, { type: 'discard', card: 0 }).ok);
  assert.equal(byDiscard.phase, 'finished');
  assert.deepEqual(byDiscard.results.winners, [0]);
  assert.equal(byDiscard.results.rows.find((row) => row.seat === 1).points, 2 + 3 + 10);
  const byMeld = rigged(['4D 5D 6D', '2D 3D QH']);
  assert.ok(applyAction(byMeld, 0, { type: 'meld', cards: [0, 1, 2] }).ok);
  assert.deepEqual(byMeld.results.winners, [0]);
  assert.equal(applyAction(byMeld, 1, { type: 'draw', from: 'stock' }).ok, false);
});

test('the discard pile is turned over twice, then the fewest points wins', () => {
  const state = rigged(['KD QD', 'AD 3H'], { stock: '', top: '5C 6C 9H' });
  assert.ok(applyAction(state, 0, { type: 'discard', card: 0 }).ok);
  assert.equal(state.recycles, 1);
  assert.equal(state.discard.length, 1);
  assert.equal(state.stock.length, 3);
  checkSoundish(state, 7);
  state.recycles = 2;
  state.stock = [];
  state.stage = 'play';
  assert.ok(applyAction(state, 1, { type: 'discard', card: 1 }).ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [1]);
});
function checkSoundish(state, total) {
  const all = [...state.stock, ...state.discard, ...state.players.flatMap((player) => player.hand)];
  assert.equal(all.length, total);
}

test('nobody sees another hand or the draw pile', () => {
  const state = createGame({ players: named(3), seed: 9 });
  const view = viewFor(state, 0);
  assert.ok(view.players[0].hand);
  assert.equal(view.players[1].hand, null);
  assert.equal(JSON.stringify(view).includes('"stock"'), false);
  assert.ok(viewFor(state, -1).players.every((player) => player.hand === null));
  const drew = { type: 'drew', seat: 1, from: 'stock', card: card('4D') };
  assert.equal(eventFor(drew, 0).card, null);
  assert.deepEqual(eventFor({ ...drew, from: 'discard' }, 0).card, card('4D'), 'everyone saw the discard');
});

test('nonsense from a client is refused and changes nothing', () => {
  const state = rigged(['7S 7H 7D KC 2D', '4S 5S 9D']);
  const before = JSON.stringify(state);
  for (const action of NONSENSE) assert.equal(applyAction(state, 0, action).ok, false);
  for (const bad of [null, 'abc', [0, 1], [0, 0, 1], [0, 1, 99], [0, 1, '2'], { length: 3 }]) assert.equal(applyAction(state, 0, { type: 'meld', cards: bad }).ok, false);
  for (const bad of [-1, 5, 1.5, '0', null]) assert.equal(applyAction(state, 0, { type: 'discard', card: bad }).ok, false);
  assert.equal(applyAction(state, 1, { type: 'discard', card: 0 }).ok, false, 'not your turn');
  assert.equal(JSON.stringify(state), before);
});

test('leaving puts your cards under the draw pile and you can’t win', () => {
  const state = rigged(['KD QD', 'AD 3H', '5H 6H']);
  assert.ok(forfeit(state, 0).ok);
  assert.equal(state.turn, 1);
  assert.equal(state.stage, 'draw');
  assert.equal(state.stock.length, 5);
  assert.ok(forfeit(state, 2).ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [1]);
});

test('computer players get through whole games without losing a card', () => {
  let went = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const state = playOut(engine, bots, { players: named(2 + (seed % 5)), seed, check: checkSound });
    assert.ok(state.results.winners.length >= 1);
    if (state.players.some((player) => player.hand.length === 0)) went += 1;
  }
  assert.ok(went > 30, `most games end with someone going out (${went} of 60)`);
});

test('the dealer runs a whole game of computer players and leaves no timers', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: named(4).map((p) => ({ ...p, bot: true })), random: seeded(7), clock });
  for (let i = 0; i < 4000 && !dealer.finished(); i++) clock.advance(1000);
  assert.ok(dealer.finished());
  assert.equal(clock.pending(), 0);
});

test('the dealer plays a whole turn for a quiet person', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', bot: true }], random: seeded(5), clock, timeouts: { idleMs: 5000 } });
  for (let i = 0; i < 300 && dealer.view(0).turn !== 0; i++) clock.advance(100);
  assert.deepEqual(dealer.view(0).legal, ['draw']);
  clock.advance(5100);
  assert.equal(dealer.isAuto(0), true);
  for (let i = 0; i < 300 && dealer.view(0).turn === 0 && !dealer.finished(); i++) clock.advance(100);
  assert.ok(dealer.finished() || dealer.view(0).turn === 1, 'the turn was finished for them');
  dealer.stop();
  assert.equal(clock.pending(), 0);
});
