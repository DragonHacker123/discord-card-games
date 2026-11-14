// Plays thousands of computer-only games, checking the rules hold at every step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, closeLastCall, closeMatchWindow, createGame, eventFor, viewFor } from '../games/jacks/engine.js';
import { botAct, botMatchOther, botMatchSlot, botNoticesMatch, botObserve, createBot } from '../games/jacks/bots.js';

function cardsInPlay(state) {
  const cards = [...state.drawPile, ...state.discardPile];
  if (state.drawn) cards.push(state.drawn);
  for (const player of state.players) cards.push(...player.slots.filter(Boolean));
  return cards;
}

function assertDeckIntact(state, context) {
  const cards = cardsInPlay(state);
  assert.equal(cards.length, 54, `card count changed: ${context}`);
  assert.equal(new Set(cards.map((card) => `${card.rank}${card.suit}`)).size, 54, `duplicate card: ${context}`);
}

function assertNoLeak(state, viewer) {
  const view = viewFor(state, viewer);
  if (state.phase === 'finished' || state.phase === 'peek') return;
  view.players.forEach((player) => {
    player.slots.forEach((slot) => assert.equal(slot?.card, undefined, 'a hidden card reached a player'));
  });
  if (viewer !== state.turn && state.drawnFrom !== 'discard') assert.equal(view.drawn, null, 'someone else’s drawn card reached a player');
}

function playOut(playerCount, seed, rules) {
  const state = createGame({
    players: Array.from({ length: playerCount }, (_, i) => ({ id: `b${i}`, name: `B${i}` })),
    seed,
    rules,
  });
  const bots = state.players.map((_p, seat) => createBot(seat, seed + seat + 1));
  const stats = { matches: 0, otherMatches: 0, failed: 0, powers: 0, swaps: 0, taken: 0, turns: 0, callerWon: false };

  const deliver = (events) => {
    for (const event of events) {
      for (const bot of bots) botObserve(bot, eventFor(event, bot.seat));
      if (event.type === 'matched') stats.matches += 1;
      if (event.type === 'matched' && event.owner !== event.seat) stats.otherMatches += 1;
      if (event.type === 'tookDiscard') stats.taken += 1;
      if (event.type === 'matchFailed') stats.failed += 1;
      if (event.type === 'looked' || event.type === 'blindSwapped') stats.powers += 1;
      if (event.type === 'swapped') stats.swaps += 1;
      if (event.type === 'turnStarted') stats.turns += 1;
    }
  };

  const apply = (seat, action) => {
    const result = applyAction(state, seat, action);
    assert.ok(result.ok, `seed ${seed}, seat ${seat}, ${JSON.stringify(action)}: ${result.error}`);
    deliver(result.events);
    assertDeckIntact(state, `seed ${seed} after ${action.type}`);
    assertNoLeak(state, (seat + 1) % playerCount);
  };

  const tryMatches = () => {
    for (const bot of bots) {
      const slot = botMatchSlot(bot, viewFor(state, bot.seat));
      if (slot !== null && botNoticesMatch(bot)) apply(bot.seat, { type: 'match', slot });
      const other = botMatchOther(bot, viewFor(state, bot.seat));
      if (other && botNoticesMatch(bot)) {
        apply(bot.seat, { type: 'match', owner: other.seat, slot: other.slot });
        if (state.give) apply(bot.seat, botAct(bot, viewFor(state, bot.seat)));
      }
    }
  };

  for (const bot of bots) apply(bot.seat, botAct(bot, viewFor(state, bot.seat)));

  for (let step = 0; state.phase !== 'lastCall'; step++) {
    assert.ok(step < 20000, `seed ${seed}: the game never ended`);
    tryMatches();
    if (state.phase === 'lastCall') break;
    const action = botAct(bots[state.turn], viewFor(state, state.turn));
    if (!action) {
      // The only time a player has no move is while a matching countdown runs.
      assert.ok(state.matchOpen, `seed ${seed}: bot had no move in phase ${state.phase}`);
      deliver(closeMatchWindow(state).events);
      continue;
    }
    apply(state.turn, action);
  }
  tryMatches();

  assert.ok(closeLastCall(state).ok);
  const { results } = state;
  const lowest = Math.min(...results.standings.map((row) => row.total));
  assert.equal(results.best, lowest);
  for (const winner of results.winners) {
    assert.equal(results.standings.find((row) => row.seat === winner).total, lowest);
  }
  stats.callerWon = results.winners.includes(state.caller);
  return stats;
}

function playMany(label, rules, gamesPerSize) {
  const totals = { games: 0, turns: 0, matches: 0, otherMatches: 0, failed: 0, powers: 0, swaps: 0, taken: 0, callerWins: 0 };
  let longestRounds = 0;
  for (let players = 2; players <= 8; players++) {
    for (let i = 0; i < gamesPerSize; i++) {
      const stats = playOut(players, players * 100000 + i, rules);
      totals.games += 1;
      totals.turns += stats.turns;
      totals.matches += stats.matches;
      totals.otherMatches += stats.otherMatches;
      totals.taken += stats.taken;
      totals.failed += stats.failed;
      totals.powers += stats.powers;
      totals.swaps += stats.swaps;
      if (stats.callerWon) totals.callerWins += 1;
      longestRounds = Math.max(longestRounds, stats.turns / players);
    }
  }
  const perGame = (value) => (value / totals.games).toFixed(1);
  console.log(
    `${label}: ${totals.games} games. Per game: ${perGame(totals.turns)} turns, ${perGame(totals.swaps)} swaps, ` +
      `${perGame(totals.powers)} powers, ${perGame(totals.matches)} matches (${perGame(totals.otherMatches)} of someone else’s card), ` +
      `${perGame(totals.failed)} failed matches, ${perGame(totals.taken)} cards taken from the discard pile. ` +
      `Caller won ${((100 * totals.callerWins) / totals.games).toFixed(0)}%. Longest ${longestRounds.toFixed(1)} rounds.`,
  );
  // Bots that never matched, failed or used powers would leave whole rules untested.
  assert.ok(totals.matches > 0, 'bots made correct matches');
  assert.ok(totals.failed > 0, 'bots made wrong matches');
  assert.ok(totals.powers > 0, 'bots used powers');
  assert.ok(totals.otherMatches > 0, 'bots matched each other’s cards');
  assert.ok(longestRounds <= 14, 'games end in reasonable time');
  return totals;
}

test('bot games with the default settings finish legally, every card accounted for', () => {
  playMany('Default settings', undefined, 400);
});

test('bot games with a matching countdown finish legally', () => {
  playMany('Countdown', { matchMode: 'countdown', matchSeconds: 3 }, 200);
});

test('bot games with face cards at 11, 12 and 13 finish legally', () => {
  playMany('Face cards 11/12/13', { jack: 11, queen: 12, blackKing: 13 }, 200);
});

test('bot games with picking up from the discard pile finish legally', () => {
  const totals = playMany('Pick up from discard', { drawFromDiscard: true }, 200);
  assert.ok(totals.taken > 0, 'bots took cards from the discard pile');
});

test('the same seed always deals the same game', () => {
  const players = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ];
  const first = createGame({ players, seed: 7 });
  const second = createGame({ players, seed: 7 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first.drawPile, createGame({ players, seed: 8 }).drawPile);
});
