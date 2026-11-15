// The Blackjack table. It draws whatever view the server sends and turns
// clicks into moves. It decides nothing about the game.
//
// hooks: { act(action), away(seat), isHost(), deal(), lobby(), cardSvg(card), escapeHtml(text) }

const BETS = [10, 20, 50, 100, 200, 500];
const OUTCOMES = { blackjack: 'Blackjack', win: 'Win', push: 'Push', lose: 'Lose', bust: 'Bust' };
const MOVES = [
  ['hit', 'Hit'],
  ['stand', 'Stand'],
  ['double', 'Double'],
  ['split', 'Split'],
];

const RULES_HTML = `
<h3>The aim</h3>
<p>Everyone plays against the house. Get closer to 21 than the house without going over. Whoever has the most chips after the last hand wins the game.</p>
<h3>Card values</h3>
<p>Number cards count their number. Jacks, queens and kings count 10. An ace counts 11, or 1 if 11 would take you over 21.</p>
<h3>Each hand</h3>
<ul>
<li>Everyone starts the game with 1,000 chips and bets 10 to 500 before the cards are dealt.</li>
<li>You get two cards face up. The house gets one face up and one face down.</li>
<li><strong>Hit</strong> takes another card. <strong>Stand</strong> ends your turn. Going over 21 loses your bet at once.</li>
<li><strong>Double</strong> doubles your bet for exactly one more card. Only on your first two cards.</li>
<li><strong>Split</strong> turns a pair into two hands, each with its own bet. Once per hand. Split aces get one card each.</li>
<li>Then the house turns its card over and draws until it has 17 or more.</li>
</ul>
<h3>Payouts</h3>
<ul>
<li>Beat the house, or the house goes over 21: you win your bet.</li>
<li>Blackjack (an ace and a 10-value card as your first two): you win one and a half times your bet. 21 after a split doesn’t count.</li>
<li>Same total as the house: you get your bet back.</li>
<li>If the house has blackjack, the hand ends before anyone plays.</li>
</ul>
<h3>Running out and leaving</h3>
<p>With fewer than 10 chips you sit out the rest of the game. If you leave, you lose any bet on the table and can’t win.</p>`;

export function createBlackjackTable(hooks) {
  const { cardSvg, escapeHtml } = hooks;
  const root = document.createElement('section');
  root.id = 'blackjack';
  root.className = 'bj';
  root.hidden = true;
  document.querySelector('.app').append(root);

  const dialog = document.createElement('dialog');
  dialog.className = 'settings';
  dialog.setAttribute('aria-labelledby', 'bjRulesTitle');
  dialog.innerHTML = `<div class="settings-panel">
    <header class="settings-head"><h2 id="bjRulesTitle">Blackjack rules</h2>
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
  let deadline = null; // { kind, at }
  let seen = {}; // how many cards each hand showed last time, to animate only new ones
  let hint = '';
  let hintTimer = 0;
  let showScores = false;
  let endArmed = false;
  let endTimer = 0;
  let ticker = 0;

  const money = (amount) => amount.toLocaleString('en-GB');
  const who = (seat) => (seat === view.you ? 'You' : escapeHtml(view.players[seat].name));

  function cardsHtml(cards, key) {
    const before = seen[key] ?? 0;
    return cards
      .map((card, index) => {
        const fresh = index >= before ? ' is-new' : '';
        return card ? `<span class="bj-card${fresh}">${cardSvg(card)}</span>` : `<span class="bj-card back-face${fresh}"></span>`;
      })
      .join('');
  }

  function handHtml(hand, key, active) {
    const outcome = hand.outcome && (view.phase === 'payout' || view.phase === 'finished' || hand.outcome === 'bust');
    const amount = hand.paid > 0 ? ` +${money(hand.paid)}` : hand.paid < 0 && view.phase !== 'play' && view.phase !== 'dealer' ? ` −${money(-hand.paid)}` : '';
    const tag = outcome
      ? `${hand.outcome === 'bust' ? '' : `<span class="bj-total">${hand.total}</span>`}<span class="bj-outcome is-${hand.outcome}">${OUTCOMES[hand.outcome]}${amount}</span>`
      : `<span class="bj-total">${hand.total}</span>`;
    return `<div class="bj-hand${active ? ' is-active' : ''}"><div class="bj-cards">${cardsHtml(hand.cards, key)}</div>
      <div class="bj-tags">${tag}<span class="bj-bet">Bet ${money(hand.bet)}</span></div></div>`;
  }

  function seatHtml(player, seat) {
    const mine = seat === view.you;
    const turn = view.phase === 'play' && view.turn === seat;
    const chip = player.out ? 'Left' : hooks.away(seat) ? 'Away' : '';
    const winner = view.results?.winners.includes(seat) ? ' winner' : '';
    let body;
    if (player.hands.length) body = player.hands.map((hand, index) => handHtml(hand, `${view.round}:${seat}:${index}:${player.hands.length}`, turn && player.hand === index && player.hands.length > 1)).join('');
    else if (player.out) body = '';
    else if (!player.inRound && view.phase !== 'finished') body = '<p class="bj-note">Out of chips</p>';
    else if (view.phase === 'bet') body = player.bet ? `<p class="bj-note">Bet ${money(player.bet)}</p>` : mine ? '' : '<p class="bj-note">Betting</p>';
    else body = '';
    return `<div class="seat bj-seat${mine ? ' seat-me bj-me' : ''}${turn ? ' active' : ''}${winner}${player.out ? ' is-out' : ''}">
      <div class="seat-head"><span class="seat-name">${mine ? 'You' : escapeHtml(player.name)}</span>${chip ? `<span class="seat-chip">${chip}</span>` : ''}<span class="bj-chips" aria-label="${money(player.chips)} chips">${money(player.chips)}</span></div>
      <div class="bj-hands">${body}</div></div>`;
  }

  function prompt() {
    const me = view.players[view.you];
    const count = '<span class="bj-count" data-count></span>';
    if (view.phase === 'finished') return { text: 'Game over.' };
    if (me?.out) return { text: 'You left this game, so you’re watching.' };
    const watching = me ? '' : ' You’re watching.';
    if (view.phase === 'bet') {
      if (view.legal.includes('bet')) {
        const buttons = BETS.filter((amount) => amount <= view.maxBet)
          .map((amount) => `<button type="button" class="btn bj-bet-btn" data-bet="${amount}"${amount > me.chips ? ' disabled' : ''}>${amount}</button>`)
          .join('');
        return { text: `Place your bet. ${count}`, buttons, mine: true };
      }
      if (me && !me.inRound) return { text: 'You’re out of chips.' };
      return { text: `Waiting for bets.${watching}` };
    }
    if (view.phase === 'play') {
      if (view.turn === view.you) {
        const buttons = MOVES.filter(([type]) => view.legal.includes(type))
          .map(([type, label]) => `<button type="button" class="btn${type === 'hit' || type === 'stand' ? ' btn-primary' : ''}" data-move="${type}">${label}</button>`)
          .join('');
        return { text: `Your turn. ${count}`, buttons, mine: true };
      }
      return { text: `${who(view.turn)}’s turn.${watching}` };
    }
    if (view.phase === 'dealer') return { text: `The house plays.${watching}` };
    // Payout.
    if (!me || !me.hands.length) return { text: `Next hand soon.${watching}` };
    const net = me.hands.reduce((sum, hand) => sum + hand.paid, 0);
    return { text: net > 0 ? `You won ${money(net)}.` : net < 0 ? `You lost ${money(-net)}.` : 'You broke even.' };
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
    const house = view.house;
    root.innerHTML = `<div class="table bj-table">
      <div class="bj-top">
        <span class="bj-round">Hand ${view.round} of ${view.rounds}</span>
        <button type="button" class="btn btn-small" data-do="rules">Rules</button>
        ${hooks.isHost() ? `<button type="button" class="btn btn-small" data-do="end">${endArmed ? 'Press again to end' : 'End game'}</button>` : ''}
      </div>
      <div class="bj-house${view.phase === 'dealer' ? ' active' : ''}">
        <div class="seat-head"><span class="seat-name">House</span></div>
        <div class="bj-cards">${house.cards.length ? cardsHtml(house.cards, `${view.round}:house`) : '<span class="bj-card bj-slot"></span><span class="bj-card bj-slot"></span>'}</div>
        <div class="bj-tags">${house.total !== null ? `<span class="${house.total > 21 ? 'bj-outcome is-bust' : 'bj-total'}">${house.total > 21 ? `Bust ${house.total}` : house.total}</span>` : '<span class="bj-total is-blank"></span>'}</div>
      </div>
      ${others ? `<div class="opponents bj-others">${others}</div>` : ''}
      <div class="me">
        ${me ? seatHtml(me, view.you) : ''}
        <div class="prompt${mine ? ' is-mine' : ''}"><p>${text}</p>${extra ? `<div class="prompt-buttons">${extra}</div>` : ''}</div>
        <p class="hint" role="alert">${escapeHtml(hint)}</p>
      </div>
      ${finished && showScores ? resultsHtml() : ''}
    </div>`;
    // Remember what is on the table, so only cards dealt after this slide in.
    seen = { [`${view.round}:house`]: house.cards.length };
    view.players.forEach((player, seat) => {
      player.hands.forEach((hand, index) => {
        seen[`${view.round}:${seat}:${index}:${player.hands.length}`] = hand.cards.length;
      });
    });
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
    const bet = event.target.closest('[data-bet]');
    if (bet) {
      hooks.act({ type: 'bet', amount: Number(bet.dataset.bet) });
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
        // Arriving mid-hand, the cards are already down: don't animate them.
        seen = { [`${next.round}:house`]: next.house.cards.length };
        next.players.forEach((player, seat) => {
          player.hands.forEach((hand, index) => {
            seen[`${next.round}:${seat}:${index}:${player.hands.length}`] = hand.cards.length;
          });
        });
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
