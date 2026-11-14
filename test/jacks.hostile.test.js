// What a cheating or broken client could send. The engine must refuse it,
// never throw, and never change the game when it refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, closeLastCall, closeMatchWindow, createGame, legalActions, nextRandom, normaliseRules, viewFor } from '../games/jacks/engine.js';

const PLAYERS = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

const NASTY = [
  undefined, null, true, false, 0, 1, 2, 3, 4, 5, 99, -1, 1.5, NaN, Infinity, '', '0', '1', 'length', '__proto__',
  'constructor', 'toString', {}, [], [0], { seat: 0, slot: 0 }, { seat: 1, slot: 'length' }, { seat: '__proto__', slot: 0 },
  { seat: 1, slot: 1 }, { seat: 2, slot: -1 }, { seat: 99, slot: 0 }, { seat: 1 }, { slot: 1 },
];
const TYPES = [
  'ready', 'draw', 'takeDiscard', 'place', 'swap', 'discard', 'peek', 'powerDone', 'skipPower', 'blindSwap', 'queenLook',
  'queenDecide', 'endTurn', 'callJacks', 'match', 'giveCard', 'keepCards', 'nonsense', '__proto__', 'constructor', 'hasOwnProperty',
];
const FIELDS = ['slot', 'owner', 'own', 'other', 'target', 'swap'];

test('rules from a stranger never throw and always come out sane', () => {
  for (const input of [null, undefined, 5, 'x', [], { jack: 'abc', matchSeconds: 1e9, matchMode: {}, drawFromDiscard: 'yes' }]) {
    const rules = normaliseRules(input);
    assert.ok(Number.isInteger(rules.jack) && rules.jack >= -20 && rules.jack <= 30);
    assert.ok(rules.matchSeconds >= 2 && rules.matchSeconds <= 15);
    assert.ok(['nextDiscard', 'countdown'].includes(rules.matchMode));
    assert.equal(typeof rules.drawFromDiscard, 'boolean');
  }
});

test('odd actions and odd seats are refused without a throw', () => {
  const state = createGame({ players: PLAYERS, seed: 5 });
  const before = JSON.stringify(state);
  for (const action of [null, undefined, 5, 'draw', [], {}, { type: 5 }, { type: ['draw'] }, { type: 'toString' }]) {
    assert.equal(applyAction(state, 0, action).ok, false);
  }
  for (const seat of [-1, 3, 1.5, '0', 'length', null, undefined, {}, '__proto__']) {
    assert.equal(applyAction(state, seat, { type: 'ready' }).ok, false);
  }
  assert.equal(JSON.stringify(state), before);
});

test('a slot called "length" can’t be swapped, matched or given', () => {
  const state = createGame({ players: PLAYERS, seed: 9 });
  for (const seat of [0, 1, 2]) applyAction(state, seat, { type: 'ready' });
  const turn = state.turn;
  assert.ok(applyAction(state, turn, { type: 'draw' }).ok);
  const before = JSON.stringify(state);
  for (const slot of ['length', '0', -1, 1.5, 99, null, {}, '__proto__']) {
    assert.equal(applyAction(state, turn, { type: 'swap', slot }).ok, false, `swap ${String(slot)}`);
  }
  assert.equal(JSON.stringify(state), before);
  assert.ok(applyAction(state, turn, { type: 'swap', slot: 0 }).ok);
  const mid = JSON.stringify(state);
  for (const slot of ['length', '1', -1, {}]) {
    assert.equal(applyAction(state, 0, { type: 'match', slot }).ok, false);
    assert.equal(applyAction(state, 0, { type: 'match', owner: 'length', slot: 0 }).ok, false);
    assert.equal(applyAction(state, 0, { type: 'match', owner: '1', slot: 0 }).ok, false);
  }
  assert.equal(JSON.stringify(state), mid);
});

function checkSound(state) {
  const cards = [...state.drawPile, ...state.discardPile, ...state.players.flatMap((p) => p.slots.filter(Boolean))];
  if (state.drawn) cards.push(state.drawn);
  assert.equal(cards.length, 54, 'a card was lost or copied');
  assert.equal(new Set(cards.map((c) => c.rank + c.suit)).size, 54);
  assert.ok(Number.isInteger(state.turn) && state.turn >= 0 && state.turn < state.players.length);
  for (const player of state.players) assert.ok(Array.isArray(player.slots));
}

test('thousands of random hostile moves never throw, never change a refused game and never lose a card', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const dice = { rng: seed * 7717 };
    const pick = (list) => list[Math.floor(nextRandom(dice) * list.length)];
    const rules = { matchMode: seed % 2 ? 'countdown' : 'nextDiscard', drawFromDiscard: seed % 3 === 0, matchSeconds: 3 };
    const state = createGame({ players: PLAYERS, seed, rules });
    for (let step = 0; step < 700 && state.phase !== 'finished'; step++) {
      const seat = nextRandom(dice) < 0.9 ? Math.floor(nextRandom(dice) * 3) : pick(NASTY);
      let action;
      if (nextRandom(dice) < 0.55 && Number.isInteger(seat) && state.players[seat]) {
        // A mostly sensible move, so games get somewhere.
        const legal = legalActions(state, seat);
        const type = legal.length ? pick(legal) : pick(TYPES);
        const slots = state.players[seat].slots.length;
        const other = (seat + 1 + Math.floor(nextRandom(dice) * 2)) % 3;
        action = {
          type,
          slot: Math.floor(nextRandom(dice) * (slots + 1)),
          own: Math.floor(nextRandom(dice) * slots),
          other: { seat: other, slot: Math.floor(nextRandom(dice) * 4) },
          target: { seat: state.power?.kind === 'peekOwn' ? seat : other, slot: Math.floor(nextRandom(dice) * 4) },
          swap: nextRandom(dice) < 0.5,
        };
        if (type === 'match' && nextRandom(dice) < 0.3) action.owner = other;
      } else {
        action = { type: pick(TYPES) };
        for (const field of FIELDS) if (nextRandom(dice) < 0.6) action[field] = pick(NASTY);
      }
      const before = JSON.stringify(state);
      let result;
      assert.doesNotThrow(() => {
        result = applyAction(state, seat, action);
      }, `seed ${seed} step ${step} ${JSON.stringify(action)}`);
      assert.equal(result.bug, undefined, `seed ${seed} step ${step} ${JSON.stringify(action)}\n${result.bug}`);
      if (!result.ok) assert.equal(JSON.stringify(state), before, `refused move changed the game: ${JSON.stringify(action)}`);
      else assert.doesNotThrow(() => JSON.stringify(result.events));
      checkSound(state);
      for (const viewer of [0, 1, 2, -1]) assert.doesNotThrow(() => viewFor(state, viewer));
      if (state.matchOpen && nextRandom(dice) < 0.5) closeMatchWindow(state);
      if (state.phase === 'lastCall' && nextRandom(dice) < 0.3) closeLastCall(state);
    }
  }
});

test('a server can deal from its own random source', () => {
  let calls = 0;
  const random = () => {
    calls += 1;
    return 0.999;
  };
  const a = createGame({ players: PLAYERS, seed: 1, random });
  const b = createGame({ players: PLAYERS, seed: 1 });
  assert.ok(calls >= 54);
  assert.notDeepEqual(a.drawPile, b.drawPile);
  assert.deepEqual(createGame({ players: PLAYERS, seed: 1 }), b, 'seeded games still replay');
});

test('a spectator sees no hidden card', () => {
  const state = createGame({ players: PLAYERS, seed: 3 });
  const view = viewFor(state, -1);
  assert.deepEqual(view.legal, []);
  assert.ok(!JSON.stringify(view.players).includes('rank'));
});

test('leaving puts your cards under the discard pile and play passes you by', async () => {
  const { forfeit } = await import('../games/jacks/engine.js');
  const state = createGame({ players: PLAYERS, seed: 21 });
  for (const seat of [0, 1, 2]) applyAction(state, seat, { type: 'ready' });
  const first = state.turn;
  applyAction(state, first, { type: 'draw' });
  applyAction(state, first, { type: 'swap', slot: 0 });
  const top = state.discardPile.at(-1);
  const leaver = first;
  const mine = state.players[leaver].slots.filter(Boolean);
  const result = forfeit(state, leaver);
  assert.ok(result.ok);
  assert.deepEqual(state.discardPile.slice(0, 4), mine);
  assert.equal(state.discardPile.at(-1), top, 'the top card stays where it was');
  assert.ok(state.players[leaver].slots.every((slot) => slot === null));
  assert.notEqual(state.turn, leaver);
  assert.equal(state.phase, 'draw');
  assert.equal(applyAction(state, leaver, { type: 'match', slot: 0 }).ok, false);
  assert.deepEqual(legalActions(state, leaver), []);
  checkSound(state);
  // Play goes round the two who are left and never lands on the leaver.
  for (let i = 0; i < 6; i++) {
    const turn = state.turn;
    assert.notEqual(turn, leaver);
    applyAction(state, turn, { type: 'draw' });
    applyAction(state, turn, { type: 'swap', slot: 1 });
    applyAction(state, turn, { type: 'endTurn' });
  }
  // A second leaver ends it, and the one who stayed wins.
  const other = (leaver + 1) % 3;
  const last = (leaver + 2) % 3;
  assert.ok(forfeit(state, other).ok);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.results.winners, [last]);
  assert.equal(forfeit(state, last).ok, false);
  checkSound(state);
});

test('leaving while holding a drawn card, or while owing one, doesn’t jam the game', async () => {
  const { forfeit } = await import('../games/jacks/engine.js');
  const state = createGame({ players: PLAYERS, seed: 8 });
  for (const seat of [0, 1, 2]) applyAction(state, seat, { type: 'ready' });
  const turn = state.turn;
  applyAction(state, turn, { type: 'draw' });
  assert.ok(forfeit(state, turn).ok);
  assert.equal(state.drawn, null);
  assert.equal(state.phase, 'draw');
  checkSound(state);
  // Owing a card: rig a right match on someone else's card.
  const a = state.turn;
  const b = state.players.findIndex((p, i) => i !== a && !p.out);
  state.discardPile.push(state.drawPile.pop());
  const rank = state.discardPile.at(-1).rank;
  state.players[b].slots[0] = { ...state.players[b].slots[0], rank };
  assert.ok(applyAction(state, a, { type: 'match', owner: b, slot: 0 }).ok);
  assert.ok(state.give);
  const game2 = JSON.parse(JSON.stringify(state));
  assert.ok(forfeit(game2, a).ok);
  assert.equal(game2.give, null);
  assert.equal(game2.phase, 'finished');
});
