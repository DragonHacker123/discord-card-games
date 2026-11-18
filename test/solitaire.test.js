// Solitaire: the rules, what a cheating client could send, the computer
// players and its own dealer on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../games/solitaire/engine.js';
import { botAct, createBot } from '../games/solitaire/bots.js';
import { createDealer } from '../games/solitaire/dealer.js';
import { NONSENSE, fakeClock, named, seeded } from '../games/shared/testing.js';

const { applyAction, createGame, destination, forfeit, normaliseRules, placed, timeUp, viewFor } = engine;
const card = (text, up = true) => ({ rank: text.slice(0, -1), suit: text.slice(-1), up });
const plain = (text) => ({ rank: text.slice(0, -1), suit: text.slice(-1) });

function checkSound(board) {
  const all = [...board.stock, ...board.waste, ...board.tableau.flat()];
  assert.equal(all.length + placed(board), 52, 'a card was lost or copied');
  assert.equal(new Set(all.map((c) => c.rank + c.suit)).size, all.length);
  for (const pile of board.tableau) {
    if (pile.length) assert.equal(pile.at(-1).up, true, 'the top card of a column is face up');
    const firstUp = pile.findIndex((c) => c.up);
    assert.ok(pile.slice(firstUp === -1 ? pile.length : firstUp).every((c) => c.up), 'no face-down card sits on a face-up one');
  }
}

/** A one-player game with the columns set by the test. */
function rigged(columns, { waste = [], stock = [], foundations = {} } = {}) {
  const state = createGame({ players: named(1), seed: 1 });
  const board = state.players[0].board;
  board.tableau = Array.from({ length: 7 }, (_x, col) => (columns[col] ?? []).map((entry) => (typeof entry === 'string' ? card(entry) : entry)));
  board.waste = waste.map(plain);
  board.stock = stock.map(plain);
  board.foundations = { S: 0, H: 0, D: 0, C: 0, ...foundations };
  return state;
}

test('rules from a stranger come out sane', () => {
  assert.deepEqual(normaliseRules(null), { minutes: 10 });
  assert.deepEqual(normaliseRules({ minutes: 5 }), { minutes: 5 });
  assert.deepEqual(normaliseRules({ minutes: 600 }), { minutes: 10 });
  assert.throws(() => createGame({ players: [] }));
  assert.throws(() => createGame({ players: named(7) }));
});

test('everyone gets the same deal: seven columns, one card face up on each, 24 to draw', () => {
  const state = createGame({ players: named(3), seed: 11 });
  for (const player of state.players) {
    checkSound(player.board);
    assert.deepEqual(player.board.tableau.map((pile) => pile.length), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(player.board.tableau.every((pile) => pile.filter((c) => c.up).length === 1));
    assert.equal(player.board.stock.length, 24);
  }
  assert.deepEqual(state.players[0].board, state.players[2].board);
  assert.notEqual(state.players[0].board.tableau, state.players[2].board.tableau, 'but each board is their own');
});

test('a tap sends a card to its foundation first, else onto a column', () => {
  const state = rigged([['AS'], ['2S'], ['3H'], ['KD']]);
  const board = state.players[0].board;
  assert.deepEqual(destination(board, { pile: 'tableau', col: 0, index: 0 }), { to: 'foundation' });
  assert.deepEqual(destination(board, { pile: 'tableau', col: 1, index: 0 }), { to: 'tableau', col: 2 }, 'black 2 on red 3');
  assert.equal(destination(board, { pile: 'tableau', col: 3, index: 0 }), null, 'a king at the bottom stays put');
  assert.ok(applyAction(state, 0, { type: 'tap', pile: 'tableau', col: 0, index: 0 }).ok);
  assert.equal(board.foundations.S, 1);
  assert.ok(applyAction(state, 0, { type: 'tap', pile: 'tableau', col: 1, index: 0 }).ok);
  assert.equal(board.foundations.S, 2, 'now the 2 fits its foundation');
  assert.equal(applyAction(state, 0, { type: 'tap', pile: 'tableau', col: 2, index: 0 }).error, 'That card has nowhere to go.');
});

test('a run moves together, and the card under it is turned over', () => {
  const state = rigged([[card('4C', false), '9H', '8S', '7D'], ['10S'], []]);
  const board = state.players[0].board;
  assert.ok(applyAction(state, 0, { type: 'tap', pile: 'tableau', col: 0, index: 1 }).ok);
  assert.deepEqual(board.tableau[1].map((c) => c.rank), ['10', '9', '8', '7']);
  assert.deepEqual(board.tableau[0], [card('4C')]);
  assert.equal(applyAction(state, 0, { type: 'tap', pile: 'tableau', col: 1, index: 2 }).ok, false, 'the black 8 has no other red 9 to go to');
  assert.equal(state.players[0].moves, 1);
});

test('only a king goes on an empty column, and prefers a column with cards', () => {
  const state = rigged([['5H', '4S'], [], ['QS'], [card('2D', false), 'KH']]);
  const board = state.players[0].board;
  assert.equal(destination(board, { pile: 'tableau', col: 0, index: 1 }), null);
  assert.deepEqual(destination(board, { pile: 'tableau', col: 3, index: 1 }), { to: 'tableau', col: 1 });
  assert.deepEqual(destination(board, { pile: 'tableau', col: 2, index: 0 }), { to: 'tableau', col: 3 }, 'the black queen goes on the red king');
});

test('the draw pile turns one card at a time and goes round again', () => {
  const state = rigged([['KS']], { stock: ['3D', '9C'] });
  const board = state.players[0].board;
  assert.ok(applyAction(state, 0, { type: 'draw' }).ok);
  assert.deepEqual(board.waste, [plain('9C')]);
  assert.ok(applyAction(state, 0, { type: 'draw' }).ok);
  assert.equal(viewFor(state, 0).board.waste[0].rank, '3');
  assert.ok(applyAction(state, 0, { type: 'draw' }).ok, 'turns the pile over');
  assert.deepEqual(board.stock.map((c) => c.rank), ['3', '9']);
  assert.equal(board.waste.length, 0);
  board.stock = [];
  assert.equal(applyAction(state, 0, { type: 'draw' }).ok, false);
});

test('finishing the deck ends the game at once', () => {
  const state = createGame({ players: named(2), seed: 3 });
  const board = state.players[1].board;
  Object.assign(board, { stock: [], waste: [], tableau: [[card('KC')], [], [], [], [], [], []], foundations: { S: 13, H: 13, D: 13, C: 12 } });
  const result = applyAction(state, 1, { type: 'tap', pile: 'tableau', col: 0, index: 0 });
  assert.ok(result.ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [1]);
  assert.equal(result.events.at(-1).type, 'finished');
  assert.equal(applyAction(state, 0, { type: 'draw' }).ok, false);
});

test('when the time runs out, the most cards on the foundations wins', () => {
  const state = createGame({ players: named(3), seed: 3 });
  state.players[0].board.foundations.S = 4;
  state.players[1].board.foundations.H = 6;
  state.players[2].board.foundations.H = 6;
  assert.ok(timeUp(state).ok);
  assert.deepEqual(state.results.winners, [1, 2]);
  assert.equal(timeUp(state).ok, false);
  const blank = createGame({ players: named(2), seed: 3 });
  timeUp(blank);
  assert.deepEqual(blank.results.winners, [], 'nobody wins with nothing placed');
});

test('the game ends early once everyone has stopped or left', () => {
  const state = createGame({ players: named(3), seed: 3 });
  state.players[1].board.foundations.H = 2;
  assert.ok(applyAction(state, 0, { type: 'giveUp' }).ok);
  assert.equal(applyAction(state, 0, { type: 'draw' }).ok, false);
  assert.equal(state.phase, 'play');
  assert.ok(forfeit(state, 2).ok);
  assert.equal(state.phase, 'play');
  assert.ok(applyAction(state, 1, { type: 'giveUp' }).ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [1]);
});

test('you see your own board with its face-down cards hidden, and only a count for everyone else', () => {
  const state = createGame({ players: named(2), seed: 8 });
  const view = viewFor(state, 0);
  assert.equal(view.board.stockCount, 24);
  assert.equal(JSON.stringify(view.board).includes('"stock"'), false);
  for (const pile of view.board.tableau) for (const c of pile.slice(0, -1)) assert.deepEqual(c, { up: false });
  assert.equal(viewFor(state, -1).board, null);
  assert.deepEqual(viewFor(state, -1).legal, []);
  assert.deepEqual(view.players.map((p) => p.placed), [0, 0]);
});

test('nonsense from a client is refused and changes nothing', () => {
  const state = createGame({ players: named(2), seed: 3 });
  const before = JSON.stringify(state);
  for (const action of NONSENSE) assert.equal(applyAction(state, 0, action).ok, false);
  for (const bad of [{ pile: 'stock' }, { pile: 'tableau', col: 9, index: 0 }, { pile: 'tableau', col: 1, index: 0 }, { pile: 'tableau', col: '1', index: 1 }, { pile: 'tableau', col: 1, index: -1 }, { pile: 'tableau' }, { pile: 'waste' }, { pile: 'foundation', col: 0 }]) {
    assert.equal(applyAction(state, 0, { type: 'tap', ...bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(applyAction(state, 5, { type: 'draw' }).ok, false);
  assert.equal(JSON.stringify(state), before);
});

test('a computer player never breaks its board, and sometimes gets somewhere', () => {
  let total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const state = createGame({ players: named(1), seed });
    const bot = createBot(0);
    for (let moves = 0; moves < 3000 && state.phase === 'play'; moves++) {
      const action = botAct(bot, viewFor(state, 0));
      const result = applyAction(state, 0, action);
      assert.ok(result.ok, `seed ${seed}: ${JSON.stringify(action)} ${result.error}`);
      checkSound(state.players[0].board);
    }
    assert.equal(state.phase, 'finished', `seed ${seed} stopped by itself`);
    total += placed(state.players[0].board);
  }
  assert.ok(total / 40 > 4, `the computer places a few cards on average (${total / 40})`);
});

test('the dealer runs the clock, moves the computers and stops cleanly', () => {
  const clock = fakeClock();
  let updates = 0;
  const dealer = createDealer({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', bot: true }, { id: 'c', name: 'C', bot: true }],
    rules: { minutes: 5 },
    random: seeded(4),
    clock,
    onUpdate: () => {
      updates += 1;
    },
  });
  assert.equal(dealer.deadline().kind, 'clock');
  assert.equal(dealer.deadline().ms, 300000);
  assert.ok(dealer.act(0, { type: 'draw' }).ok);
  assert.equal(dealer.act(1, { type: 'draw' }).ok, false, 'nobody plays a computer seat');
  clock.advance(60000);
  assert.ok(updates > 10, 'the computers have been moving');
  assert.equal(dealer.deadline().ms, 240000);
  assert.equal(dealer.finished(), false, 'a person is still playing');
  clock.advance(240000);
  assert.ok(dealer.finished(), 'time was called');
  assert.equal(dealer.deadline(), null);
  assert.equal(clock.pending(), 0);
  assert.equal(dealer.act(0, { type: 'draw' }).ok, false);
});

test('the dealer ends the game when the last person leaves or stops', () => {
  const clock = fakeClock();
  const dealer = createDealer({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], rules: { minutes: 5 }, random: seeded(4), clock });
  dealer.setAuto(1, true);
  assert.equal(dealer.isAuto(1), true);
  dealer.forfeit(1);
  assert.ok(dealer.hasLeft(1));
  assert.equal(dealer.finished(), false);
  assert.ok(dealer.act(0, { type: 'giveUp' }).ok);
  assert.ok(dealer.finished());
  assert.equal(clock.pending(), 0);
  dealer.stop();
});
