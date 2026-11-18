// What every newer game's table has in common: its section of the page, a
// rules dialog, the Rules and End game buttons, the line for a refused move,
// the countdown, and the scores at the end. Each game supplies only its own
// drawing and its own clicks.
//
// hooks: { act(action), away(seat), isHost(), deal(), lobby(), cardSvg(card), escapeHtml(text) }

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };

export function createShell(hooks, { id, rulesTitle, rulesHtml }) {
  const { escapeHtml } = hooks;
  const root = document.createElement('section');
  root.id = id;
  root.className = 'shell';
  root.hidden = true;
  document.querySelector('.app').append(root);

  const dialog = document.createElement('dialog');
  dialog.className = 'settings';
  dialog.setAttribute('aria-labelledby', `${id}RulesTitle`);
  dialog.innerHTML = `<div class="settings-panel">
    <header class="settings-head"><h2 id="${id}RulesTitle">${rulesTitle}</h2>
      <button type="button" class="btn settings-close" data-close aria-label="Close rules">${CLOSE_ICON}</button>
    </header>
    <div class="settings-body"><div class="rules">${rulesHtml}</div></div>
    <footer class="settings-foot"><button type="button" class="btn btn-primary settings-ok" data-close>OK</button></footer>
  </div>`;
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
  document.body.append(dialog);

  let draw = () => '';
  let onClick = () => {};
  let view = null;
  let gameId = null;
  let deadline = null;
  let hint = '';
  let hintTimer = 0;
  let showScores = false;
  let endArmed = false;
  let endTimer = 0;
  let ticker = 0;

  function tick() {
    const el = root.querySelector('[data-count]');
    if (!el) return;
    const left = deadline ? Math.ceil((deadline.at - Date.now()) / 1000) : null;
    el.textContent = left !== null && left >= 0 && left <= 15 ? String(left) : '';
  }

  /** A running clock, for games played against the time rather than in turns. */
  function tickClock() {
    const el = root.querySelector('[data-clock]');
    if (!el) return;
    const left = deadline ? Math.max(0, Math.ceil((deadline.at - Date.now()) / 1000)) : null;
    el.textContent = left === null ? '' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  let arriving = false; // true only for the first drawing after news from the server

  function render() {
    if (!view) return;
    root.innerHTML = draw(view);
    // A card slides in once, when it arrives; drawing the table again for a click mustn't replay it.
    if (!arriving) for (const el of root.querySelectorAll('.is-new')) el.classList.remove('is-new');
    arriving = false;
    tick();
    tickClock();
  }

  const shell = {
    root,
    money: (amount) => amount.toLocaleString('en-GB'),
    who: (seat, capital = true) => (seat === view.you ? (capital ? 'You' : 'you') : escapeHtml(view.players[seat]?.name ?? '')),
    /** "Ada’s turn." or "Your turn."; nothing when it is nobody's turn (between rounds, or once the game is over). */
    turnText: (seat) => (!view.players[seat] ? '' : seat === view.you ? 'Your turn.' : `${escapeHtml(view.players[seat].name)}’s turn.`),
    chipFor: (seat) => (view.players[seat]?.out ? 'Left' : hooks.away(seat) ? 'Away' : ''),
    countdown: '<span class="shell-count" data-count></span>',
    /** Your hand: one row, or two balanced rows when there are a lot of cards. cards is a list of HTML strings. */
    fan(cards, perRow = window.innerWidth < 520 ? 9 : 16) {
      if (!cards.length) return '';
      const rows = Math.ceil(cards.length / perRow);
      const size = Math.ceil(cards.length / rows);
      let html = '';
      for (let row = 0; row < rows; row++) {
        const part = cards.slice(row * size, (row + 1) * size);
        html += `<div class="fan" style="--n: ${part.length}">${part.join('')}</div>`;
      }
      return `<div class="fan-rows">${html}</div>`;
    },
    /** The bar across the top: a label, then Rules and (for the host) End game. */
    top(label) {
      return `<div class="shell-top"><span class="shell-round">${label}</span>
        <button type="button" class="btn btn-small" data-do="rules">Rules</button>
        ${hooks.isHost() ? `<button type="button" class="btn btn-small" data-do="end">${endArmed ? 'Press again to end' : 'End game'}</button>` : ''}</div>`;
    },
    /** The line under the table: what to do, any buttons, and why the last move was refused. */
    prompt({ text, buttons = '', mine = false }) {
      const finished = view.phase === 'finished';
      const extra = finished
        ? `${hooks.isHost() ? '<button type="button" class="btn btn-primary" data-do="deal">Deal again</button>' : ''}<button type="button" class="btn" data-do="scores">Scores</button>`
        : buttons;
      return `<div class="prompt${mine ? ' is-mine' : ''}"><p>${finished ? 'Game over.' : text}</p>${extra ? `<div class="prompt-buttons">${extra}</div>` : ''}</div>
        <p class="hint" role="alert">${escapeHtml(hint)}</p>`;
    },
    /**
     * The scores, shown once the game is over. rows: [{ name, detail, total, winner, out }]
     * where name and detail are already safe HTML.
     */
    scores(title, rows) {
      if (view.phase !== 'finished' || !showScores) return '';
      const host = hooks.isHost();
      const list = rows
        .map((row) => `<li class="result-row${row.winner ? ' is-winner' : ''}"><span class="result-name">${row.name}${row.out ? '<span class="result-tag">Left the game</span>' : ''}</span>
          <span class="shell-detail">${row.detail ?? ''}</span><span class="result-total">${row.total ?? ''}</span></li>`)
        .join('');
      return `<div class="results" role="dialog" aria-label="Scores"><h2>${title}</h2><ul class="results-list">${list}</ul><div class="results-actions">
        ${host ? '<button type="button" class="btn btn-primary" data-do="deal">Deal again</button>' : ''}
        <button type="button" class="btn" data-do="table">See the table</button>
        ${host ? '<button type="button" class="btn" data-do="lobby">Return to menu</button>' : ''}</div></div>`;
    },
    /** "You win", "Ada wins", "Ada and Bea win" or "Nobody wins", from a list of winning seats. */
    winnersTitle(seats) {
      const names = seats.map((seat) => shell.who(seat));
      if (!names.length) return 'Nobody wins';
      if (names.length > 1) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)} win`;
      return names[0] === 'You' ? 'You win' : `${names[0]} wins`;
    },
    render,
    setDraw(fn) {
      draw = fn;
    },
    setClick(fn) {
      onClick = fn;
    },
    /** The object the page talks to. onNew(view) runs when a different game starts; onView(view, events) on every update. */
    api({ onNew = () => {}, onView = () => {} } = {}) {
      return {
        update({ id: nextId, view: next, events, deadline: left }) {
          const fresh = nextId !== gameId || !view || next.you !== view.you;
          const before = view;
          view = next;
          if (fresh) {
            gameId = nextId;
            showScores = next.phase === 'finished';
            hint = '';
            onNew(next);
          }
          if (events.some((event) => event.type === 'finished')) {
            showScores = true;
            // A refused move no longer matters once the game is over.
            hint = '';
          }
          onView(next, events, fresh ? null : before, left);
          deadline = left ? { at: Date.now() + left.ms } : null;
          root.hidden = false;
          arriving = events.length > 0;
          render();
          if (!ticker) {
            ticker = setInterval(() => {
              tick();
              tickClock();
            }, 250);
          }
        },
        refuse(text) {
          hint = text;
          clearTimeout(hintTimer);
          hintTimer = setTimeout(() => {
            hint = '';
            render();
          }, 3500);
          render();
        },
        redraw: render,
        close() {
          view = null;
          gameId = null;
          deadline = null;
          clearInterval(ticker);
          ticker = 0;
          root.hidden = true;
          root.textContent = '';
          if (dialog.open) dialog.close();
        },
        openRules: () => dialog.showModal(),
      };
    },
  };

  root.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-do]')?.dataset.do;
    if (!choice) {
      onClick(event, view);
      return;
    }
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

  return shell;
}
