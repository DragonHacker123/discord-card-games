# Getting the card games into Discord

The game server and the Discord client are built and tested on this PC. What's left needs your Discord account, so only you can do it. It takes about 15 minutes.

Nothing here has been tried inside real Discord yet. The steps marked **(check)** are from Discord's documentation as I remember it, and the developer portal's wording may differ.

## Try it without Discord first

```bash
npm run dev
```

Open http://localhost:5200 in two or three browser tabs. Each tab is a different made-up player. Add `?name=Cameron` to pick the name and `?room=abc` to use a separate room. This sign-in only works from this PC and only with `--dev`.

## 1. Create the Discord app

1. Go to https://discord.com/developers/applications and press **New Application**. Call it what you like (for example "Card Games").
2. Open **OAuth2**. Copy the **Client ID**. Press **Reset Secret** and copy the **Client Secret**.
3. Still on OAuth2, add a redirect: `https://127.0.0.1`. Discord needs one to exist, but the Activity never visits it. **(check)**
4. In the project folder, copy `.env.example` to `.env` and paste the two values in. Never share `.env` or paste it into a chat.

## 2. Put the server on Render

The code is in a public GitHub repo (no secrets are in it): https://github.com/DragonHacker123/discord-card-games. Render builds and runs it from there, using the settings in `render.yaml` (free plan, Frankfurt, one copy only).

1. Sign up at https://render.com. Signing up with GitHub is easiest.
2. In the Render dashboard, choose **New**, then **Blueprint**.
3. Connect GitHub if asked, and give Render access to the `discord-card-games` repo. Pick that repo.
4. Render reads `render.yaml` and asks for `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`. Paste the same values as in your `.env`. Then apply it.
5. The first build takes a few minutes. When it's live, Render shows an address like `https://discord-card-games.onrender.com`. Add `/api/health` to the end of it in a browser: it should say `{"ok":true,...}`.

Things to know about the free plan:

- It sleeps after 15 minutes without visitors. To stop that, the server pings itself every 10 minutes, and a GitHub Action (`.github/workflows/keep-awake.yml`) pings it too. If it was asleep anyway, the next person waits about a minute; if Discord shows an error, wait a minute and open it again.
- A game in progress keeps it awake.
- Whenever it sleeps, restarts or updates, any game in progress ends.
- When the code changes, it's pushed to GitHub and Render updates itself.

To test on your own PC instead, `npm run dev` still works (see above).

## 3. Turn on the Activity

1. In the developer portal, open **Activities** and switch **Enable Activities** on. **(check)**
2. Under **URL Mappings**, set the root mapping `/` to your Render address without the `https://` (for example `discord-card-games.onrender.com`).
3. Still under **Activities**, open **Settings**. Under **Supported Platforms**, tick **iOS** and **Android** as well as **Web**, then save. Until you do, the Activity only opens on a computer.
4. Open **Installation** and use the install link to add the app to your server.

Until Discord verifies the app, it only works in servers with fewer than 25 members, and only you and people you add as **App Testers** can see it (up to 50). **(check)** Verification is a separate form in the portal for later.

## 4. Play

Join a voice channel, press the Activities button (the rocket), and pick your app. Everyone who opens it in that channel lands in the same room.

- The first person in is the host. The host picks the game (Jacks, Blackjack, Texas Hold’em, Go Fish, Crazy Eights, Rummy, Hearts, Spades or Solitaire), adds computer players, changes settings and deals.
- Hearts and Spades need exactly four at the table, so add computer players to fill it. In those two games, the computer plays out the cards of anyone who leaves.
- Anyone who opens it mid-game watches until the next deal.
- If someone closes Discord and isn't back within 10 seconds, they forfeit: their cards go face down to the bottom of the discard pile, play skips them, and they can't win. If they come back, they watch until the next deal. If only one player is left, the game ends and they win.
- Someone who doesn't move for 45 seconds gets played for until they next press something.

## Optional: the bot token

With `DISCORD_BOT_TOKEN` set (in `.env` on your PC, or under **Environment** on Render), the server asks Discord whether each person really is in the activity they claim to be in. Without it, the room name (a long random ID Discord makes) is the only thing keeping strangers out. Get the token from the **Bot** page.

## If something goes wrong

- A blank or "Couldn’t sign you in" screen in Discord usually means the Client ID, Secret or URL mapping is wrong, or the server was asleep: wait a minute and open it again.
- "Open this from the Activities button" means you opened the Render address in a normal browser. That's expected.
- The server keeps games in memory. Restarting it ends every game.
- Render’s dashboard has a **Logs** tab that shows what the server printed.
