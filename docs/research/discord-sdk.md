# Research brief: Discord Embedded App SDK, sign-in and Developer Portal setup

Status: DRAFT IN PROGRESS. First pass written from the salvaged notes; items marked (TO CHECK) are being verified against the primary pages now.
Date of research: 2026-11-10.

Tag convention: every key fact ends with `[VERIFIED: <url> | <section heading>]` or `[UNVERIFIED: <why>]`.

## 1. SDK version, install, module format, dependencies, bundler, 3.0.0-beta

- Latest stable is `2.5.0` (published 2026-05-05); npm `dist-tags` are `{"latest":"2.5.0","beta":"3.0.0-beta.3"}`; `3.0.0-beta.3` was published 2026-10-26. [VERIFIED: https://registry.npmjs.org/@discord/embedded-app-sdk | dist-tags, time]
- Install: `npm install @discord/embedded-app-sdk`. [VERIFIED: https://docs.discord.com/developers/developer-tools/embedded-app-sdk.md | Install the SDK]
- Dual package: `main: output/index.cjs`, `module: output/index.mjs`, `types: output/index.d.ts`, `exports["."] = {types, import: ./output/index.mjs, require: ./output/index.cjs}`; no `"type"` field, no `engines`, no `peerDependencies`. [VERIFIED: https://registry.npmjs.org/@discord/embedded-app-sdk/latest | package metadata]
- Runtime dependencies: `zod ^3.9.8`, `uuid ^11.0.0`, `big-integer ^1.6.48`, `eventemitter3 ^5.0.0`, `decimal.js-light ^2.5.0`, `lodash.transform ^4.6.0` (plus `@types/uuid`, `@types/lodash.transform`). [VERIFIED: https://registry.npmjs.org/@discord/embedded-app-sdk/latest | dependencies]
- Bundler needed in the browser: (TO CHECK)
- 3.0.0-beta changes: (TO CHECK)

## 2. Start-up and sign-in sequence

- Sequence in the tutorial: `new DiscordSDK(clientId)` -> `await discordSdk.ready()` -> `discordSdk.commands.authorize({...})` returns `{ code }` -> POST the code to your own server -> server exchanges at `https://discord.com/api/oauth2/token` -> `discordSdk.commands.authenticate({ access_token })`. [VERIFIED: https://docs.discord.com/developers/activities/building-an-activity.md | Step 5: Authorizing & authenticating users]
- (details TO CHECK and expand)

## 3. OAuth2 scopes

(pending)

## 4. SDK properties, iframe query parameters, instanceId stability

(pending)

## 5. Participants

(pending)

## 6. Server-side instance check

- `GET https://discord.com/api/applications/<application_id>/activity-instances/<instance_id>` with header `Authorization: Bot <bot token>`; 200 body has `application_id`, `instance_id`, `launch_id`, `location` (`id`, `kind`, `channel_id`, `guild_id`) and `users` (array of user ids); 404 when no such instance. [VERIFIED: https://docs.discord.com/developers/activities/development-guides/multiplayer-experience.md | Using the Activity Instance API]

## 7. Developer Portal setup, step by step

(pending; notes cover the tutorial)

## 8. Limits for an unverified app

- Unverified Activities launch only in servers with fewer than 25 members; visible only to the owner, the developer team and invited App Testers (max 50 testers; team max 100). [VERIFIED: https://support-dev.discord.com/api/v2/help_center/en-us/articles/21204493235991.json | Unverified Activities]

## 9. Optional extras and their scopes

(pending)

## 10. Mobile and layout

(pending)

## 11. Known pitfalls

(pending)

## Build implications

(pending)
