// Rooms: who is here, who sits where, and the game they're playing.
// One room per Discord activity instance. This file has no network code. It is
// handed a send(userId, message) function per room member, which keeps it easy
// to test.
//
// Messages to a member:
//   { t: 'room', room }                              the lobby, sent on every change
//   { t: 'game', id, view, events, deadline }        one player's view of the table
//   { t: 'no', error }                               your last message was refused

import { createDealer as createJacksDealer } from '../games/jacks/dealer.js';
import * as jacks from '../games/jacks/engine.js';
import { createDealer as createFishDealer } from '../games/gofish/dealer.js';
import * as gofish from '../games/gofish/engine.js';
import { createDealer as createBlackjackDealer } from '../games/blackjack/dealer.js';
import * as blackjack from '../games/blackjack/engine.js';

/** Every game a room can play. The room only needs these few things from each. */
export const GAMES = {
  jacks: { name: 'Jacks', createDealer: createJacksDealer, normaliseRules: jacks.normaliseRules, defaults: jacks.DEFAULT_RULES, min: jacks.MIN_PLAYERS, max: jacks.MAX_PLAYERS },
  blackjack: { name: 'Blackjack', createDealer: createBlackjackDealer, normaliseRules: blackjack.normaliseRules, defaults: blackjack.DEFAULT_RULES, min: blackjack.MIN_PLAYERS, max: blackjack.MAX_PLAYERS },
  gofish: { name: 'Go Fish', createDealer: createFishDealer, normaliseRules: gofish.normaliseRules, defaults: gofish.DEFAULT_RULES, min: gofish.MIN_PLAYERS, max: gofish.MAX_PLAYERS },
};
const GAME_LIST = Object.entries(GAMES).map(([id, game]) => ({ id, name: game.name, min: game.min, max: game.max }));

export const LIMITS = {
  rooms: 500,
  members: 64,
  goneMs: 10000, // how long a closed connection keeps its lobby seat, or its place in a game before it forfeits
  emptyRoomMs: 5 * 60 * 1000,
};
const BOT_NAMES = ['Ada', 'Bea', 'Cal', 'Dot', 'Eli', 'Fay', 'Gus'];
const ROOM_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function createRooms({ random = Math.random, clock, timeouts, limits = {} } = {}) {
  const caps = { ...LIMITS, ...limits };
  const timer = clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
  const rooms = new Map();
  let nextGameId = 1;

  const seatOf = (room, userId) => room.seats.findIndex((seat) => !seat.bot && seat.id === userId);

  function describe(room) {
    return {
      host: room.host,
      playing: Boolean(room.dealer),
      finished: Boolean(room.dealer?.finished()),
      game: room.game,
      games: GAME_LIST,
      rules: room.rules,
      maxSeats: GAMES[room.game].max,
      minSeats: GAMES[room.game].min,
      seats: room.seats.map((seat, index) => ({
        id: seat.id,
        name: seat.name,
        avatar: seat.avatar ?? null,
        bot: Boolean(seat.bot),
        away: !seat.bot && (!room.members.get(seat.id)?.send || Boolean(room.dealer?.isAuto(index)) || Boolean(room.dealer?.hasLeft(index))),
      })),
      watching: [...room.members.values()]
        .filter((member) => member.send && seatOf(room, member.user.id) === -1)
        .map((member) => ({ id: member.user.id, name: member.user.name, avatar: member.user.avatar ?? null })),
    };
  }

  function sendRoom(room) {
    const message = { t: 'room', room: describe(room) };
    for (const member of room.members.values()) member.send?.(message);
  }

  function sendGame(room, events, only = null) {
    const { dealer } = room;
    if (!dealer) return;
    for (const member of room.members.values()) {
      if (!member.send || (only && member !== only)) continue;
      const seat = seatOf(room, member.user.id);
      member.send({
        t: 'game',
        id: room.gameId,
        view: dealer.view(seat),
        events: events.map((event) => dealer.redact(event, seat)),
        deadline: dealer.deadline(),
      });
    }
  }

  function awayList(room) {
    return room.dealer ? room.seats.map((_seat, index) => room.dealer.isAuto(index)).join() : '';
  }

  function startGame(room) {
    room.dealer?.stop();
    room.gameId = nextGameId++;
    room.dealer = GAMES[room.game].createDealer({
      players: room.seats.map((seat) => ({ id: seat.id, name: seat.name, bot: Boolean(seat.bot) })),
      rules: room.rules,
      random,
      clock,
      timeouts,
      onUpdate(events) {
        sendGame(room, events);
        // The lobby message carries who is away and whether the game is over.
        const now = `${awayList(room)}|${room.dealer.finished()}`;
        if (now !== room.lastAway) {
          room.lastAway = now;
          sendRoom(room);
        }
      },
    });
    room.lastAway = `${awayList(room)}|false`;
    // Anyone whose connection is closed right now gets played for straight away.
    room.seats.forEach((seat, index) => {
      if (!seat.bot && !room.members.get(seat.id)?.send) room.dealer.setAuto(index, true);
    });
    sendRoom(room);
    sendGame(room, []);
  }

  function endGame(room) {
    room.dealer?.stop();
    room.dealer = null;
    // People who left during the game lose their seats now.
    room.seats = room.seats.filter((seat) => seat.bot || room.members.get(seat.id)?.send);
    for (const [id, member] of room.members) {
      if (!member.send && member.goneTimer === null) room.members.delete(id);
    }
    pickHost(room);
    sendRoom(room);
  }

  function pickHost(room) {
    if (room.members.get(room.host)?.send) return;
    const next = [...room.members.values()].find((member) => member.send);
    if (next) room.host = next.user.id;
  }

  function closeRoom(room) {
    room.dealer?.stop();
    for (const member of room.members.values()) timer.clearTimeout(member.goneTimer);
    timer.clearTimeout(room.emptyTimer);
    rooms.delete(room.id);
  }

  /** Runs once a closed connection has stayed closed for a while. */
  function gone(room, member) {
    member.goneTimer = null;
    if (member.send) return;
    const seat = seatOf(room, member.user.id);
    // Leaving a game forfeits it. The seat stays in the list so seat numbers don't shift mid-game.
    if (room.dealer) {
      if (seat !== -1) room.dealer.forfeit(seat);
    } else if (seat !== -1) room.seats.splice(seat, 1);
    room.members.delete(member.user.id);
    pickHost(room);
    sendRoom(room);
  }

  const HANDLERS = {
    sit(room, member) {
      if (room.dealer) return 'Wait for this game to finish.';
      if (seatOf(room, member.user.id) !== -1) return null;
      if (room.seats.length >= GAMES[room.game].max) return 'The table is full.';
      room.seats.push({ id: member.user.id, name: member.user.name, avatar: member.user.avatar ?? null });
      return null;
    },
    stand(room, member) {
      if (room.dealer) return 'You can’t leave your seat during a game.';
      const seat = seatOf(room, member.user.id);
      if (seat !== -1) room.seats.splice(seat, 1);
      return null;
    },
    addBot(room, member) {
      if (member.user.id !== room.host) return 'Only the host can do that.';
      if (room.dealer) return 'Wait for this game to finish.';
      if (room.seats.length >= GAMES[room.game].max) return 'The table is full.';
      const name = BOT_NAMES.find((candidate) => !room.seats.some((seat) => seat.bot && seat.name === candidate));
      if (!name) return 'The table is full.';
      room.seats.push({ id: `bot-${name.toLowerCase()}`, name, bot: true });
      return null;
    },
    removeBot(room, member, message) {
      if (member.user.id !== room.host) return 'Only the host can do that.';
      if (room.dealer) return 'Wait for this game to finish.';
      const index = Number.isInteger(message.seat) && room.seats[message.seat]?.bot ? message.seat : room.seats.findLastIndex((seat) => seat.bot);
      if (index !== -1) room.seats.splice(index, 1);
      return null;
    },
    rules(room, member, message) {
      if (member.user.id !== room.host) return 'Only the host can change the settings.';
      room.rules = GAMES[room.game].normaliseRules(message.rules);
      return null;
    },
    game(room, member, message) {
      if (member.user.id !== room.host) return 'Only the host can pick the game.';
      if (room.dealer) return 'Wait for this game to finish.';
      const id = typeof message.game === 'string' && Object.hasOwn(GAMES, message.game) ? message.game : null;
      if (!id) return 'Unknown game.';
      if (id === room.game) return null;
      if (room.seats.length > GAMES[id].max) return `${GAMES[id].name} takes up to ${GAMES[id].max} players.`;
      room.savedRules[room.game] = room.rules;
      room.game = id;
      room.rules = room.savedRules[id] ?? GAMES[id].normaliseRules(GAMES[id].defaults);
      return null;
    },
    start(room, member) {
      if (member.user.id !== room.host) return 'Only the host can deal.';
      if (room.dealer && !room.dealer.finished()) return 'A game is already going.';
      if (room.dealer) room.seats = room.seats.filter((seat) => seat.bot || room.members.get(seat.id)?.send);
      if (room.seats.length < GAMES[room.game].min) return `${GAMES[room.game].name} needs at least ${GAMES[room.game].min} players.`;
      if (room.seats.length > GAMES[room.game].max) return `${GAMES[room.game].name} takes up to ${GAMES[room.game].max} players.`;
      if (!room.seats.some((seat) => !seat.bot)) return 'Someone has to sit down first.';
      startGame(room);
      return undefined;
    },
    lobby(room, member) {
      if (member.user.id !== room.host) return 'Only the host can end the game.';
      if (room.dealer) endGame(room);
      return undefined;
    },
    act(room, member, message) {
      if (!room.dealer) return 'There’s no game going.';
      const seat = seatOf(room, member.user.id);
      if (seat === -1) return 'You’re watching this game.';
      const result = room.dealer.act(seat, message.action);
      return result.ok ? undefined : result.error;
    },
  };

  return {
    /**
     * Connects a signed-in user to a room. Returns { leave, handle } or { error }.
     * A second connection from the same user replaces the first.
     */
    join(roomId, user, send, onReplaced = () => {}) {
      if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) return { error: 'bad-room' };
      let room = rooms.get(roomId);
      if (!room) {
        if (rooms.size >= caps.rooms) return { error: 'full' };
        room = { id: roomId, members: new Map(), seats: [], host: user.id, game: 'jacks', savedRules: {}, rules: jacks.normaliseRules(jacks.DEFAULT_RULES), dealer: null, gameId: 0, emptyTimer: null, lastAway: '' };
        rooms.set(roomId, room);
      }
      let member = room.members.get(user.id);
      if (!member) {
        if (room.members.size >= caps.members) return { error: 'full' };
        member = { user, send: null, goneTimer: null, replaced: null };
        room.members.set(user.id, member);
      }
      member.replaced?.();
      timer.clearTimeout(member.goneTimer);
      member.goneTimer = null;
      timer.clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
      member.user = user;
      member.send = send;
      member.replaced = onReplaced;
      const seat = seatOf(room, user.id);
      if (seat !== -1) {
        room.seats[seat].name = user.name;
        room.seats[seat].avatar = user.avatar ?? null;
        if (room.dealer?.isAuto(seat) && !room.dealer.hasLeft(seat)) room.dealer.setAuto(seat, false);
      }
      pickHost(room);
      sendRoom(room);
      sendGame(room, [], member);

      const mine = send;
      return {
        handle(message) {
          if (member.send !== mine) return;
          const handler = message && typeof message === 'object' && typeof message.t === 'string' && Object.hasOwn(HANDLERS, message.t) ? HANDLERS[message.t] : null;
          if (!handler) {
            mine({ t: 'no', error: 'Unknown message.' });
            return;
          }
          const refusal = handler(room, member, message);
          if (refusal) mine({ t: 'no', error: refusal });
          else if (refusal === null) sendRoom(room);
        },
        leave() {
          if (member.send !== mine) return;
          member.send = null;
          // The room may already have been closed (the server is shutting down).
          if (rooms.get(room.id) !== room) return;
          member.replaced = null;
          member.goneTimer = timer.setTimeout(() => gone(room, member), caps.goneMs);
          if (![...room.members.values()].some((other) => other.send)) {
            room.emptyTimer = timer.setTimeout(() => closeRoom(room), caps.emptyRoomMs);
          }
          sendRoom(room);
        },
      };
    },
    count: () => rooms.size,
    stop() {
      for (const room of [...rooms.values()]) closeRoom(room);
    },
    /** Tests only. */
    _rooms: rooms,
  };
}
