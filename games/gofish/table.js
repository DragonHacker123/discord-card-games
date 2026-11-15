// The Go Fish table. It draws whatever view the server sends and turns clicks
// into asks. It decides nothing about the game.
//
// hooks: { act(action), away(seat), isHost(), deal(), lobby(), cardSvg(card), escapeHtml(text) }

import { RANKS } from './engine.js';

const NAMES = { A: 'Aces', J: 'Jacks', Q: 'Queens', K: 'Kings' };
const rankName = (rank) => NAMES[rank] ?? `${rank}s`;

const RULES_HTML = `
<h3>The aim</h3>
<p>Collect the most books. A book is all four cards of one rank, and it’s laid down as soon as you have it.</p>
<h3>Your turn</h3>
<ul>
<li>Pick one of your cards, then pick a player. You’re asking them for every card they hold of that rank.</li>
<li>If they have any, they hand them all over and you ask again.</li>
<li>If they have none, you go fish: you take the top card of the draw pile. If it’s the rank you asked for, everyone sees it and you ask again. If not, your turn ends.</li>
</ul>
<h3>Running out</h3>
<ul>
<li>If you have no cards on your turn, you take one from the draw pile. If the pile is empty too, you’re passed over.</li>
<li>If nobody else has cards to ask for, you take a card and your turn ends.</li>
<li>The game ends when all 13 books are down.</li>
</ul>
<h3>The deal</h3>
<p>2 to 6 players. Two or three players get 7 cards each; four or more get 5 each.</p>
<h3>Leaving</h3>
<p>If you leave, your cards go to the bottom of the draw pile and you can’t win.</p>`;

export function createFishTable(hooks) {
  const { cardSvg, escapeHtml } = hooks;
  const root = document.createElement('section');
  root.id = 'gofish';
  root.className = 'fish';
  root.hidden = true;
  document.querySelector('.app').append(root);

  const dialog = document.createElement('dialog');
  dialog.className = 'settings';
  dialog.setAttribute('aria-labelledby', 'fishRulesTitle');
  dialog.innerHTML = `<div class="settings-panel">
    <header class="settings-head"><h2 id="fishRulesTitle">Go Fish rules</h2>
      <button type="button" class="btn settings-close" data-close aria-label="Close rules"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg></button>
    </header>
    <div class="settings-body"><div class="rules">${RULES_HTML}</div></div>
    <footer class="settings-foot"><button type="button" class="btn btn-primary settings-ok" data-close>OK</button></footer>
  </div>`;
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
  document.body.append(dialog);

  let view = null;
  let gameId = null;
  let selected = null; // the rank picked from my hand
  let fresh = []; // cards that just arrived in my hand, as "rank+suit"
  let freshTimer = 0;
  let hint = '';
  let hintTimer = 0;
  let showScores = false;
  let endArmed = false;
  let endTimer = 0;

  const who = (seat, capital = true) => (seat === view.you ? (capital ? 'You' : 'you') : escapeHtml(view.players[seat].name));

  function lastLine() {
    const { last } = view;
    if (!last) return '';
    const start = `${who(last.seat)} asked ${who(last.target, false)} for ${rankName(last.rank)}`;
    if (last.got) return `${start} and got ${last.got}.`;
    return last.lucky ? `${start}. Go fish. Drew one!` : `${start}. Go fish.`;
  }

  function prompt() {
    const me = view.players[view.you];
    if (view.phase === 'finished') return 'Game over.';
    if (!me) return `${who(view.turn)}’s turn. You’re watching.`;
    if (me.out) return 'You left this game, so you’re watching.';
    if (view.turn !== view.you) return `${who(view.turn)}’s turn.`;
    return selected ? `Ask who for ${rankName(selected)}?` : 'Your turn. Pick a card.';
  }

  const books = (player) =>
    player.books.length ? `<span class="fish-books" aria-label="Books: ${player.books.join(', ')}">${player.books.map((rank) => `<span class="fish-book">${rank}</span>`).join('')}</span>` : '';

  function seatHtml(player, seat) {
    const mine = view.turn === view.you && view.phase === 'play';
    const askable = mine && selected && !player.out && player.count > 0;
    const chip = player.out ? 'Left' : hooks.away(seat) ? 'Away' : '';
    const active = view.phase === 'play' && view.turn === seat ? ' active' : '';
    const winner = view.results?.winners.includes(seat) ? ' winner' : '';
    const inner = `<span class="seat-head"><span class="seat-name">${escapeHtml(player.name)}</span>${chip ? `<span class="seat-chip">${chip}</span>` : ''}</span>
      <span class="fish-opp-body"><span class="fish-back back-face"></span><span class="fish-count">${player.count}</span>${books(player)}</span>`;
    return askable
      ? `<button type="button" class="seat fish-opp can-ask${active}" data-ask="${seat}" aria-label="Ask ${escapeHtml(player.name)} for ${rankName(selected)}">${inner}</button>`
      : `<div class="seat fish-opp${active}${winner}${player.out ? ' is-out' : ''}">${inner}</div>`;
  }

  function handHtml(me) {
    if (!me.hand.length) return '<p class="fish-empty">No cards</p>';
    const canPick = view.turn === view.you && view.phase === 'play';
    const groups = [];
    for (const card of me.hand) {
      if (groups.at(-1)?.[0].rank === card.rank) groups.at(-1).push(card);
      else groups.push([card]);
    }
    return groups
      .map((group) => {
        const rank = group[0].rank;
        const cards = group.map((card) => `<span class="fish-card${fresh.includes(card.rank + card.suit) ? ' is-new' : ''}">${cardSvg(card)}</span>`).join('');
        const classes = `fish-group${selected === rank ? ' is-selected' : ''}`;
        return canPick
          ? `<button type="button" class="${classes} can-pick" data-rank="${rank}" aria-pressed="${selected === rank}" aria-label="${group.length} ${rankName(rank)}">${cards}</button>`
          : `<span class="${classes}">${cards}</span>`;
      })
      .join('');
  }

  function resultsHtml() {
    const { results } = view;
    const names = results.winners.map((seat) => who(seat));
    const title = names.length === 0 ? 'Nobody wins' : names.length > 1 ? `${names.join(' and ')} tie` : names[0] === 'You' ? 'You win' : `${names[0]} wins`;
    const rows = results.rows
      .map((row) => {
        const winner = results.winners.includes(row.seat);
        const cells = row.books.length ? row.books.map((rank) => `<span class="fish-book">${rank}</span>`).join('') : '<span class="result-empty">No books</span>';
        return `<li class="result-row${winner ? ' is-winner' : ''}"><span class="result-name">${who(row.seat)}${row.out ? '<span class="result-tag">Left the game</span>' : ''}</span>
          <span class="fish-books">${cells}</span><span class="result-total">${row.out ? '' : row.books.length}</span></li>`;
      })
      .join('');
    const host = hooks.isHost();
    return `<div class="results" role="dialog" aria-label="Scores"><h2>${title}</h2><ul class="results-list">${rows}</ul><div class="results-actions">
      ${host ? '<button type="button" class="btn btn-primary" data-do="deal">Deal again</button>' : ''}
      <button type="button" class="btn" data-do="table">See the table</button>
      ${host ? '<button type="button" class="btn" data-do="lobby">Return to menu</button>' : ''}</div></div>`;
  }

  function render() {
    if (!view) return;
    const me = view.players[view.you];
    const mine = view.turn === view.you && view.phase === 'play' && me && !me.out;
    const others = view.players.map((player, seat) => (seat === view.you ? '' : seatHtml(player, seat))).join('');
    const finished = view.phase === 'finished';
    const buttons = finished
      ? `${hooks.isHost() ? '<button type="button" class="btn btn-primary" data-do="deal">Deal again</button>' : ''}<button type="button" class="btn" data-do="scores">Scores</button>`
      : '';
    root.innerHTML = `<div class="table fish-table">
      <div class="fish-top">
        <button type="button" class="btn btn-small" data-do="rules">Rules</button>
        ${hooks.isHost() ? `<button type="button" class="btn btn-small" data-do="end">${endArmed ? 'Press again to end' : 'End game'}</button>` : ''}
      </div>
      <div class="opponents">${others}</div>
      <div class="centre">
        <div class="pile-wrap"><div class="fish-pile${view.pileCount ? ' back-face' : ' is-empty'}"></div><span class="pile-label">${view.pileCount ? `${view.pileCount} to fish` : 'Pile empty'}</span></div>
        <p class="status fish-last" aria-live="polite">${lastLine()}</p>
      </div>
      <div class="me">
        ${me ? `<div class="seat seat-me fish-me${mine ? ' active' : ''}${view.results?.winners.includes(view.you) ? ' winner' : ''}"><div class="fish-hand">${handHtml(me)}</div>${books(me)}</div>` : ''}
        <div class="prompt${mine ? ' is-mine' : ''}"><p>${prompt()}</p>${buttons ? `<div class="prompt-buttons">${buttons}</div>` : ''}</div>
        <p class="hint" role="alert">${escapeHtml(hint)}</p>
      </div>
      ${finished && showScores ? resultsHtml() : ''}
    </div>`;
  }

  function refuse(text) {
    hint = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint = '';
      render();
    }, 3500);
    render();
  }

  root.addEventListener('click', (event) => {
    const group = event.target.closest('[data-rank]');
    if (group) {
      selected = selected === group.dataset.rank ? null : group.dataset.rank;
      render();
      return;
    }
    const seat = event.target.closest('[data-ask]');
    if (seat && selected) {
      hooks.act({ type: 'ask', target: Number(seat.dataset.ask), rank: selected });
      return;
    }
    const choice = event.target.closest('[data-do]')?.dataset.do;
    if (choice === 'rules') dialog.showModal();
    else if (choice === 'deal') hooks.deal();
    else if (choice === 'lobby') hooks.lobby();
    else if (choice === 'table' || choice === 'scores') {
      showScores = choice === 'scores';
      render();
    } else if (choice === 'end') {
      if (endArmed) {
        endArmed = false;
        clearTimeout(endTimer);
        hooks.lobby();
        return;
      }
      endArmed = true;
      endTimer = setTimeout(() => {
        endArmed = false;
        render();
      }, 3000);
      render();
    }
  });

  return {
    update({ id, view: next, events }) {
      const newGame = id !== gameId || !view || next.you !== view.you;
      if (newGame) {
        gameId = id;
        selected = null;
        fresh = [];
        showScores = next.phase === 'finished';
        hint = '';
      }
      view = next;
      const me = view.players[view.you];
      // Keep the picked rank only while it can still be asked for.
      if (!me?.hand?.some((card) => card.rank === selected) || view.turn !== view.you) selected = null;
      const arrived = [];
      for (const event of events) {
        if ((event.type === 'goFish' || event.type === 'drew') && event.seat === view.you && event.card) arrived.push(event.card.rank + event.card.suit);
        if (event.type === 'gave' && event.to === view.you) for (const card of me.hand) if (card.rank === event.rank) arrived.push(card.rank + card.suit);
        if (event.type === 'finished') showScores = true;
      }
      if (arrived.length) {
        fresh = arrived;
        clearTimeout(freshTimer);
        freshTimer = setTimeout(() => {
          fresh = [];
          render();
        }, 2500);
      }
      root.hidden = false;
      render();
    },
    refuse,
    redraw: render,
    close() {
      view = null;
      gameId = null;
      root.hidden = true;
      root.textContent = '';
      if (dialog.open) dialog.close();
    },
    openRules: () => dialog.showModal(),
    ranks: RANKS,
  };
}
