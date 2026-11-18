// Computer players for Solitaire. They see only their own board, face-down
// cards hidden. They play a plain, patient game: build the foundations, turn
// over face-down cards when they can, use the card from the draw pile, and
// stop once a whole pass through the pile has changed nothing.
import { destination } from './engine.js';

export function createBot(seat) {
  return { seat, idle: 0 };
}

export function botAct(bot, view) {
  if (!view.legal.length || !view.board) return null;
  const { board } = view;
  const tap = (source) => {
    bot.idle = 0;
    return { type: 'tap', ...source };
  };
  const top = (col) => ({ pile: 'tableau', col, index: board.tableau[col].length - 1 });

  // Anything that can go up to a foundation.
  if (board.waste.length && destination(board, { pile: 'waste' })?.to === 'foundation') return tap({ pile: 'waste' });
  for (let col = 0; col < 7; col++) {
    if (board.tableau[col].length && destination(board, top(col))?.to === 'foundation') return tap(top(col));
  }
  // Move a whole face-up run if that turns over a card, or frees a column for a waiting king.
  for (let col = 0; col < 7; col++) {
    const pile = board.tableau[col];
    const first = pile.findIndex((card) => card.up);
    if (first <= 0) continue;
    const source = { pile: 'tableau', col, index: first };
    if (destination(board, source)) return tap(source);
  }
  // Any home on the columns for the card from the draw pile.
  if (board.waste.length && destination(board, { pile: 'waste' })) return tap({ pile: 'waste' });
  // Nothing to do but turn the next card. A full pass with no move means the deal is stuck.
  const cycle = board.stockCount + board.wasteCount;
  bot.idle += 1;
  if (cycle === 0 || bot.idle > cycle + 1) return { type: 'giveUp' };
  return { type: 'draw' };
}
