# Discord Activity design

> **What was built (10 Nov 2026).** The build is simpler than this draft. Where they differ, the code wins.
>
> - Server: `server/main.js` (HTTP, sign-in, sessions, WebSocket) and `server/rooms.js` (rooms, seats, host, games). No separate `http.js`, `discord.js` or `ws.js`.
> - Client: `client/main.js` and `client/activity.css`. The page markup is taken from `games/jacks/page.html` by `tools/build-activity.mjs`.
> - There is no `table.js`. `games/jacks/ui.js` gained `startOnline(hooks)`. Online, `game.state` is the server's view, and the test page's own bot scheduling is unused. The test page does not use `dealer.js`, so bot pacing lives in both `ui.js` and `dealer.js`.
> - `dealer.js` takes `{ players, rules, random, clock, timeouts, onUpdate }` and exposes `act, view, redact, setAuto, isAuto, deadline, finished, stop`. No freeze, snapshot, speed or record.
> - Messages: client sends `hello, sit, stand, addBot, removeBot, rules, start, lobby, act`; server sends `welcome, room, game, no, error`. No sequence numbers or acks.
> - Not built: persistence across restarts, kicking players, freezing an empty room (an empty room is deleted after 5 minutes).
> - Not verified inside real Discord. See `docs/SETUP.md`.


This is the contract for building the Discord Activity. Code and tests must match it. If something here turns out to be wrong, change this file in the same piece of work.

Status: **draft 1**. Section 9 (Discord specifics) is filled in from `docs/research/` once those briefs are verified.

## 1. What we are building

A Discord Activity that opens a game window inside Discord. Everyone who opens it in the same channel lands in one **room** with a lobby. One person is the **room host** (the first to arrive). The host picks settings, adds computer players and starts the game. Jacks is the only game for now; Go Fish, Blackjack and Texas Hold'em come later, so the room and lobby must not be tied to Jacks.

Rules that shape every decision:

1. **The server is the only place the whole game exists.** A client only ever receives `viewFor(state, seat)` and `eventFor(event, seat)` output for its own seat (or for a spectator, seat `-1`). The full state is never serialised to a client.
2. **One table.** The test page and the Activity draw the game with the same module. A rule or layout change is made once.
3. **One dealer.** The code that runs computer players and timers is one module, used by the test page in the browser and by the server.
4. **Nothing from a client is trusted.** Every message is checked, and the rules engine itself refuses malformed moves, so no caller can corrupt a game.
5. **Works without Discord.** A development sign-in lets several browser tabs join one room on `localhost`, so the whole thing can be tested before a Discord app exists. It cannot be switched on by a client and does not work through a proxy or tunnel.
6. **Sandbox-safe pages.** No `<form>`, no form submits, no inline scripts or event-handler attributes, no resources from other origins (fonts are self-hosted), dialogs closed from click handlers. (A form submit already trapped Cameron in a menu once.)
7. **Few words on screen.** Normal play does not explain rules. Teaching lives in the tutorial.

## 2. Modules

```
games/jacks/engine.js     rules. Pure, JSON-safe state. Hardened against hostile moves (section 3).
games/jacks/bots.js       computer players. Only use redacted views and events.
games/jacks/dealer.js     NEW. Runs one game: computer players, stand-ins and every timer (section 4).
games/jacks/tutorial.js   the tutorial script. Unchanged.
games/jacks/table.js      NEW. Draws a view, animates events, turns clicks into moves (section 5).
games/jacks/ui.js         the test page shell: opening screen, settings, test tools, tutorial coach.
games/jacks/style.css     styles shared by the test page and the Activity.
games/jacks/page.html     the test page template.

server/main.js            process entry: reads config, starts HTTP and WebSocket, shuts down cleanly.
server/config.js          environment variables (section 8).
server/http.js            static files and /api routes (section 7).
server/discord.js         Discord calls: code exchange, who-am-I, optional instance check.
server/sessions.js        session tokens.
server/rooms.js           rooms, members, seats, room host, game lifecycle (section 6). Game-agnostic.
server/games.js           registry of games. Each entry adapts one game to the room (section 6.6).
server/protocol.js        checks every incoming message, builds every outgoing one (section 6.7).
server/ws.js              WebSocket connections: hello, rate limit, heartbeat.

client/index.html         the Activity page template. No inline script or style.
client/main.js            boot: find out where we are, sign in, connect, show the right screen.
client/discord.js         the only file that touches the Discord SDK.
client/net.js             WebSocket client with reconnect.
client/online.js          the table's driver over the socket (section 5.1).
client/lobby.js           the room lobby.
client/activity.css       styles only the Activity needs.

tools/build-artifact.mjs  builds dist/jacks.html (the test page, one file).
tools/build-activity.mjs  builds dist/activity/ (what the server serves).
tools/serve.mjs           local preview of the test page (unchanged port 5199).
```

Both builds bundle with esbuild, so modules keep their own scope. (The old build pasted modules into one script, where two files declaring the same name would break the page at load.)

## 3. Engine hardening

The engine is about to receive moves from the network. These hold for `applyAction(state, seat, action)` with **any** JSON value as `action` (`seat` is trusted: the server assigns it):

- It never throws. It returns `{ ok: false, error }` for anything it does not accept.
- A refused move leaves `state` exactly as it was (deep-equal).
- After any accepted move the state is still valid: every array is still an array of the same kind, every slot holds a card object or `null`, and the 54 cards each exist exactly once across the draw pile, discard pile, hands and the drawn card.
- Every index a move supplies (`slot`, `own`, `owner`, `target.seat`, `target.slot`, `other.seat`, `other.slot`) must be an integer (`Number.isInteger`) inside the array it indexes. Strings such as `"length"`, `"0"` or `"__proto__"`, fractions, negatives and out-of-range numbers are refused. `target` and `other` must be plain objects.
- No value from a move is copied into an event or into the state unless it has passed those checks.
- `normaliseRules(x)` accepts any value and never throws.

**Shuffles the players cannot predict.** The seeded generator has 32 bits of state, so a player could work out the whole deck from the cards they have seen. `createGame({ ..., random })` and `applyAction(state, seat, action, { random })` take an optional `random()` returning a number in `[0, 1)`. When given, it is used for the opening shuffle, the choice of first player and every reshuffle. The server always passes one backed by `node:crypto`. Without it the engine uses the seed as before, which keeps tests, the tutorial and bug reports repeatable.

Tests: a hostile-input test for every handler, and a fuzz test that plays thousands of seeded games mixing legal moves with random junk and checks the three invariants above after every call.

## 4. The dealer (`games/jacks/dealer.js`)

One dealer runs one game of Jacks. It has no DOM and no network code. It is the only code that calls `applyAction`, `closeMatchWindow` and `closeLastCall` during play.

```js
createDealer({
  state,            // from createGame(), createTutorialGame(), or snapshot().state
  seats,            // [{ kind: 'human' | 'bot' | 'script' }] in player order
  bots,             // saved bot objects from snapshot(); otherwise made here, one for EVERY seat
  botSeed,          // seeds the bots' own randomness; default state.seed
  clock,            // { now(), setTimeout(fn, ms) -> id, clearTimeout(id), random() }; default: the real ones
  random,           // optional unpredictable random() handed to the engine (section 3)
  timeouts,         // { giveMs, peekMs } for seats played by people; missing or null = wait for ever
  autoLastCall,     // default true. false: the caller ends the last chance itself (the tutorial)
  keepRecord,       // default false. true: every raw event is kept in dealer.record (bug-report tool)
  onUpdate,         // ({ events }) => void, called synchronously after every change
})
```

It returns:

| Member | Meaning |
|---|---|
| `state` | The live state. Local test tools may read it. The server never sends it anywhere. |
| `record` | Raw events so far, when `keepRecord`. |
| `view(viewer)` | `viewFor(state, viewer)`. `viewer` is a seat, or `-1` for a spectator. |
| `redact(events, viewer)` | Each event through `eventFor`. |
| `seats()` | `[{ kind, auto, away }]`, in player order. |
| `timers()` | `[{ kind: 'match' \| 'lastCall' \| 'give' \| 'peek', seat?, msLeft }]` for countdowns on screen. |
| `waitingOn()` | Seats that must act before play can continue: the giver; in the opening peek, everyone not ready; otherwise the player whose turn it is. `[]` in the last chance and when finished. |
| `act(seat, action)` | A move by that seat. Returns `{ ok: true }` or `{ ok: false, error }`. |
| `closeLastCall()` | For `autoLastCall: false`. |
| `setAuto(seat, on)` | A person's seat is played by its stand-in while `auto` is on. |
| `setAway(seat, on)` | Marks a person as disconnected. Shown on screen. Does not change who plays by itself. |
| `setBotsPaused(on)` | Test tool: computer moves wait. Timed windows still run. |
| `setSpeed(x)` | Test tool: computer players move `x` times faster. |
| `setFrozen(on)` | Holds **every** pending timer, and resumes each with the time it had left. The server freezes a game while nobody is connected. |
| `stackNextDraw(rank)` | Test tool (`stackNextCard`). |
| `snapshot()` | `{ state, bots, seats }` as plain JSON. `createDealer(snapshot)` resumes it and restarts the right timers. |
| `stop()` | Clears every timer. The dealer does nothing afterwards. |

`onUpdate({ events })` gets the **raw** events of one change. Whoever shows them to a person must pass them through `redact` first. A change with no events (a seat going away, auto being switched) still calls `onUpdate({ events: [] })`.

### 4.1 Behaviour kept exactly as it is in today's `ui.js`

- Pacing of computer moves by phase: draw 800–1300 ms, decide 900–1700, power 900–1400, endTurn 400–800, giving a card 900–1600, getting ready in the peek 900–2200. Divided by the speed setting.
- One pending turn move at a time, keyed by turn number, phase, power stage and whether matching is open, so nothing moves twice.
- After a swap, a discard, a correct match or a given card, each computer player may try a match: its own card after 700 ms to `min(2600, 0.8 × window)`, capped so the Slow speed cannot miss a timed window; someone else's card after 3 to 5 **real** seconds whatever the speed. A computer player that fails `botNoticesMatch` does not try.
- Countdown matching: `matchWindowOpened` starts a timer that calls `closeMatchWindow`.
- The last chance: the `lastCall` event starts a timer of `lastCallSeconds(rules)` that calls `closeLastCall`, retrying every 300 ms while a card is still owed.
- A computer move the engine refuses is logged and replaced by the first legal fallback of draw, discard, skipPower, powerDone, endTurn.

### 4.2 New behaviour

- **Every seat has a bot object**, people included. It watches that seat's redacted events from the start and memorises the two cards shown in the opening peek, so it can stand in for the person later knowing only what they could know. `bots.js` gains an exported `botMemorise(bot, view)` for this.
- **Stand-ins.** While a person's seat has `auto` on, the dealer plays their forced moves with that seat's bot, at computer pace: getting ready, giving a card, and their turn. A stand-in never calls Jacks (it ends the turn instead) and never tries a match. Turning `auto` off cancels any move it had pending.
- **Timeouts for people** (server only): when a person owes a card, after `giveMs` their stand-in gives one. In the opening peek, after `peekMs` everyone not yet ready is made ready. Neither turns `auto` on.
- **`script` seats** (the tutorial's Ada) are never moved by the dealer.
- **Frozen** means no timer fires, including the timed windows and the timeouts.

### 4.3 Tests

`test/jacks.dealer.test.js` drives a dealer with a fake clock: pacing, no double moves, matching by computer players (own and others'), the countdown, the last chance waiting for an owed card, stand-ins, both timeouts, frozen and resumed timers keeping their remaining time, snapshot and resume, and whole games played to the end with a mix of bots and stand-ins.

## 5. The table (`games/jacks/table.js`)

The table draws one viewer's game and nothing else. It does not know whether the game runs in the same page or on a server. It is `ui.js` minus the opening screen, settings, test tools, tutorial script and everything section 4 took.

Changes from today's `ui.js`:

- The viewer is `view.you`, not seat 0. `view.you === -1` is a spectator: every player is drawn in the top area, there are no controls, and the bottom area says only "Watching".
- Opponents are drawn clockwise starting with the seat after the viewer.
- A seat is called "You" for the viewer and `view.players[seat].name` otherwise. Names come from other people: they are only ever written with `textContent` or through `escapeHtml`.
- It never reads the full state. Test tools that show hidden cards get them through an optional hook from the shell.
- Countdowns come from the driver's timers. The table starts no game timers of its own. (It still times its own animations, the brief reveals and the results delay.)
- Seat chips also show "Away" for a disconnected person and "Computer covering" while a stand-in plays for them.

### 5.1 The driver

The shell gives the table a driver:

```js
driver = {
  view(),          // the latest view for this viewer, or null before the first one
  seats(),         // [{ kind, auto, away, avatar }] in player order (avatar may be null)
  timers(),        // [{ kind, seat?, endsAt }] with endsAt on the performance.now() clock
  act(action),     // -> Promise<{ ok: true } | { ok: false, error }>
  onUpdate(fn),    // fn({ events }) after a new view has arrived. Returns an unsubscribe function.
}
```

On each update the table captures where the cards are on screen, re-renders from `driver.view()`, then animates the (already redacted) events from the captured positions. That is today's order.

- **Local driver** (`ui.js`): wraps a dealer in the page, viewer seat 0. `act` resolves at once. Used for games against computer players and for the tutorial.
- **Online driver** (`client/online.js`): the view, seats and timers come from the latest `game` message; `act` sends an `act` message and resolves when the server answers (section 6.7), or with an error after 8 seconds.

### 5.2 Shell hooks

The table takes optional hooks so the shells keep their own features without the table knowing about them: the tutorial (which moves are allowed, which cards to point at, what to do after a move), the test tools (hidden card to show for a slot, for the drawn card and for the top of the draw pile), and what the results panel offers (for example "Deal again").

### 5.3 The test page stays the same

After the split the test page must behave exactly as it does now: opening screen, settings saved on the device, tutorial, test tools, results, and a game surviving a page update. Two small fixes ride along: the saved game snapshot also carries the settings (so a page update cannot silently reset them when storage is blocked), and the artifact build uses esbuild.

## 6. Rooms (`server/rooms.js`)

### 6.1 People

`user = { id, name, avatar }`. `id` is the Discord user id (a string), or `dev:<hex>` from the development sign-in. `name` is the display name, cleaned by the server: control and direction-override characters removed, trimmed, cut to 32 characters, "Player" if empty. `avatar` is a URL or `null`.

### 6.2 The room

One room per Discord activity instance, kept in memory.

```
room = {
  id,                 // the instance id (checked: 1–128 of A–Z a–z 0–9 _ -)
  members,            // everyone who has connected: { user, connection or null, wantsSeat }
  hostId,             // the room host's user id
  gameId,             // 'jacks'
  rules,              // normalised settings for that game
  seats,              // lobby seating, also turn order: { kind: 'human', userId } | { kind: 'bot', name }
  phase,              // 'lobby' | 'playing' | 'finished'
  table,              // while playing or finished: the dealer plus which user sits where
}
```

- A user has at most one connection to a room. A newer one replaces the older, which is told `replaced` and closed. A user is in at most one room at a time.
- **Room host**: the first member. If the host has been disconnected for 15 seconds, the role passes to the connected member who has been in the room longest. It does not pass back by itself.
- **Limits**: 64 members per room, 8 seats, 500 rooms. A room with nobody connected for 5 minutes is deleted and its dealer stopped.

### 6.3 Lobby

- In the lobby, a connected member who wants a seat is seated automatically while seats are free (in order of arrival). "Stand up" clears that wish; "Sit down" sets it.
- A member who stays disconnected for 10 seconds in the lobby loses their seat.
- The host can add computer players (names Ada, Bea, Cal, Dot, Eli, Fay, Gus, first unused), remove any seat, and change the settings. Settings are normalised by the game before they are stored.
- Start needs 2 to 8 seats. Seats of disconnected people are dropped at that moment; if fewer than 2 remain, the start is refused.

### 6.4 Playing

- Starting builds the players in seat order, creates the game with unpredictable shuffles and seeds (`node:crypto`), and a dealer with `timeouts = { giveMs: 20000, peekMs: 30000 }`.
- Seated people play. Everyone else in the room watches as a spectator (seat `-1`). Someone who arrives mid-game watches.
- A seated person who disconnects is marked away at once. After 15 seconds still away, their seat's `auto` goes on. When they reconnect, away and that `auto` go off and they carry on.
- The host can switch `auto` on for any person's seat the game is waiting on ("Play for them"). Any move by that person switches it off again.
- While no member is connected the dealer is frozen.
- The host can end the game early (back to the lobby).

### 6.5 Finished

The results stay on screen. The host can deal again with the same seats (dropping disconnected people) or go back to the lobby. Going back to the lobby seats waiting members as in 6.3.

### 6.6 Games registry (`server/games.js`)

```js
games.jacks = {
  id: 'jacks', name: 'Jacks', minPlayers: 2, maxPlayers: 8,
  defaultRules, normaliseRules,
  start({ players, rules, clock, random, onUpdate }) -> table,   // players: [{ id, name, kind: 'human' | 'bot' }]
}
```

`table` is the dealer's interface from section 4 plus `isOver()`. The room only uses that interface, so another game can be added by writing its own engine, dealer and registry entry.

### 6.7 Protocol (version 1)

JSON text frames, one object per frame. Incoming frames over 4096 bytes close the connection. Unknown or malformed messages are refused and counted against the rate limit (20 messages burst, 10 per second refill; going over closes the connection).

Client to server:

| Message | Who | Meaning |
|---|---|---|
| `{ t: 'hello', v: 1, session, room }` | anyone | Must be the first frame, within 5 seconds. |
| `{ t: 'sit' }`, `{ t: 'stand' }` | member, lobby | Want a seat, or not. |
| `{ t: 'addBot' }` | host, lobby | Add a computer player. |
| `{ t: 'unseat', seat }` | host, lobby | Remove that seat. A removed person no longer wants a seat. |
| `{ t: 'rules', rules }` | host, lobby | Change settings. |
| `{ t: 'start' }` | host, lobby or finished | Deal. |
| `{ t: 'lobby' }` | host, playing or finished | Back to the lobby (ends a game in progress). |
| `{ t: 'act', n, action }` | seated player, playing | A move. `n` is the client's own counter. |
| `{ t: 'auto', seat, on }` | host for any person's seat (`on: true`); a player for their own seat | Stand-in on or off. |

Server to client:

| Message | Meaning |
|---|---|
| `{ t: 'welcome', v: 1, you, room, game }` | Sent after a good hello. `game` is `null` in the lobby. |
| `{ t: 'room', room }` | The room changed. |
| `{ t: 'game', game, events, ack }` | The game changed. `events` are redacted for this viewer. `ack` is the `n` of this viewer's own move that caused it, otherwise absent. |
| `{ t: 'no', n, error }` | That move was refused. `error` is a short sentence for the player. |
| `{ t: 'error', code, message }` | Fatal; the server then closes. Codes: `bad-hello`, `bad-session`, `not-in-activity`, `full`, `replaced`, `rate`, `version`. |

```
room = { id, phase, hostId, gameId, rules, minPlayers, maxPlayers,
         seats:   [{ kind, userId, name, avatar, connected }],      // userId and avatar null for a computer player
         members: [{ id, name, avatar, connected, seated }] }

game = { seq,                                   // counts up by one per game message in this room
         view,                                  // viewFor for this viewer
         timers: [{ kind, seat?, ms }],         // ms left
         seats:  [{ kind, auto, away, userId, avatar }] }   // in player order
```

A reconnecting client gets `welcome` with the current game and rebuilds the table from the view with no animation.

### 6.8 What the server guarantees

- Every `view` sent to a connection equals `viewFor(state, thatSeat)` and every event equals `eventFor(event, thatSeat)`. The words `drawPile`, `rng` and `seed` never appear in an outgoing frame.
- No incoming message can throw out of the message handler. A handler error is logged and that one connection is closed.
- Authentication, session tokens, codes and secrets are never logged.

### 6.9 Tests

- `test/server.rooms.test.js`: rooms with a fake clock and fake connections. Seating, host hand-over, limits, permissions for every message, start and deal again, away and stand-in timing, freezing when empty, deletion.
- `test/server.protocol.test.js`: every malformed message is refused without changing anything.
- `test/server.e2e.test.js`: the real server on a spare port with the development sign-in, real WebSocket clients that choose moves with `botAct`, whole games played to the end, and a checker run on every frame each client receives that fails if it contains a card that seat may not know. Also reconnecting mid-game, a replaced connection, junk and oversized frames, the rate limit, and the token route against a fake Discord.

## 7. HTTP (`server/http.js`)

| Route | Meaning |
|---|---|
| `GET /api/config` | `{ v: 1, clientId, devLogin }`. Nothing secret. |
| `POST /api/token` | Body `{ code }`. Exchanges the code with Discord, asks Discord who the user is, makes a session. Answers `{ access_token, session, user }`. |
| `POST /api/dev-login` | Body `{ name }`. Only when development sign-in is on **and** the request carries no proxy headers. Answers `{ session, user }`. Otherwise 404. |
| `GET /api/health` | `{ ok: true }`. |
| WebSocket `/ws` | Section 6.7. |
| anything else | Static files from `dist/activity/`. `index.html` is never cached; hashed assets are cached for a year. No path may leave that folder. |

Request bodies are JSON, at most 2 KB. The token and sign-in routes are rate limited. A session token is 32 random bytes; it is sent in the WebSocket hello frame, never in a URL. Sessions last 12 hours.

## 8. Configuration and commands

`.env` (never committed, never written by Claude):

```
DISCORD_CLIENT_ID=        # from the Developer Portal
DISCORD_CLIENT_SECRET=    # from the Developer Portal
DISCORD_BOT_TOKEN=        # optional: lets the server check that a user really is in the activity
PORT=3000
```

Commands:

| Command | What it does |
|---|---|
| `npm test` | Every test. |
| `npm run build` | The test page (`dist/jacks.html`). |
| `npm run build:activity` | The Activity client (`dist/activity/`). |
| `npm run dev` | Builds the Activity, then runs the server on `http://localhost:5200` with the development sign-in. |
| `npm start` | Runs the server for Discord. Refuses to start without the client id and secret. |

## 9. Discord specifics

To be filled in from `docs/research/discord-sdk.md` and `docs/research/discord-network.md`.

## 10. Screens in the Activity

- **Connecting.** One line of status. On failure, what went wrong and a "Try again" button.
- **Lobby.** The game's name. The seats, each with avatar, name, a mark for the room host, "Computer" for a computer player and "Away" when disconnected. People watching. For the host: add a computer player, remove a seat, Settings, Start. For everyone: Sit down or Stand up, Rules, Tutorial. Others see "Waiting for <host> to start."
- **Table.** The shared table. A slim bar with Rules and, for the host, "End game". Spectators see "Watching".
- **Results.** The shared results panel. The host gets "Deal again" and "Back to lobby"; others see who they are waiting for.
- **Tutorial.** The existing tutorial, run privately in that person's own window. If a game they are seated in starts, the tutorial closes.
- **Reconnecting.** A thin banner; controls are disabled until the connection is back.

## 11. Out of scope for this step

Saving rooms across a server restart, turn timers for connected players, changing seat order, chat, statistics, and the other three games.
