// The Crazy Eights table. It draws the server's view and turns clicks into moves.
import { SUIT_NAMES, SUITS } from '../shared/cards.js';
import { SUIT_SYMBOL, createShell } from '../shared/shell.js';

const RULES_HTML = `
<h3>The aim</h3>
<p>Be the first to get rid of all your cards.</p>
<h3>Your turn</h3>
<ul>
<li>Play a card that matches the top of the discard pile by suit or by rank.</li>
<li>An eight can be played on anything. You then pick the suit the next player has to follow.</li>
<li>If you can’t play, or would rather not, draw one card. You can then play a card or pass.</li>
<li>When the draw pile runs out, the discard pile is shuffled to make a new one.</li>
</ul>
<h3>The deal</h3>
<p>2 to 6 players. Two players get 7 cards each; three or more get 5 each.</p>
<h3>Scores</h3>
<p>The first player out wins. Everyone else is ranked by the cards they’re left with: eights count 50, tens and picture cards 10, aces 1, other cards their number. If nobody can play and the piles are empty, the fewest points wins.</p>
<h3>Leaving</h3>
<p>If you leave, your cards go to the bottom of the draw pile and you can’t win.</p>`;

export function createCrazyTable(hooks) {
  const { cardSvg, escapeHtml } = hooks;
  const shell = createShell(hooks, { id: 'crazy8', rulesTitle: 'Crazy Eights rules', rulesHtml: RULES_HTML });
  let picking = null; // the index of an eight waiting for its suit
  let fresh = null; // "rank+suit" of the card just drawn

  const red = (suit) => suit === 'H' || suit === 'D';
  const suitMark = (suit) => `<span class="${red(suit) ? 'suit-red' : ''}">${SUIT_SYMBOL[suit]}</span>`;

  shell.setDraw((view) => {
    const me = view.players[view.you];
    const myTurn = view.phase === 'play' && view.turn === view.you;
    const others = view.players
      .map((player, seat) => {
        if (seat === view.you) return '';
        const chip = shell.chipFor(seat);
        const winner = view.results?.winners.includes(seat) ? ' winner' : '';
        const shown = player.hand ? `<div class="stack">${player.hand.map((card) => `<span class="pc">${cardSvg(card)}</span>`).join('')}</div>` : `<span class="held-count">${player.count}</span>`;
        return `<div class="seat${view.phase === 'play' && view.turn === seat ? ' active' : ''}${winner}${player.out ? ' is-out' : ''}">
          <div class="seat-head"><span class="seat-name">${escapeHtml(player.name)}</span>${chip ? `<span class="seat-chip">${chip}</span>` : ''}</div>${shown}</div>`;
      })
      .join('');
    const canDraw = myTurn && view.legal.includes('draw');
    const pile = view.stockCount
      ? `<button type="button" class="pc back-face${canDraw ? ' can-play' : ''}" data-move="draw"${canDraw ? '' : ' disabled'} aria-label="Draw a card"></button>`
      : '<span class="pc slot"></span>';
    const named = view.suit !== view.top.suit ? `<p class="c8-suit">Suit is ${suitMark(view.suit)} ${SUIT_NAMES[view.suit]}</p>` : '';
    const hand = me
      ? me.hand
          .map((card, index) => {
            const key = card.rank + card.suit;
            const playable = myTurn && view.playable.includes(index);
            const classes = `pc${playable ? ' can-play' : myTurn ? ' is-dim' : ''}${picking === index ? ' is-picked' : ''}${fresh === key ? ' is-new' : ''}`;
            return playable ? `<button type="button" class="${classes}" data-card="${index}" aria-label="Play ${card.rank} of ${SUIT_NAMES[card.suit]}">${cardSvg(card)}</button>` : `<span class="${classes}">${cardSvg(card)}</span>`;
          })
      : [];
    let prompt;
    if (me?.out) prompt = { text: 'You left this game, so you’re watching.' };
    else if (!myTurn) prompt = { text: `${shell.turnText(view.turn)}${me ? '' : ' You’re watching.'}` };
    else if (picking !== null) {
      prompt = {
        text: 'Pick a suit.',
        mine: true,
        buttons: `${SUITS.map((suit) => `<button type="button" class="btn suit-btn${red(suit) ? ' suit-red' : ''}" data-suit="${suit}" aria-label="${SUIT_NAMES[suit]}">${SUIT_SYMBOL[suit]}</button>`).join('')}<button type="button" class="btn" data-cancel>Cancel</button>`,
      };
    } else {
      const button = view.legal.includes('draw') ? '<button type="button" class="btn" data-move="draw">Draw</button>' : '<button type="button" class="btn" data-move="pass">Pass</button>';
      prompt = { text: `Your turn. ${shell.countdown}`, mine: true, buttons: button };
    }
    const rows = (view.results?.rows ?? []).map((row) => ({
      name: shell.who(row.seat),
      detail: row.out ? '' : row.cards ? `${row.cards} ${row.cards === 1 ? 'card' : 'cards'} left` : 'Out first',
      total: row.out ? '' : row.points,
      winner: view.results.winners.includes(row.seat),
      out: row.out,
    }));
    return `<div class="table">
      ${shell.top('')}
      <div class="opponents">${others}</div>
      <div class="shell-middle">
        <div class="pile-wrap" style="--card-w: var(--card-mid)">${pile}<span class="pile-label">${view.stockCount ? `${view.stockCount} to draw` : 'Pile empty'}</span></div>
        <div class="pile-wrap" style="--card-w: var(--card-mid)"><span class="pc">${cardSvg(view.top)}</span><span class="pile-label">Discard</span></div>
        ${named}
      </div>
      <div class="me">
        ${me ? `<div class="seat seat-me${myTurn ? ' active' : ''}${view.results?.winners.includes(view.you) ? ' winner' : ''}">${shell.fan(hand) || '<p class="shell-note">No cards</p>'}</div>` : ''}
        ${shell.prompt(prompt)}
      </div>
      ${shell.scores(shell.winnersTitle(view.results?.winners ?? []), rows)}
    </div>`;
  });

  shell.setClick((event, view) => {
    if (!view) return;
    const card = event.target.closest('[data-card]');
    if (card) {
      const index = Number(card.dataset.card);
      if (view.players[view.you].hand[index]?.rank === '8') {
        picking = picking === index ? null : index;
        shell.render();
      } else hooks.act({ type: 'play', card: index });
      return;
    }
    const suit = event.target.closest('[data-suit]');
    if (suit && picking !== null) {
      hooks.act({ type: 'play', card: picking, suit: suit.dataset.suit });
      return;
    }
    if (event.target.closest('[data-cancel]')) {
      picking = null;
      shell.render();
      return;
    }
    const move = event.target.closest('[data-move]');
    if (move && !move.disabled) hooks.act({ type: move.dataset.move });
  });

  return shell.api({
    onView(view, events) {
      picking = null;
      const drew = events.find((event) => event.type === 'drew' && event.seat === view.you && event.card);
      fresh = drew ? drew.card.rank + drew.card.suit : null;
    },
  });
}
