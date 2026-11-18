// The Rummy table. It draws the server's view and turns clicks into moves.
import { SUIT_NAMES, lowValue, sameCard } from '../shared/cards.js';
import { createShell } from '../shared/shell.js';
import { meldKind } from './engine.js';

const RULES_HTML = `
<h3>The aim</h3>
<p>Be the first to get rid of all your cards, by laying them down in sets and runs.</p>
<ul>
<li>A <b>set</b> is three or four cards of the same rank, such as three 7s.</li>
<li>A <b>run</b> is three or more cards in a row in the same suit, such as the 4, 5 and 6 of hearts. The ace is low: ace, 2, 3.</li>
</ul>
<h3>Your turn</h3>
<ul>
<li>Take the top card of the draw pile or of the discard pile.</li>
<li>If you have a set or run, tap its cards and press <b>Meld</b> to lay it down.</li>
<li>To add a card to a set or run already on the table, tap the card and then tap that set or run.</li>
<li>Finish by tapping one card and pressing <b>Discard</b>. You can’t discard the card you just took from the discard pile.</li>
</ul>
<h3>The deal</h3>
<p>2 to 6 players. Two players get 10 cards each, three or four get 7, and five or six get 6.</p>
<h3>Scores</h3>
<p>The first player out wins. Everyone else is ranked by the cards they’re left holding: picture cards count 10, aces 1, other cards their number. If the draw pile runs out for the third time, the game stops and the fewest points wins.</p>
<h3>Leaving</h3>
<p>If you leave, your cards go to the bottom of the draw pile and you can’t win.</p>`;

export function createRummyTable(hooks) {
  const { cardSvg, escapeHtml } = hooks;
  const shell = createShell(hooks, { id: 'rummy', rulesTitle: 'Rummy rules', rulesHtml: RULES_HTML });
  let picks = []; // positions in your hand that are selected
  let fresh = null; // "rank+suit" of the card just taken
  let byRank = false;
  let handKey = '';

  const keyOf = (hand) => hand.map((card) => card.rank + card.suit).join();
  const small = (card) => `<span class="pc">${cardSvg(card)}</span>`;

  shell.setDraw((view) => {
    const me = view.players[view.you];
    const myTurn = view.legal.length > 0;
    const drawing = view.legal.includes('draw');
    const acting = view.legal.includes('discard');
    const chosen = me ? picks.map((index) => me.hand[index]) : [];
    const one = chosen.length === 1 ? chosen[0] : null;

    const others = view.players
      .map((player, seat) => {
        if (seat === view.you) return '';
        const chip = shell.chipFor(seat);
        const shown = player.hand ? `<div class="stack">${player.hand.map(small).join('')}</div>` : `<span class="held-count">${player.count}</span>`;
        return `<div class="seat${view.phase === 'play' && view.turn === seat ? ' active' : ''}${view.results?.winners.includes(seat) ? ' winner' : ''}${player.out ? ' is-out' : ''}">
          <div class="seat-head"><span class="seat-name">${escapeHtml(player.name)}</span>${chip ? `<span class="seat-chip">${chip}</span>` : ''}</div>${shown}</div>`;
      })
      .join('');

    const stock = view.stockCount
      ? `<button type="button" class="pc back-face${drawing ? ' can-play' : ''}" data-draw="stock"${drawing ? '' : ' disabled'} aria-label="Take a card from the draw pile"></button>`
      : '<span class="pc slot"></span>';
    const discard = view.top
      ? `<button type="button" class="pc${drawing ? ' can-play' : ''}" data-draw="discard"${drawing ? '' : ' disabled'} aria-label="Take the ${view.top.rank} of ${SUIT_NAMES[view.top.suit]} from the discard pile">${cardSvg(view.top)}</button>`
      : '<span class="pc slot"></span>';

    const melds = view.melds
      .map((meld, index) => {
        const fits = acting && one && meldKind([...meld.cards, one]) !== null;
        const body = `<span class="stack">${meld.cards.map(small).join('')}</span>`;
        return fits ? `<button type="button" class="meld can-add" data-meld="${index}" aria-label="Add your card to this ${meld.kind}">${body}</button>` : `<span class="meld">${body}</span>`;
      })
      .join('');

    let hand = [];
    if (me) {
      const order = me.hand.map((_card, index) => index);
      if (byRank) order.sort((a, b) => lowValue(me.hand[a]) - lowValue(me.hand[b]) || a - b);
      hand = order.map((index) => {
        const card = me.hand[index];
        const classes = `pc${acting ? ' can-pick' : ''}${picks.includes(index) ? ' is-picked' : ''}${fresh === card.rank + card.suit ? ' is-new' : ''}`;
        return acting
          ? `<button type="button" class="${classes}" data-card="${index}" aria-label="${card.rank} of ${SUIT_NAMES[card.suit]}" aria-pressed="${picks.includes(index)}">${cardSvg(card)}</button>`
          : `<span class="${classes}">${cardSvg(card)}</span>`;
      });
    }

    let prompt;
    if (me?.out) prompt = { text: 'You left this game, so you’re watching.' };
    else if (!myTurn) prompt = { text: `${shell.turnText(view.turn)}${me ? '' : ' You’re watching.'}` };
    else if (drawing) prompt = { text: `Take a card. ${shell.countdown}`, mine: true };
    else {
      const canMeld = meldKind(chosen) !== null;
      const canDiscard = one && !(view.taken && sameCard(one, view.taken));
      prompt = {
        text: `Meld or discard. ${shell.countdown}`,
        mine: true,
        buttons: `<button type="button" class="btn${canMeld ? ' btn-primary' : ''}" data-meld-now${canMeld ? '' : ' disabled'}>Meld</button>
          <button type="button" class="btn${canDiscard && !canMeld ? ' btn-primary' : ''}" data-discard${canDiscard ? '' : ' disabled'}>Discard</button>`,
      };
    }

    const rows = (view.results?.rows ?? []).map((row) => ({
      name: shell.who(row.seat),
      detail: row.out ? '' : row.cards ? `${row.cards} ${row.cards === 1 ? 'card' : 'cards'} left` : 'Out first',
      total: row.out ? '' : row.points,
      winner: view.results.winners.includes(row.seat),
      out: row.out,
    }));
    const sortButton = me && me.hand.length > 1 && view.phase === 'play' ? `<button type="button" class="btn btn-small rm-sort" data-sort>${byRank ? 'Sort by suit' : 'Sort by rank'}</button>` : '';
    return `<div class="table">
      ${shell.top('')}
      <div class="opponents">${others}</div>
      <div class="shell-middle">
        <div class="pile-wrap" style="--card-w: var(--card-mid)">${stock}<span class="pile-label">${view.stockCount ? `${view.stockCount} to draw` : 'Pile empty'}</span></div>
        <div class="pile-wrap" style="--card-w: var(--card-mid)">${discard}<span class="pile-label">Discard</span></div>
      </div>
      <div class="melds">${melds || '<p class="shell-note">No sets or runs yet</p>'}</div>
      <div class="me">
        ${me ? `<div class="seat seat-me${myTurn ? ' active' : ''}${view.results?.winners.includes(view.you) ? ' winner' : ''}">${shell.fan(hand) || '<p class="shell-note">No cards</p>'}${sortButton}</div>` : ''}
        ${shell.prompt(prompt)}
      </div>
      ${shell.scores(shell.winnersTitle(view.results?.winners ?? []), rows)}
    </div>`;
  });

  shell.setClick((event, view) => {
    if (!view) return;
    const target = event.target;
    if (target.closest('[data-sort]')) {
      byRank = !byRank;
      shell.render();
      return;
    }
    const card = target.closest('[data-card]');
    if (card) {
      const index = Number(card.dataset.card);
      picks = picks.includes(index) ? picks.filter((pick) => pick !== index) : [...picks, index];
      shell.render();
      return;
    }
    const pile = target.closest('[data-draw]');
    if (pile && !pile.disabled) {
      hooks.act({ type: 'draw', from: pile.dataset.draw });
      return;
    }
    const meld = target.closest('[data-meld]');
    if (meld && picks.length === 1) {
      hooks.act({ type: 'layoff', card: picks[0], meld: Number(meld.dataset.meld) });
      return;
    }
    if (target.closest('[data-meld-now]')) hooks.act({ type: 'meld', cards: picks });
    else if (target.closest('[data-discard]') && picks.length === 1) hooks.act({ type: 'discard', card: picks[0] });
  });

  return shell.api({
    onNew() {
      picks = [];
      fresh = null;
    },
    onView(view, events) {
      const hand = view.players[view.you]?.hand ?? [];
      const key = keyOf(hand);
      // The positions mean nothing once the hand has changed.
      if (key !== handKey || !view.legal.includes('discard')) picks = [];
      handKey = key;
      const drew = events.find((event) => event.type === 'drew' && event.seat === view.you && event.card);
      if (drew) fresh = drew.card.rank + drew.card.suit;
      else if (events.some((event) => event.type === 'turn')) fresh = null;
    },
  });
}
