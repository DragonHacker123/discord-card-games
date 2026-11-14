# Research brief: Discord Activity network proxy, Content Security Policy and iframe sandbox

Status: FIRST PASS from salvaged notes (2026-11-10). Verification against primary pages is still in progress; tags below marked "(notes)" have not yet been re-checked by this run.

Tag convention: every key fact ends with `[VERIFIED: <url> | <section heading>]` or `[UNVERIFIED: <why>]`.

## 1. The proxy, the `/.proxy` prefix, URL Mappings, WebSocket URL form, `patchUrlMappings`

- All Activity network traffic goes through the Discord proxy at `https://<app id>.discordsays.com/<path>`; the proxy runs on Cloudflare Workers. (notes) [VERIFIED: https://docs.discord.com/developers/activities/development-guides/networking.md | Activity Proxy Considerations / Construct A Full URL]
- Since 30 July 2025 the CSP no longer requires the `/.proxy/` path; `https://<app id>.discordsays.com/api/x` and `https://<app id>.discordsays.com/.proxy/api/x` are equivalent and `/.proxy/` is kept indefinitely. (notes) [VERIFIED: https://docs.discord.com/developers/change-log.md | Remove .proxy/ from Discord Activity proxy path]
- URL Mappings: prefix -> target (target without protocol), root mapping `/` -> the host that serves the Activity HTML. (notes) [VERIFIED: https://docs.discord.com/developers/activities/development-guides/local-development.md | URL Mapping]
- `patchUrlMappings(mappings, config)` rewrites `fetch`, `WebSocket`, `XMLHttpRequest.prototype.open` (and optionally `src` attributes) so absolute third-party URLs go to the mapped prefix. (notes) [VERIFIED: https://raw.githubusercontent.com/discord/embedded-app-sdk/main/src/utils/patchUrlMappings.ts | source]

## 2. Proxy limits: timeouts, body size, WebSocket limits, headers, caching, rate limits

- Only WebSockets are supported for realtime; WebTransport and WebRTC are not. (notes) [VERIFIED: https://docs.discord.com/developers/activities/development-guides/networking.md | Activity Proxy Considerations]
- The proxy strips cache headers from `text/html` responses; other content types keep them. (notes) [VERIFIED: https://docs.discord.com/developers/activities/development-guides/production-readiness.md | Cache Busting]
- Optional signed proxy headers: `X-Signature-Ed25519`, `X-Signature-Timestamp`, `X-Discord-Proxy-Payload`. (notes) [VERIFIED: https://docs.discord.com/developers/activities/development-guides/multiplayer-experience.md | Validating Proxy Request Headers]

## 3. Content Security Policy applied to the Activity document

- Observed header on 2026-11-10 (earlier run, curl): `default-src 'self'; script-src 'self' 'unsafe-eval' 'nonce-...' blob:; style-src 'self' 'unsafe-inline' blob:; img-src 'self' blob: data: https://cdn.discordapp.com https://media.discordapp.net ...; font-src 'self' data:; connect-src https://<id>.discordsays.com/ wss://<id>.discordsays.com/ https://discord.com ... data: blob:; media-src 'self' blob: data:; frame-src ...; child-src ...; worker-src ...`. (notes; to re-observe)

## 4. Iframe `sandbox` and `allow` attributes, and their consequences

(to fill)

## 5. What the origin server needs

(to fill)

## 6. Local development outside Discord

(to fill)

## 7. Loading behaviour, `ready()`, failure screens

(to fill)

## 8. Avatar URLs

- User avatar: `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`; default avatar index `(BigInt(user.id) >> 22n) % 6n` -> `https://cdn.discordapp.com/embed/avatars/${index}.png`; sample code puts the URL straight into `<img src>`. (notes) [VERIFIED: https://docs.discord.com/developers/activities/development-guides/multiplayer-experience.md | Render Avatars and Names]

## 9. Other things that commonly break a first Activity

(to fill)

## Build implications

(to fill)
