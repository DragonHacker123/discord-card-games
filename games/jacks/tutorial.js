// The Jacks tutorial: one fixed game against one opponent, played on the real
// engine with a stacked deck. There's no browser code here, so
// test/jacks.tutorial.test.js can play the whole script and check what it says.
//
// Every step has a section, a title and a body, plus exactly one of:
//   next:   a button label. The step waits for that button.
//   expect: the one move the player may make. { type: 'pickForMatch' } means picking
//           a card to match with, which isn't a game action in its own right.
//   ada:    moves the opponent plays by itself, after which the next step starts.
//   last:   the end of the script.
// A next step can also have finish: true, which turns the cards over.

import { applyAction, buildDeck, createGame, DEFAULT_RULES } from './engine.js';

export const TUTOR_YOU = 0;
export const TUTOR_ADA = 1;

// Slots run top left, top right, bottom left, bottom right.
const TUTORIAL_HANDS = [
  ['9C', '3H', 'KS', '4D'],
  ['8S', '4C', 'JOKERR', 'AD'],
];
// In the order they come off the pile. The black king is the penalty card.
const TUTORIAL_DRAWS = ['2C', '5S', 'KC', '7H', '6D', '10D', 'KH', 'JC', '9S', 'QD', '3S'];

export function createTutorialGame() {
  const state = createGame({
    players: [
      { id: 'you', name: 'You' },
      { id: 'ada', name: 'Ada' },
    ],
    seed: 1,
    rules: DEFAULT_RULES,
  });
  const deck = buildDeck();
  const take = (code) => {
    const index = deck.findIndex((card) => `${card.rank}${card.suit}` === code);
    if (index === -1) throw new Error(`The tutorial uses ${code} twice.`);
    return deck.splice(index, 1)[0];
  };
  state.players.forEach((player, seat) => {
    player.slots = TUTORIAL_HANDS[seat].map(take);
  });
  const scripted = TUTORIAL_DRAWS.map(take);
  // The rest of the deck sits under the scripted cards and is never reached.
  state.drawPile = [...deck, ...scripted.reverse()];
  state.turn = TUTOR_YOU;
  applyAction(state, TUTOR_ADA, { type: 'ready' });
  return state;
}

const YOUR_CARD = (slot) => ({ seat: TUTOR_YOU, slot });
const ADAS_CARD = (slot) => ({ seat: TUTOR_ADA, slot });
const END_TURN = { title: 'End your turn', body: 'Press End turn.', expect: { type: 'endTurn' } };
const DRAW = { title: 'Your turn', body: 'Take a card from the draw pile.', expect: { type: 'draw' } };
const ADA_TURN = { title: 'Ada’s turn', body: 'Watch the discard pile.' };

export const TUTORIAL_STEPS = [
  {
    id: 'welcome',
    section: 'Starting',
    title: 'Welcome to Jacks',
    body: 'Everyone has face-down cards, and the lowest total wins when the game ends. You’ll play one short game against Ada, and each step tells you what to do. Number cards score their number, and these score:',
    scores: true,
    next: 'Start',
  },
  {
    id: 'peek',
    section: 'Starting',
    title: 'Memorise two cards',
    body: 'You have four cards in a 2×2 grid. You get one look at your nearest two, then they turn face down for the rest of the game. Yours are a black king worth 10 (bottom left) and a 4 (bottom right). Press I’ve memorised them when you’re ready.',
    expect: { type: 'ready' },
    highlight: { slots: [YOUR_CARD(2), YOUR_CARD(3)] },
  },
  {
    id: 'draw1',
    section: 'Your turn',
    title: 'Take a card',
    body: 'On your turn, take the top card of the draw pile. Only you can see it.',
    expect: { type: 'draw' },
  },
  {
    id: 'swap1',
    section: 'Your turn',
    title: 'Swap it in',
    body: 'You drew a 2. You can swap it with any of your cards, or discard it. Your bottom-left card is the black king, worth 10, so pick that one. The card you swap out goes face up on the discard pile. If you swap a card you’ve never seen, that’s when you find out what it was.',
    expect: { type: 'swap', slot: 2 },
  },
  {
    id: 'end1',
    section: 'Your turn',
    title: 'End your turn',
    body: 'At the end of your turn you can call Jacks, which starts the end of the game. It’s too early for that, so press End turn.',
    expect: { type: 'endTurn' },
  },
  {
    id: 'ada1',
    section: 'Matching',
    title: 'Ada’s turn',
    body: 'Play goes clockwise round the table. Watch what Ada discards.',
    ada: [{ type: 'draw' }, { type: 'swap', slot: 1 }],
  },
  {
    id: 'match1',
    section: 'Matching',
    title: 'Spot a match',
    body: 'Ada discarded a 4, and you remember that your bottom-right card is a 4. Anyone can try to match the top card of the pile, even on someone else’s turn, until the next card lands on it. Only the rank has to match, not the suit. Pick your bottom-right card.',
    expect: { type: 'pickForMatch', ...YOUR_CARD(3) },
    highlight: { discard: true },
  },
  {
    id: 'match2',
    section: 'Matching',
    title: 'Turn it over',
    body: 'Now press the discard pile to try it.',
    expect: { type: 'match', owner: TUTOR_YOU, slot: 3 },
  },
  {
    id: 'match3',
    section: 'Matching',
    title: 'One card fewer',
    body: 'You were right, so your 4 stays on the pile and you don’t replace it. Those 4 points are gone. You can go all the way down to no cards, and the game carries on.',
    next: 'Next',
  },
  {
    id: 'wrong1',
    section: 'Matching',
    title: 'What if you’re wrong?',
    body: 'The top card is still a 4. You’ve never seen your top-left card, so try matching with it to see what happens. Pick your top-left card.',
    expect: { type: 'pickForMatch', ...YOUR_CARD(0) },
  },
  {
    id: 'wrong2',
    section: 'Matching',
    title: 'Take the risk',
    body: 'Now press the discard pile to try it.',
    expect: { type: 'match', owner: TUTOR_YOU, slot: 0 },
  },
  {
    id: 'wrong3',
    section: 'Matching',
    title: 'A penalty',
    body: 'It was a 9, and everyone saw it. It goes back where it was, and whoever tried takes a penalty card from the draw pile. That card sits in a new place, and you don’t get to look at it. At least you now know your top-left card is a 9.',
    next: 'Next',
  },
  {
    id: 'ada1End',
    section: 'Matching',
    title: 'Ada’s turn',
    body: 'Ada ends that turn, so it’s back to you.',
    ada: [{ type: 'endTurn' }],
  },
  { id: 'draw2', section: 'Powers', ...DRAW },
  {
    id: 'power7',
    section: 'Powers',
    title: 'A 7 or 8',
    body: 'You drew a 7. Some cards have a power, but only if you put them straight on the pile after drawing them. A 7 or 8 lets you look at one of your own cards. Press the discard pile to put it there.',
    expect: { type: 'discard' },
  },
  {
    id: 'peek7',
    section: 'Powers',
    title: 'Look at your own card',
    body: 'Powers are optional, but this one is useful. You’ve never seen your top-right card, so pick it.',
    expect: { type: 'peek', target: YOUR_CARD(1) },
  },
  {
    id: 'seen7',
    section: 'Powers',
    title: 'Remember it',
    body: 'It’s a 3. Remember that, then press Done.',
    expect: { type: 'powerDone' },
  },
  { id: 'end2', section: 'Powers', ...END_TURN },
  { id: 'ada2', section: 'Powers', ...ADA_TURN, ada: [{ type: 'draw' }, { type: 'discard' }, { type: 'endTurn' }] },
  { id: 'draw3', section: 'Powers', ...DRAW },
  {
    id: 'power10',
    section: 'Powers',
    title: 'A 9 or 10',
    body: 'You drew a 10. Put a 9 or 10 straight on the pile to look at someone else’s card. Press the discard pile.',
    expect: { type: 'discard' },
  },
  {
    id: 'peek10',
    section: 'Powers',
    title: 'Look at Ada’s card',
    body: 'Pick Ada’s bottom-left card.',
    expect: { type: 'peek', target: ADAS_CARD(2) },
  },
  {
    id: 'seen10',
    section: 'Powers',
    title: 'A joker!',
    body: 'Ada’s bottom-left card is a joker, worth −5. Remember where it is, because you’re about to take it. Press Done.',
    expect: { type: 'powerDone' },
  },
  { id: 'end3', section: 'Powers', ...END_TURN },
  { id: 'ada3', section: 'Powers', ...ADA_TURN, ada: [{ type: 'draw' }, { type: 'swap', slot: 0 }] },
  {
    id: 'noPower',
    section: 'Powers',
    title: 'No power this time',
    body: 'Ada swapped out an 8. A card only has its power if it was just drawn and put straight on the pile, so a swapped-out 8 does nothing.',
    next: 'Next',
    highlight: { discard: true },
  },
  {
    id: 'ada3End',
    section: 'Powers',
    title: 'Ada’s turn',
    body: 'Ada ends that turn, so it’s back to you.',
    ada: [{ type: 'endTurn' }],
  },
  { id: 'draw4', section: 'Powers', ...DRAW },
  {
    id: 'powerJ',
    section: 'Powers',
    title: 'A jack',
    body: 'You drew a jack. Put it straight on the pile to swap one of your cards with one of an opponent’s, without looking at either. Press the discard pile.',
    expect: { type: 'discard' },
  },
  {
    id: 'blind',
    section: 'Powers',
    title: 'Take the joker',
    body: 'Your top-left card is the 9, and Ada’s bottom-left card is the joker. Pick both to swap them.',
    expect: { type: 'blindSwap', own: 0, other: ADAS_CARD(2) },
  },
  { id: 'end4', section: 'Powers', ...END_TURN },
  { id: 'ada4', section: 'Powers', ...ADA_TURN, ada: [{ type: 'draw' }, { type: 'discard' }, { type: 'skipPower' }] },
  {
    id: 'other1',
    section: 'Matching',
    title: 'Match Ada’s card',
    body: 'Ada discarded a 9, and you know Ada’s bottom-left card is the 9 you just swapped over. You can try to match with any player’s card, not just your own. Pick Ada’s bottom-left card.',
    expect: { type: 'pickForMatch', ...ADAS_CARD(2) },
    highlight: { discard: true },
  },
  {
    id: 'other2',
    section: 'Matching',
    title: 'Turn it over',
    body: 'Now press the discard pile to try it.',
    expect: { type: 'match', owner: TUTOR_ADA, slot: 2 },
  },
  {
    id: 'other3',
    section: 'Matching',
    title: 'Give a card',
    body: 'You were right, so the 9 stays on the pile. Now you can give Ada one of your cards to fill the gap, and nobody gets to look at it. Everyone waits while you choose. If you keep your cards, Ada gets one from the draw pile instead. You’ve never seen your penalty card, on the far right of your cards, so give that one.',
    expect: { type: 'giveCard', slot: 4 },
  },
  {
    id: 'ada4End',
    section: 'Matching',
    title: 'Ada’s turn',
    body: 'Ada ends that turn, so it’s back to you.',
    ada: [{ type: 'endTurn' }],
  },
  { id: 'draw5', section: 'Powers', ...DRAW },
  {
    id: 'powerQ',
    section: 'Powers',
    title: 'A queen',
    body: 'You drew a queen. Put it straight on the pile to look at one of your cards and one of an opponent’s, then choose whether to swap them. Press the discard pile.',
    expect: { type: 'discard' },
  },
  {
    id: 'queen1',
    section: 'Powers',
    title: 'Look at two cards',
    body: 'Pick your bottom-left card, the 2, and Ada’s bottom-right card.',
    expect: { type: 'queenLook', own: 2, other: ADAS_CARD(3) },
  },
  {
    id: 'queen2',
    section: 'Powers',
    title: 'Your choice',
    body: 'Your card is a 2, and Ada’s card is an ace, worth 1. Swapping saves you a point, but it’s up to you.',
    expect: { type: 'queenDecide' },
  },
  {
    id: 'call',
    section: 'Calling Jacks',
    title: 'Call Jacks',
    body: 'You know all your cards now, and your total looks low. Call Jacks at the end of your turn when you think you have the lowest total. If you only tie for lowest, you lose. Everyone else then gets one more go, and your cards can still be swapped with. Press the Jacks button.',
    expect: { type: 'callJacks' },
  },
  {
    id: 'ada5',
    section: 'Calling Jacks',
    title: 'Ada’s last go',
    body: 'Ada gets one more go, because you called.',
    ada: [{ type: 'draw' }, { type: 'discard' }],
    pause: 2000,
  },
  {
    id: 'last1',
    section: 'Calling Jacks',
    title: 'One last match',
    body: 'Ada discarded a 3, and your top-right card is a 3. Calling doesn’t stop you matching, and there’s a short final chance after the last go. Pick your top-right card.',
    expect: { type: 'pickForMatch', ...YOUR_CARD(1) },
    highlight: { discard: true },
  },
  {
    id: 'last2',
    section: 'Calling Jacks',
    title: 'Turn it over',
    body: 'Now press the discard pile to try it.',
    expect: { type: 'match', owner: TUTOR_YOU, slot: 1 },
  },
  {
    id: 'reveal',
    section: 'Calling Jacks',
    title: 'Count them up',
    body: 'Now every card turns over and the totals are counted. The lowest total wins.',
    next: 'Turn the cards over',
    finish: true,
  },
  {
    id: 'done',
    section: 'Calling Jacks',
    title: 'That’s Jacks',
    body: 'Real games work the same way, with more players and no step-by-step help. The tutorial always uses the standard scores, and Settings lets you change the scores, how matching works and whether you can pick up from the discard pile.',
    last: true,
  },
];

/** Whether this step lets the player make this move. */
export function stepAllows(step, action) {
  const expected = step?.expect;
  if (!expected || expected.type !== action.type) return false;
  return Object.entries(expected).every(([key, value]) => JSON.stringify(action[key]) === JSON.stringify(value));
}

/** The cards this step wants the player to pick. */
export function stepSlots(step) {
  const expected = step?.expect;
  if (!expected) return [];
  if (expected.type === 'swap' || expected.type === 'giveCard') return [YOUR_CARD(expected.slot)];
  if (expected.type === 'pickForMatch') return [{ seat: expected.seat, slot: expected.slot }];
  if (expected.type === 'peek') return [expected.target];
  if (expected.type === 'blindSwap' || expected.type === 'queenLook') return [YOUR_CARD(expected.own), expected.other];
  return [];
}
