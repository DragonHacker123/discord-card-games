// The Spades table. It draws the server's view and turns clicks into moves.
import { createShell } from '../shared/shell.js';
import { handHtml, opponentsHtml, seatsAround, trickHtml } from '../shared/trick-table.js';

const RULES_HTML = `
<h3>The aim</h3>
<p>You and the player opposite are partners. Together, win at least as many tricks as you both bid. The first side to the target wins.</p>
<h3>Bidding</h3>
<ul>
<li>Each player in turn says how many of the 13 tricks they expect to win. Partners’ bids are added together.</li>
<li><b>Nil</b> is a promise to win no tricks at all: 100 points if you manage it, minus 100 if you take even one.</li>
</ul>
<h3>Playing</h3>
<ul>
<li>The player after the dealer leads. After that, the winner of each trick leads the next.</li>
<li>You have to follow the suit that was led if you can. If you can’t, play anything.</li>
<li>Spades are trumps: the highest spade takes the trick. With no spade in it, the highest card of the suit led takes it. Aces are high.</li>
<li>You can’t lead a spade until a spade has been played, unless spades are all you have.</li>
</ul>
<h3>Scores</h3>
<ul>
<li>Make your bid: 10 points for each trick bid, plus 1 for each extra trick (a “bag”).</li>
<li>Fall short: lose 10 points for each trick bid.</li>
<li>Every 10 bags cost 100 points. Tricks won by a player who bid nil are bags and don’t count towards their partner’s bid.</li>
</ul>
<h3>Winning</h3>
<p>The game ends at the end of the round in which a side reaches the target (150, 250 or 500), or falls to minus the target. The higher score wins; a dead heat plays another round.</p>
<h3>Players</h3>
<p>Exactly four. The host can add computer players to fill the table. If you leave, the computer plays your cards for your partner and you can’t win.</p>`;

export function createSpadesTable(hooks) {
  const { cardSvg, escapeHtml } = hooks;
  const shell = createShell(hooks, { id: 'spades', rulesTitle: 'Spades rules', rulesHtml: RULES_HTML });
  let lastPlayed = null;
  const signed = (amount) => (amount > 0 ? `+${amount}` : String(amount).replace('-', '−'));

  /** "Us" and "Them" when you're playing; the players' names when you're watching. */
  const teamName = (view, team) => {
    if (view.you >= 0) return team === view.you % 2 ? 'Us' : 'Them';
    return `${escapeHtml(view.players[team].name)} & ${escapeHtml(view.players[team + 2].name)}`;
  };

  const pills = (view, seat) => {
    const player = view.players[seat];
    if (player.bid === null) return view.phase === 'bid' ? '<span class="pill is-quiet">…</span>' : '';
    const bid = player.bid === 0 ? 'Nil' : player.bid;
    return view.phase === 'bid' ? `<span class="pill">Bid ${bid}</span>` : `<span class="pill">${player.tricks} / ${bid}</span>`;
  };

  shell.setDraw((view) => {
    const where = seatsAround(view);
    const me = view.players[view.you];
    const playing = view.legal.includes('play');
    const hand = me ? handHtml(me.hand, cardSvg, { can: (index) => playing && view.playable.includes(index), dim: playing }) : [];

    let prompt;
    if (me?.out) prompt = { text: 'You left this game, so you’re watching.' };
    else if (view.legal.includes('bid')) {
      const buttons = Array.from({ length: 14 }, (_x, amount) => `<button type="button" class="btn btn-small" data-bid="${amount}">${amount === 0 ? 'Nil' : amount}</button>`).join('');
      prompt = { text: `Your bid. ${shell.countdown}`, mine: true, buttons: `<span class="bid-buttons">${buttons}</span>` };
    } else if (view.phase === 'bid') prompt = { text: `${shell.who(view.turn)} ${view.turn === view.you ? 'are' : 'is'} bidding.` };
    else if (view.phase === 'roundEnd') prompt = { text: 'Round over.' };
    else if (view.phase === 'trickEnd') prompt = { text: `${shell.who(view.trickWinner)} ${view.trickWinner === view.you ? 'take' : 'takes'} the trick.` };
    else if (playing) prompt = { text: `Your turn. ${shell.countdown}`, mine: true };
    else prompt = { text: shell.turnText(view.turn) };

    const order = view.you >= 0 ? [view.you % 2, 1 - (view.you % 2)] : [0, 1];
    const label = `${order.map((team) => `${teamName(view, team)} <b>${view.teams[team].score}</b>`).join(' · ')} · to ${view.rules.target}`;
    const middle =
      view.phase === 'roundEnd' && view.summary
        ? `<div class="pills round-summary">${order
            .map((team) => {
              const row = view.summary[team];
              return `<span class="pill${row.change > 0 ? ' is-win' : ''}">${teamName(view, team)} ${signed(row.change)}</span><span class="pill is-quiet">${row.tricks} of ${row.bid}</span>`;
            })
            .join('')}</div>`
        : trickHtml(view, cardSvg, lastPlayed);

    const rows = (view.results?.teams ?? [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((team) => ({ name: `${shell.who(team.seats[0])} and ${shell.who(team.seats[1], false)}`, total: team.score, winner: team.team === view.results.team }));
    const bottom = where.bottom;
    const mine = me
      ? `<div class="seat seat-me${view.turn === view.you ? ' active' : ''}${view.results?.winners.includes(view.you) ? ' winner' : ''}">
          <div class="pills">${pills(view, view.you)}</div>${shell.fan(hand)}</div>`
      : `<div class="seat trick-seat${view.turn === bottom ? ' active' : ''}"><div class="seat-head"><span class="seat-name">${escapeHtml(view.players[bottom].name)}</span></div><div class="pills">${pills(view, bottom)}</div></div>`;
    return `<div class="table">
      ${shell.top(label)}
      <div class="opponents trick-seats">${opponentsHtml(view, shell, escapeHtml, (seat) => pills(view, seat), (seat) => (me && seat === where.top ? 'Partner' : ''))}</div>
      <div class="shell-middle">${middle}</div>
      <div class="me">${mine}${shell.prompt(prompt)}</div>
      ${shell.scores(shell.winnersTitle(view.results?.winners ?? []), rows)}
    </div>`;
  });

  shell.setClick((event, view) => {
    if (!view) return;
    const card = event.target.closest('[data-card]');
    if (card) {
      hooks.act({ type: 'play', card: Number(card.dataset.card) });
      return;
    }
    const bid = event.target.closest('[data-bid]');
    if (bid) hooks.act({ type: 'bid', amount: Number(bid.dataset.bid) });
  });

  return shell.api({
    onView(_view, events) {
      const played = events.findLast((event) => event.type === 'played');
      lastPlayed = played ? played.seat : null;
    },
  });
}
