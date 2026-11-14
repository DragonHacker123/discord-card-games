// The options in the settings menu: face card scores and how matching works.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction,
  closeLastCall,
  closeMatchWindow,
  createGame,
  DEFAULT_RULES,
  legalActions,
  normaliseRules,
  scoreCard,
  viewFor,
} from '../games/jacks/engine.js';

const c = (text) => ({ rank: text.slice(0, -1), suit: text.slice(-1) });
const COUNTDOWN = { matchMode: 'countdown', matchSeconds: 3 };

function started(rules, count = 3) {
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

test('the default settings are the ones Cameron chose', () => {
  assert.equal(DEFAULT_RULES.jack, 10);
  assert.equal(DEFAULT_RULES.queen, 10);
  assert.equal(DEFAULT_RULES.blackKing, 10);
  assert.equal(DEFAULT_RULES.redKing, -1);
  assert.equal(DEFAULT_RULES.matchMode, 'nextDiscard');
  assert.equal(DEFAULT_RULES.drawFromDiscard, false);
});

test('face card scores can be changed', () => {
  const rules = normaliseRules({ jack: 11, queen: 12, blackKing: 13, redKing: -2 });
  assert.equal(scoreCard(c('JS'), rules), 11);
  assert.equal(scoreCard(c('QD'), rules), 12);
  assert.equal(scoreCard(c('KC'), rules), 13);
  assert.equal(scoreCard(c('KH'), rules), -2);
});

test('jokers, aces and number cards are not affected by the face card settings', () => {
  const rules = normaliseRules({ jack: 11, queen: 12, blackKing: 13 });
  assert.equal(scoreCard({ rank: 'JOKER', suit: 'R' }, rules), -5);
  assert.equal(scoreCard(c('AS'), rules), 1);
  assert.equal(scoreCard(c('10S'), rules), 10);
});

test('the final totals use the game’s face card settings', () => {
  const state = started({ jack: 11, queen: 12, blackKing: 13 }, 2);
  state.players[0].slots = [c('JS'), c('QS'), c('KS'), c('2S')];
  state.players[1].slots = [c('AS'), c('AD'), c('2D'), c('2C')];
  state.drawPile.push(c('4C'));
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'callJacks' });
  state.drawPile.push(c('4D'));
  must(state, 1, { type: 'draw' });
  must(state, 1, { type: 'discard' });
  closeLastCall(state);
  const row = state.results.standings.find((entry) => entry.seat === 0);
  assert.equal(row.total, 11 + 12 + 13 + 2);
});

test('nonsense settings fall back to safe values', () => {
  const rules = normaliseRules({ jack: '', queen: 'abc', blackKing: 999, redKing: null, matchMode: 'x', matchSeconds: 0 });
  assert.equal(rules.jack, 10);
  assert.equal(rules.queen, 10);
  assert.equal(rules.blackKing, 30);
  assert.equal(rules.redKing, -1);
  assert.equal(rules.matchMode, 'nextDiscard');
  assert.equal(rules.matchSeconds, 2);
});

test('players can see the settings their game was dealt with', () => {
  const state = started(COUNTDOWN);
  assert.equal(viewFor(state, 1).rules.matchMode, 'countdown');
  assert.equal(viewFor(state, 1).rules.matchSeconds, 3);
});

test('countdown: matching opens on a discard and closes when the seconds run out', () => {
  const state = started(COUNTDOWN);
  assert.ok(!legalActions(state, 1).includes('match'));

  state.drawPile.push(c('6H'));
  must(state, 0, { type: 'draw' });
  const events = must(state, 0, { type: 'discard' });
  assert.ok(events.some((event) => event.type === 'matchWindowOpened' && event.seconds === 3));
  assert.ok(legalActions(state, 1).includes('match'));

  assert.ok(closeMatchWindow(state).ok);
  assert.ok(!legalActions(state, 1).includes('match'));
  const refused = applyAction(state, 1, { type: 'match', slot: 0 });
  assert.equal(refused.ok, false, 'a closed window refuses the attempt with no penalty');
  assert.equal(state.players[1].slots.length, 4);
});

test('countdown: the next player can’t draw until the seconds run out', () => {
  const state = started(COUNTDOWN);
  state.drawPile.push(c('6H'));
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'endTurn' });

  assert.equal(state.turn, 1);
  assert.ok(!legalActions(state, 1).includes('draw'));
  assert.equal(applyAction(state, 1, { type: 'draw' }).ok, false);

  closeMatchWindow(state);
  assert.ok(legalActions(state, 1).includes('draw'));
  must(state, 1, { type: 'draw' });
});

test('countdown: a power and calling Jacks can both happen while the seconds run', () => {
  const state = started(COUNTDOWN);
  state.drawPile.push(c('7H'));
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  assert.equal(state.phase, 'power');
  assert.ok(legalActions(state, 1).includes('match'));
  must(state, 0, { type: 'peek', target: { seat: 0, slot: 0 } });
  must(state, 0, { type: 'powerDone' });
  must(state, 0, { type: 'callJacks' });
  assert.equal(state.caller, 0);
  assert.ok(state.matchOpen, 'the window is still open for the same discard');
});

test('countdown: a correct match works during the window and does not extend it', () => {
  const state = started(COUNTDOWN);
  state.players[1].slots = [c('6S'), c('3D'), c('4D'), c('5C')];
  state.drawPile.push(c('6H'));
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  const events = must(state, 1, { type: 'match', slot: 0 });
  assert.ok(events.some((event) => event.type === 'matched'));
  assert.ok(!events.some((event) => event.type === 'matchWindowOpened'));
});

test('countdown: the final chance to match still works after the last go', () => {
  const state = started(COUNTDOWN, 2);
  state.players[0].slots = [c('6S'), c('3D'), c('4D'), c('5C')];
  state.drawPile.push(c('2H'));
  must(state, 0, { type: 'draw' });
  must(state, 0, { type: 'discard' });
  must(state, 0, { type: 'callJacks' });
  closeMatchWindow(state);

  state.drawPile.push(c('6H'));
  must(state, 1, { type: 'draw' });
  must(state, 1, { type: 'discard' });
  assert.equal(state.phase, 'lastCall');
  assert.equal(state.matchOpen, false);
  must(state, 0, { type: 'match', slot: 0 });
  assert.equal(state.players[0].slots[0], null);
});

test('until the next discard: nothing ever pauses play', () => {
  const state = started({ matchMode: 'nextDiscard' });
  state.drawPile.push(c('6H'));
  must(state, 0, { type: 'draw' });
  const events = must(state, 0, { type: 'discard' });
  assert.ok(!events.some((event) => event.type === 'matchWindowOpened'));
  must(state, 0, { type: 'endTurn' });
  assert.ok(legalActions(state, 1).includes('draw'));
  assert.ok(legalActions(state, 2).includes('match'));
  assert.equal(closeMatchWindow(state).ok, false);
});
