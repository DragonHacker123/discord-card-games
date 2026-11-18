// Drawing shared by the trick-taking tables (Hearts and Spades): four seats
// round the table as you see them, and the cards played to the trick.

/** Which seat sits where, from the viewer's side of the table. Someone watching sits behind seat 0. */
export function seatsAround(view) {
  const base = view.you >= 0 ? view.you : 0;
  return { bottom: base, left: (base + 1) % 4, top: (base + 2) % 4, right: (base + 3) % 4 };
}

/** The trick: one card in front of each seat, in a diamond. The winning card is ringed. */
export function trickHtml(view, cardSvg, lastPlayed = null) {
  const where = seatsAround(view);
  const spot = (position) => {
    const play = view.trick.find((entry) => entry.seat === where[position]);
    if (!play) return `<span class="trick-spot t-${position}"></span>`;
    const classes = `pc${view.trickWinner === play.seat ? ' is-winning' : ''}${lastPlayed === play.seat ? ' is-new' : ''}`;
    return `<span class="trick-spot t-${position}"><span class="${classes}">${cardSvg(play.card)}</span></span>`;
  };
  return `<div class="trick">${['top', 'left', 'right', 'bottom'].map(spot).join('')}</div>`;
}

/**
 * The three seats across the top: left, opposite, right. pillsFor(seat) gives each one's line of facts,
 * and tagFor(seat) an optional word beside the name (such as Partner).
 */
export function opponentsHtml(view, shell, escapeHtml, pillsFor, tagFor = () => '') {
  const where = seatsAround(view);
  return ['left', 'top', 'right']
    .map((position) => {
      const seat = where[position];
      const player = view.players[seat];
      const chip = shell.chipFor(seat) || tagFor(seat);
      const active = view.turn === seat ? ' active' : '';
      const winner = view.results?.winners.includes(seat) ? ' winner' : '';
      return `<div class="seat trick-seat${active}${winner}${player.out ? ' is-out' : ''}">
        <div class="seat-head"><span class="seat-name">${escapeHtml(player.name)}</span>${chip ? `<span class="seat-chip">${chip}</span>` : ''}</div>
        <div class="pills">${pillsFor(seat)}</div></div>`;
    })
    .join('');
}

/** Your own cards as buttons (when they can be played or picked) or plain cards. */
export function handHtml(hand, cardSvg, { can = () => false, picked = () => false, fresh = () => false, dim = false, ring = true, label = 'Play' }) {
  const names = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
  return hand.map((card, index) => {
    const usable = can(index);
    const classes = `pc${usable ? (ring ? ' can-play' : ' can-pick') : dim ? ' is-dim' : ''}${picked(index) ? ' is-picked' : ''}${fresh(card) ? ' is-new' : ''}`;
    return usable
      ? `<button type="button" class="${classes}" data-card="${index}" aria-label="${label} ${card.rank} of ${names[card.suit]}">${cardSvg(card)}</button>`
      : `<span class="${classes}">${cardSvg(card)}</span>`;
  });
}
