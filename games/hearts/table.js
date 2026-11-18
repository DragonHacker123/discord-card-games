// The Hearts table. It draws the server's view and turns clicks into moves.
import { sameCard } from '../shared/cards.js';
import { createShell } from '../shared/shell.js';
import { handHtml, opponentsHtml, seatsAround, trickHtml } from '../shared/trick-table.js';

const RULES_HTML = `
<h3>The aim</h3>
<p>Finish with the lowest score. Every heart you take costs 1 point and the queen of spades costs 13.</p>
<h3>Passing</h3>
<p>Each round starts with everyone passing three cards: to the left, then to the right, then across, then no pass at all, and round again.</p>
<h3>Playing</h3>
<ul>
<li>Whoever holds the 2 of clubs leads it. After that, the winner of each trick leads the next.</li>
<li>You have to follow the suit that was led if you can. If you can’t, play anything.</li>
<li>The highest card of the suit led takes the trick. Aces are high. There are no trumps.</li>
<li>You can’t lead a heart until a heart has been played, unless hearts are all you have.</li>
<li>No hearts or queen of spades on the first trick, unless you have nothing else.</li>
</ul>
<h3>Shooting the moon</h3>
<p>If you take all 13 hearts and the queen of spades in one round, you score nothing and everyone else gets 26.</p>
<h3>Winning</h3>
<p>The game ends at the end of the round in which someone reaches the target (50 or 100). The lowest score wins.</p>
<h3>Players</h3>
<p>Exactly four. The host can add computer players to fill the table. If you leave, the computer plays your cards and you can’t win.</p>`;

const PASS_WORD = { left: 'left', right: 'right', across: 'across' };

export function createHeartsTable(hooks) {
  const { cardSvg, escapeHtml } = hooks;
  const shell = createShell(hooks, { id: 'hearts', rulesTitle: 'Hearts rules', rulesHtml: RULES_HTML });
  let picks = []; // positions in your hand chosen to pass
  let lastPlayed = null;

  const pills = (view, seat) => {
    const player = view.players[seat];
    const round = view.phase === 'roundEnd' || view.phase === 'finished' ? view.summary?.find((row) => row.seat === seat)?.points : player.roundPoints;
    return `<span class="pill">${player.score}</span>${round ? `<span class="pill is-quiet">+${round}</span>` : ''}`;
  };

  shell.setDraw((view) => {
    const where = seatsAround(view);
    const me = view.players[view.you];
    const passing = view.legal.includes('pass');
    const playing = view.legal.includes('play');
    const hand = me
      ? handHtml(me.hand, cardSvg, {
          can: (index) => passing || (playing && view.playable.includes(index)),
          picked: (index) => (passing ? picks.includes(index) : Boolean(view.passing?.some((card) => sameCard(card, me.hand[index])))),
          fresh: (card) => view.received.some((got) => sameCard(got, card)),
          dim: playing,
          ring: !passing,
          label: passing ? 'Pick' : 'Play',
        })
      : [];

    let prompt;
    if (me?.out) prompt = { text: 'You left this game, so you’re watching.' };
    else if (view.phase === 'pass') {
      if (passing) {
        prompt = {
          text: `Pass 3 cards ${PASS_WORD[view.passDir]}, to ${shell.who(view.passTo, false)}. ${shell.countdown}`,
          mine: true,
          buttons: `<button type="button" class="btn btn-primary" data-pass${picks.length === 3 ? '' : ' disabled'}>Pass</button>`,
        };
      } else prompt = { text: me ? 'Waiting for the others to pass.' : 'Everyone is passing three cards.' };
    } else if (view.phase === 'roundEnd') {
      prompt = { text: view.moon !== null ? `${shell.who(view.moon)} shot the moon.` : 'Round over.' };
    } else if (view.phase === 'trickEnd') prompt = { text: `${shell.who(view.trickWinner)} ${view.trickWinner === view.you ? 'take' : 'takes'} the trick.` };
    else if (playing) prompt = { text: `Your turn. ${shell.countdown}`, mine: true };
    else prompt = { text: shell.turnText(view.turn) };

    const rows = (view.results?.rows ?? []).map((row) => ({ name: shell.who(row.seat), total: row.out ? '' : row.score, winner: view.results.winners.includes(row.seat), out: row.out }));
    const bottom = where.bottom;
    const mine = me
      ? `<div class="seat seat-me${view.turn === view.you ? ' active' : ''}${view.results?.winners.includes(view.you) ? ' winner' : ''}">
          <div class="pills">${pills(view, view.you)}</div>${shell.fan(hand)}</div>`
      : `<div class="seat trick-seat${view.turn === bottom ? ' active' : ''}"><div class="seat-head"><span class="seat-name">${escapeHtml(view.players[bottom].name)}</span></div><div class="pills">${pills(view, bottom)}</div></div>`;
    return `<div class="table">
      ${shell.top(`Round ${view.round} · to ${view.rules.target}`)}
      <div class="opponents trick-seats">${opponentsHtml(view, shell, escapeHtml, (seat) => pills(view, seat))}</div>
      <div class="shell-middle">${trickHtml(view, cardSvg, lastPlayed)}</div>
      <div class="me">${mine}${shell.prompt(prompt)}</div>
      ${shell.scores(shell.winnersTitle(view.results?.winners ?? []), rows)}
    </div>`;
  });

  shell.setClick((event, view) => {
    if (!view) return;
    const card = event.target.closest('[data-card]');
    if (card) {
      const index = Number(card.dataset.card);
      if (view.legal.includes('pass')) {
        if (picks.includes(index)) picks = picks.filter((pick) => pick !== index);
        else if (picks.length < 3) picks.push(index);
        shell.render();
      } else hooks.act({ type: 'play', card: index });
      return;
    }
    if (event.target.closest('[data-pass]') && picks.length === 3) hooks.act({ type: 'pass', cards: picks });
  });

  return shell.api({
    onNew() {
      picks = [];
    },
    onView(view, events) {
      if (!view.legal.includes('pass')) picks = [];
      const played = events.findLast((event) => event.type === 'played');
      lastPlayed = played ? played.seat : null;
    },
  });
}
