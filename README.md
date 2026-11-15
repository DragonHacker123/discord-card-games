# Discord card games

Card games for a Discord Activity. The order is:

1. Get Jacks right as a standalone test page. (Done)
2. Put Jacks into the Discord Activity. **(Built and tested locally. Needs a Discord app: see `docs/SETUP.md`.)**
3. Add Go Fish (**built; the host picks the game in the room**), then Blackjack and Texas Hold'em.

## Layout

- `games/jacks/engine.js`: the rules. It has no browser code, so the Discord server can run the same file.
- `games/jacks/bots.js`: the computer players. They only see what a human player would.
- `games/jacks/tutorial.js`: the scripted tutorial game, played on the real engine.
- `games/jacks/ui.js`, `style.css`, `page.html`: the test page.
- `tools/build-artifact.mjs`: inlines all of that into `dist/jacks.html`, which is what gets published.
- `games/gofish/`: Go Fish. `engine.js` (rules), `bots.js`, `dealer.js`, `table.js` (the screen, Activity only) and `style.css`. `server/rooms.js` lists the games a room can play in `GAMES`.
- `games/jacks/dealer.js`: runs a game for a table: computer players, countdowns, and playing for people who leave.
- `server/`: the game server. `rooms.js` is rooms and seats, `main.js` is sign-in and the network.
- `client/`: the Discord page. It reuses `ui.js` through `startOnline()`.
- `tools/build-activity.mjs`: builds the client into `dist/activity`.
- `test/`: one test per rule, the settings, what computer players know, the tutorial script, and thousands of computer-only games.

## Commands

```bash
npm test
```

```bash
npm run build
```

```bash
npm run serve
```

`npm run serve` previews the built page at http://localhost:5199.

```bash
npm run dev
```

`npm run dev` builds the Discord client and serves it at http://localhost:5200 with a made-up sign-in, one player per browser tab.
