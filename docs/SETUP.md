# Getting Jacks into Discord

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

## 2. Put the server on the internet

Discord has to reach your server over HTTPS. The cheapest way to test is a Cloudflare quick tunnel from this PC. It's free and needs no account, but the address changes every time you start it, and the game only works while your PC is on.

1. Install `cloudflared` (Cloudflare's tunnel program).
2. Start the game server:

```bash
npm run build:activity
```

```bash
npm start
```

3. In a second terminal, start the tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints an address like `https://some-words.trycloudflare.com`.

For something permanent, the server is one ordinary Node program (`npm start`, port from `PORT`) and needs a host that allows WebSockets and doesn't put the program to sleep mid-game. I haven't compared hosts or prices, so that is still to decide.

## 3. Turn on the Activity

1. In the developer portal, open **Activities** and switch **Enable Activities** on. **(check)**
2. Under **URL Mappings**, set the root mapping `/` to your tunnel address without the `https://` (for example `some-words.trycloudflare.com`).
3. Open **Installation** and use the install link to add the app to your server.

Until Discord verifies the app, it only works in servers with fewer than 25 members, and only you and people you add as **App Testers** can see it (up to 50). **(check)** Verification is a separate form in the portal for later.

## 4. Play

Join a voice channel, press the Activities button (the rocket), and pick your app. Everyone who opens it in that channel lands in the same room.

- The first person in is the host. The host adds computer players, changes settings and deals.
- Anyone who opens it mid-game watches until the next deal.
- If someone closes Discord and isn't back within 10 seconds, they forfeit: their cards go face down to the bottom of the discard pile, play skips them, and they can't win. If they come back, they watch until the next deal. If only one player is left, the game ends and they win.
- Someone who doesn't move for 45 seconds gets played for until they next press something.

## Optional: the bot token

With `DISCORD_BOT_TOKEN` in `.env`, the server asks Discord whether each person really is in the activity they claim to be in. Without it, the room name (a long random ID Discord makes) is the only thing keeping strangers out. Get the token from the **Bot** page.

## If something goes wrong

- A blank or "Couldn't sign you in" screen in Discord usually means the Client ID, Secret or URL mapping is wrong, or the tunnel address has changed since you set the mapping.
- "Open this from the Activities button" means you opened the tunnel address in a normal browser. That's expected.
- The server keeps games in memory. Restarting it ends every game.
