// The Solitaire table. It draws the server's view of your own board and turns
// taps into moves.
import { RANKS, SUITS, SUIT_NAMES } from '../shared/cards.js';
import { SUIT_SYMBOL, createShell } from '../shared/shell.js';

const RULES_HTML = `
<h3>The aim</h3>
<p>Everyone gets the same deal and plays their own board at the same time. Whoever has moved the most cards up to the four piles at the top right when the time runs out wins. Finishing the whole deck ends the game at once.</p>
<h3>The board</h3>
<ul>
<li>The four piles at the top right are built up in one suit each, from ace to king.</li>
<li>In the seven columns, cards go down in order, red on black and black on red. Only a king can go on an empty column.</li>
<li>When a face-down card is uncovered it is turned over.</li>
</ul>
<h3>Moving cards</h3>
<ul>
<li>Tap a card and it moves to wherever it can go: up to its pile if it fits, otherwise onto a column.</li>
<li>Tap a card in the middle of a column to move it along with every card on top of it.</li>
<li>Tap the draw pile at the top left to turn the next card. When the pile is empty, tap it again to go through it once more, as often as you like.</li>
</ul>
<h3>Stuck?</h3>
<p>Press <b>I’m stuck</b> to stop with what you have. The game ends early if everyone has stopped.</p>
<h3>Players</h3>
<p>1 to 6. The host picks 5, 10 or 15 minutes. If you leave, you can’t win.</p>`;

export function createSolitaireTable(hooks) {
  const { cardSvg, escapeHtml } = hooks;
  const shell = createShell(hooks, { id: 'solitaire', rulesTitle: 'Solitaire rules', rulesHtml: RULES_HTML });
  let stuckArmed = false;
  let stuckTimer = 0;
  const red = (suit) => suit === 'H' || suit === 'D';

  shell.setDraw((view) => {
    const me = view.players[view.you];
    const playing = view.legal.length > 0;
    const { board } = view;

    const race = view.players
      .map((player, seat) => {
        const chip = player.out ? 'Left' : player.done && view.phase === 'play' ? 'Stopped' : hooks.away(seat) ? 'Away' : '';
        return `<div class="seat sol-racer${seat === view.you ? ' is-you' : ''}${view.results?.winners.includes(seat) ? ' winner' : ''}${player.out ? ' is-out' : ''}">
          <div class="seat-head"><span class="seat-name">${seat === view.you ? 'You' : escapeHtml(player.name)}</span>${chip ? `<span class="seat-chip">${chip}</span>` : ''}</div>
          <div class="sol-bar" role="img" aria-label="${player.placed} of 52 cards"><span style="width: ${(player.placed / 52) * 100}%"></span><b>${player.placed}</b></div></div>`;
      })
      .join('');

    let boardHtml = '';
    if (board) {
      const stock = board.stockCount
        ? `<button type="button" class="pc back-face" data-draw${playing ? '' : ' disabled'} aria-label="Turn the next card (${board.stockCount} left)"></button>`
        : `<button type="button" class="pc slot sol-again" data-draw${playing && board.wasteCount ? '' : ' disabled'} aria-label="Go through the pile again">↻</button>`;
      const wasteCard = board.waste.at(-1);
      const waste = wasteCard
        ? `<button type="button" class="pc" data-tap="waste"${playing ? '' : ' disabled'} aria-label="${wasteCard.rank} of ${SUIT_NAMES[wasteCard.suit]}">${cardSvg(wasteCard)}</button>`
        : '<span class="pc slot"></span>';
      const foundations = SUITS.map((suit) => {
        const count = board.foundations[suit];
        return count
          ? `<span class="pc">${cardSvg({ rank: RANKS[count - 1], suit })}</span>`
          : `<span class="pc slot sol-home${red(suit) ? ' suit-red' : ''}" aria-label="${SUIT_NAMES[suit]}: empty">${SUIT_SYMBOL[suit]}</span>`;
      }).join('');
      const columns = board.tableau
        .map((pile, col) => {
          const cards = pile
            .map((card, index) => {
              if (!card.up) return '<span class="pc back-face"></span>';
              return `<button type="button" class="pc" data-tap="${col}:${index}"${playing ? '' : ' disabled'} aria-label="${card.rank} of ${SUIT_NAMES[card.suit]}">${cardSvg(card)}</button>`;
            })
            .join('');
          return `<div class="sol-col">${cards || '<span class="pc slot"></span>'}</div>`;
        })
        .join('');
      boardHtml = `<div class="sol-board">
        <div class="sol-row">${stock}${waste}<span></span>${foundations}</div>
        <div class="sol-row sol-cols">${columns}</div>
      </div>`;
    }

    let prompt;
    if (me?.out) prompt = { text: 'You left this game, so you’re watching.' };
    else if (!me) prompt = { text: 'You’re watching.' };
    else if (playing) prompt = { text: '', buttons: `<button type="button" class="btn" data-stuck>${stuckArmed ? 'Press again to stop' : 'I’m stuck'}</button>` };
    else prompt = { text: 'Waiting for the others.' };

    const rows = (view.results?.rows ?? []).map((row) => ({
      name: shell.who(row.seat),
      detail: row.out ? '' : `${row.moves} ${row.moves === 1 ? 'move' : 'moves'}`,
      total: row.out ? '' : row.placed,
      winner: view.results.winners.includes(row.seat),
      out: row.out,
    }));
    return `<div class="table sol-table">
      ${shell.top(view.phase === 'play' ? '<span class="sol-clock" data-clock></span>' : '')}
      <div class="opponents sol-race">${race}</div>
      ${boardHtml}
      <div class="me">${shell.prompt(prompt)}</div>
      ${shell.scores(shell.winnersTitle(view.results?.winners ?? []), rows)}
    </div>`;
  });

  shell.setClick((event, view) => {
    if (!view) return;
    const target = event.target;
    const tap = target.closest('[data-tap]');
    if (tap && !tap.disabled) {
      if (tap.dataset.tap === 'waste') hooks.act({ type: 'tap', pile: 'waste' });
      else {
        const [col, index] = tap.dataset.tap.split(':').map(Number);
        hooks.act({ type: 'tap', pile: 'tableau', col, index });
      }
      return;
    }
    const draw = target.closest('[data-draw]');
    if (draw && !draw.disabled) {
      hooks.act({ type: 'draw' });
      return;
    }
    if (target.closest('[data-stuck]')) {
      clearTimeout(stuckTimer);
      if (stuckArmed) {
        stuckArmed = false;
        hooks.act({ type: 'giveUp' });
        return;
      }
      stuckArmed = true;
      stuckTimer = setTimeout(() => {
        stuckArmed = false;
        shell.render();
      }, 3000);
      shell.render();
    }
  });

  return shell.api({
    onNew() {
      stuckArmed = false;
    },
  });
}
