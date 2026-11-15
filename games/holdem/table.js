// The Texas Hold'em table. It draws whatever view the server sends and turns
// clicks into moves. It decides nothing about the game.
//
// hooks: { act(action), away(seat), isHost(), deal(), lobby(), cardSvg(card), escapeHtml(text) }

const WITH = { Pair: 'a pair', Straight: 'a straight', Flush: 'a flush', 'Full house': 'a full house', 'Straight flush': 'a straight flush', 'Royal flush': 'a royal flush' };

const RULES_HTML = `
<h3>The aim</h3>
<p>Win chips from the other players. Whoever has the most chips after the last hand wins the game, or the last player with any chips.</p>
<h3>Each hand</h3>
<ul>
<li>Everyone starts the game with 1,000 chips. Two players post the blinds (10 and 20) before the cards are dealt, and the dealer button moves round each hand.</li>
<li>You get two cards only you can see. Five shared cards are dealt to the middle: three (the flop), then one (the turn), then one (the river). There is a round of betting before the flop and after each of those.</li>
<li>Your hand is the best five cards from your two and the five in the middle.</li>
</ul>
<h3>Betting</h3>
<ul>
<li><strong>Check</strong> passes when nobody has bet. <strong>Call</strong> matches the current bet. <strong>Bet</strong> or <strong>Raise</strong> puts in more. <strong>Fold</strong> gives up the hand.</li>
<li>A raise must be at least as big as the last bet or raise. You can always go all in.</li>
<li>If you’re all in for less than the others, you can only win the part of the pot you matched. The rest is a side pot for the others.</li>
<li>When everyone left is all in, the hands are turned over and the rest of the cards are dealt.</li>
</ul>
<h3>Hands, best first</h3>
<ol>
<li>Royal flush: 10 to ace in one suit</li>
<li>Straight flush: five in a row in one suit</li>
<li>Four of a kind</li>
<li>Full house: three of a kind and a pair</li>
<li>Flush: five of one suit</li>
<li>Straight: five in a row (an ace can be high or low)</li>
<li>Three of a kind</li>
<li>Two pair</li>
<li>Pair</li>
<li>High card</li>
</ol>
<p>Equal hands split the pot.</p>
<h3>Running out and leaving</h3>
<p>With no chips you’re out for the rest of the game. If you leave, your hand is folded, what you bet stays in the pot and you can’t win.</p>`;

export function createHoldemTable(hooks) {
  const { cardSvg, escapeHtml } = hooks;
  const root = document.createElement('section');
  root.id = 'holdem';
  root.className = 'hd';
  root.hidden = true;
  document.querySelector('.app').append(root);

  const dialog = document.createElement('dialog');
  dialog.className = 'settings';
  dialog.setAttribute('aria-labelledby', 'hdRulesTitle');
  dialog.innerHTML = `<div class="settings-panel">
    <header class="settings-head"><h2 id="hdRulesTitle">Texas Hold’em rules</h2>
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
  let deadline = null;
  let seen = {}; // cards already on the table, so only new ones slide in
  let hint = '';
  let hintTimer = 0;
  let showScores = false;
  let endArmed = false;
  let endTimer = 0;
  let ticker = 0;

  const money = (amount) => amount.toLocaleString('en-GB');
  const who = (seat) => (seat === view.you ? 'You' : escapeHtml(view.players[seat].name));
  const over = () => view.phase === 'showdown' || view.phase === 'finished';

  function cardsHtml(cards, key) {
    const before = seen[key] ?? 0;
    return cards
      .map((card, index) => {
        const fresh = index >= before ? ' is-new' : '';
        return card ? `<span class="hd-card${fresh}">${cardSvg(card)}</span>` : `<span class="hd-card back-face${fresh}"></span>`;
      })
      .join('');
  }

  /** What each seat won in the hand just finished. */
  function winnings() {
    const won = {};
    for (const pot of view.last?.pots ?? []) {
      const share = Math.floor(pot.amount / pot.winners.length);
      for (const seat of pot.winners) won[seat] = (won[seat] ?? 0) + share;
    }
    return won;
  }

  function seatHtml(player, seat) {
    const mine = seat === view.you;
    const turn = view.phase === 'play' && view.turn === seat;
    const chip = player.out ? 'Left' : hooks.away(seat) ? 'Away' : '';
    const gameWinner = view.results?.winners.includes(seat) ? ' winner' : '';
    const won = over() ? winnings()[seat] : 0;
    const tags = [];
    if (over() && view.last?.hands[seat]) tags.push(`<span class="hd-tag">${view.last.hands[seat]}</span>`);
    else if (mine && view.best && !over()) tags.push(`<span class="hd-tag">${view.best}</span>`);
    if (won) tags.push(`<span class="hd-tag is-win">+${money(won)}</span>`);
    if (!over() && player.said) tags.push(`<span class="hd-tag${player.said === 'Fold' || player.said === 'Left' ? ' is-fold' : ''}">${player.said}</span>`);
    if (!over() && player.bet) tags.push(`<span class="hd-bet">${money(player.bet)}</span>`);
    const cards = player.cards.length
      ? cardsHtml(player.cards, `${view.hand}:${seat}`)
      : '<span class="hd-card hd-slot"></span><span class="hd-card hd-slot"></span>';
    const dim = player.out || !player.inHand || player.folded;
    return `<div class="seat hd-seat${mine ? ' seat-me hd-me' : ''}${turn ? ' active' : ''}${gameWinner}${won ? ' hd-won' : ''}${dim ? ' is-dim' : ''}">
      <div class="seat-head"><span class="seat-name">${mine ? 'You' : escapeHtml(player.name)}</span>${view.button === seat ? '<span class="hd-button" title="Dealer">D</span>' : ''}${chip ? `<span class="seat-chip">${chip}</span>` : ''}<span class="hd-chips" aria-label="${money(player.chips)} chips">${money(player.chips)}</span></div>
      <div class="hd-cards">${cards}</div>
      <div class="hd-tags">${tags.join('')}</div></div>`;
  }

  function raiseButtons() {
    const { currentBet, pot, toCall, minRaiseTo, maxRaiseTo } = view;
    const round = (amount) => Math.round(amount / 10) * 10;
    const wanted = [minRaiseTo, currentBet + round((pot + toCall) / 2), currentBet + round(pot + toCall)];
    const amounts = [...new Set(wanted.filter((amount) => amount >= minRaiseTo && amount < maxRaiseTo))].sort((a, b) => a - b);
    const word = currentBet === 0 ? 'Bet' : 'Raise to';
    return [
      ...amounts.map((amount) => `<button type="button" class="btn" data-raise="${amount}">${word} ${money(amount)}</button>`),
      `<button type="button" class="btn" data-raise="${maxRaiseTo}">All in ${money(maxRaiseTo)}</button>`,
    ].join('');
  }

  function prompt() {
    const me = view.players[view.you];
    const watching = me ? '' : ' You’re watching.';
    if (view.phase === 'finished') return { text: 'Game over.' };
    if (me?.out) return { text: 'You left this game, so you’re watching.' };
    if (view.phase === 'showdown') {
      const won = winnings();
      const lines = Object.keys(won).map((key) => {
        const seat = Number(key);
        const hand = view.last.hands[seat];
        return `${who(seat)} ${seat === view.you ? 'win' : 'wins'} ${money(won[seat])}${hand ? ` with ${WITH[hand] ?? hand.toLowerCase()}` : ''}.`;
      });
      return { text: lines.join(' ') };
    }
    if (view.phase === 'runout') return { text: `All in.${watching}` };
    if (view.turn === view.you) {
      let buttons = '';
      if (view.toCall > 0) buttons += '<button type="button" class="btn" data-move="fold">Fold</button>';
      buttons += view.legal.includes('check')
        ? '<button type="button" class="btn btn-primary" data-move="check">Check</button>'
        : `<button type="button" class="btn btn-primary" data-move="call">${view.toCall >= me.chips ? 'All in' : 'Call'} ${money(view.toCall)}</button>`;
      if (view.legal.includes('raise')) buttons += raiseButtons();
      return { text: 'Your turn. <span class="hd-count" data-count></span>', buttons, mine: true };
    }
    if (me && !me.inHand) return { text: `${who(view.turn)}’s turn. You’re out of chips.` };
    return { text: `${who(view.turn)}’s turn.${watching}` };
  }

  function resultsHtml() {
    const { results } = view;
    const names = results.winners.map((seat) => who(seat));
    const title = names.length === 0 ? 'Nobody wins' : names.length > 1 ? `${names.join(' and ')} tie` : names[0] === 'You' ? 'You win' : `${names[0]} wins`;
    const rows = results.rows
      .map((row) => {
        const winner = results.winners.includes(row.seat);
        return `<li class="result-row${winner ? ' is-winner' : ''}"><span class="result-name">${who(row.seat)}${row.out ? '<span class="result-tag">Left the game</span>' : ''}</span>
          <span></span><span class="result-total">${row.out ? '' : money(row.chips)}</span></li>`;
      })
      .join('');
    const host = hooks.isHost();
    return `<div class="results" role="dialog" aria-label="Scores"><h2>${title}</h2><ul class="results-list">${rows}</ul><div class="results-actions">
      ${host ? '<button type="button" class="btn btn-primary" data-do="deal">Deal again</button>' : ''}
      <button type="button" class="btn" data-do="table">See the table</button>
      ${host ? '<button type="button" class="btn" data-do="lobby">Return to menu</button>' : ''}</div></div>`;
  }

  function remember(target) {
    seen = { [`${target.hand}:board`]: target.board.length };
    target.players.forEach((player, seat) => {
      seen[`${target.hand}:${seat}`] = player.cards.length;
    });
  }

  function tick() {
    const el = root.querySelector('[data-count]');
    if (!el) return;
    const left = deadline ? Math.ceil((deadline.at - Date.now()) / 1000) : null;
    el.textContent = left !== null && left >= 0 && left <= 15 ? String(left) : '';
  }

  function render() {
    if (!view) return;
    const finished = view.phase === 'finished';
    const { text, buttons, mine } = prompt();
    const extra = finished
      ? `${hooks.isHost() ? '<button type="button" class="btn btn-primary" data-do="deal">Deal again</button>' : ''}<button type="button" class="btn" data-do="scores">Scores</button>`
      : (buttons ?? '');
    const others = view.players.map((player, seat) => (seat === view.you ? '' : seatHtml(player, seat))).join('');
    const me = view.players[view.you];
    const pot = over() ? (view.last?.pots.reduce((sum, entry) => sum + entry.amount, 0) ?? 0) : view.pot;
    const board = cardsHtml(view.board, `${view.hand}:board`) + '<span class="hd-card hd-slot"></span>'.repeat(5 - view.board.length);
    root.innerHTML = `<div class="table hd-table">
      <div class="hd-top">
        <span class="hd-round">Hand ${view.hand} of ${view.hands} · Blinds ${view.smallBlind}/${view.bigBlind}</span>
        <button type="button" class="btn btn-small" data-do="rules">Rules</button>
        ${hooks.isHost() ? `<button type="button" class="btn btn-small" data-do="end">${endArmed ? 'Press again to end' : 'End game'}</button>` : ''}
      </div>
      <div class="opponents hd-others">${others}</div>
      <div class="hd-middle">
        <div class="hd-board">${board}</div>
        <p class="hd-pot">Pot <strong>${money(pot)}</strong></p>
      </div>
      <div class="me">
        ${me ? seatHtml(me, view.you) : ''}
        <div class="prompt${mine ? ' is-mine' : ''}"><p>${text}</p>${extra ? `<div class="prompt-buttons">${extra}</div>` : ''}</div>
        <p class="hint" role="alert">${escapeHtml(hint)}</p>
      </div>
      ${finished && showScores ? resultsHtml() : ''}
    </div>`;
    remember(view);
    tick();
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
    const raise = event.target.closest('[data-raise]');
    if (raise) {
      hooks.act({ type: 'raise', to: Number(raise.dataset.raise) });
      return;
    }
    const move = event.target.closest('[data-move]');
    if (move) {
      hooks.act({ type: move.dataset.move });
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
    update({ id, view: next, events, deadline: left }) {
      const newGame = id !== gameId || !view || next.you !== view.you;
      if (newGame) {
        gameId = id;
        remember(next); // arriving mid-hand, the cards are already down
        showScores = next.phase === 'finished';
        hint = '';
      }
      if (events.some((event) => event.type === 'finished')) showScores = true;
      view = next;
      deadline = left ? { kind: left.kind, at: Date.now() + left.ms } : null;
      root.hidden = false;
      render();
      if (!ticker) ticker = setInterval(tick, 250);
    },
    refuse,
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
}
