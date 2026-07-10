# Discord Setup

This document explains how to create and configure the Discord Developer Portal application used by this project.

The current repository implements Phase 7 plus configurable Jellyfin auth mode. It can launch as a web app, initialize the Discord Embedded App SDK, exchange a Discord OAuth code through the backend, issue a short-lived app session token, call `/api/me`, use either per-user Jellyfin linking or one shared Jellyfin account, browse/search Jellyfin items, select media as host, prepare playback, stream through the backend media proxy, synchronize host playback commands over `/ws`, enforce room limits, redact tokens from backend request logs, rate-limit requests, clean up idle rooms, and run deployment smoke checks.

## What Discord Is Loading

Discord Activities are web apps loaded inside a Discord iframe. The Activity frontend uses the Embedded App SDK to communicate with the Discord client, read the current Activity `instanceId`, and later request OAuth authorization.

For this project, production should use one public HTTPS origin:

```text
https://watch.example.com
```

That one origin should serve:

```text
/          React Activity frontend
/api       REST API
/ws        WebSocket endpoint
/media     proxied Jellyfin media routes
```

Using one origin keeps Discord URL mappings, CORS, cookies, WebSockets, and media proxying simpler.

## Prerequisites

Before configuring Discord, have these ready:

1. A Discord account with access to the Discord Developer Portal.
2. A test Discord server where you can join a voice channel.
3. Developer Mode enabled in Discord.
4. A public HTTPS URL for production, for example `https://watch.example.com`.
5. For local Discord testing, a tunnel URL that forwards to your local app, for example from `cloudflared`, ngrok, or another HTTPS tunnel.
6. A local `.env` file copied from `.env.example`.

For local development outside Discord, you can run:

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Then open:

```text
http://localhost:5173
```

The frontend uses dev mock mode when `VITE_DEV_DISCORD_MOCK=true`, so basic local UI work does not require launching through Discord.

## 1. Create The Discord Application

1. Open the Discord Developer Portal:

   ```text
   https://discord.com/developers/applications
   ```

2. Click `New Application`.
3. Name it something clear, for example:

   ```text
   Jellyfin Watch Party
   ```

4. Select your app from the application list.
5. Open `General Information`.
6. Copy the `Application ID`. This is the same value this project refers to as the Discord client ID.
7. Put that value in `.env`:

   ```bash
   PUBLIC_DISCORD_CLIENT_ID=your_application_id
   DISCORD_CLIENT_ID=your_application_id
   ```

8. Add an app icon and description if you want the Activity to be easier to recognize in Discord.

Do not put the Discord client secret in frontend environment variables. `PUBLIC_DISCORD_CLIENT_ID` is safe for the browser. `DISCORD_CLIENT_SECRET` is backend-only.

## 2. Create Or Reset The Client Secret

The backend needs the Discord client secret for OAuth code exchange.

1. In the Developer Portal, open your application.
2. Go to `OAuth2`.
3. Open the OAuth2 general/settings page.
4. Find `Client Secret`.
5. Click `Reset Secret` if no secret is visible or if you want a fresh one.
6. Copy it immediately.
7. Put it in `.env`:

   ```bash
   DISCORD_CLIENT_SECRET=your_client_secret
   ```

Treat this like a password:

- Do not commit `.env`.
- Do not expose it through `VITE_` or `PUBLIC_` variables.
- Rotate it if it is accidentally pasted into chat, logs, screenshots, or source control.

## 3. Enable Activities / Embedded App Support

1. In the Developer Portal, open your application.
2. Look for the `Activities` section in the left navigation.
3. Enable Activity or Embedded App support if the portal presents an enable button.
4. Configure the Activity for desktop/web first.
5. Leave mobile disabled until the app has been tested in Discord desktop and browser clients.

The exact Developer Portal labels can change. The key requirement is that your application has Activities enabled and has access to the `Activities -> URL Mappings` page.

## 4. Configure OAuth2 Redirects

The Activity frontend asks Discord for an OAuth code, then the backend exchanges that code with `DISCORD_CLIENT_SECRET`.

For production, use:

```text
https://watch.example.com/api/discord/callback
```

For a local tunnel, use your tunnel hostname:

```text
https://your-tunnel.example.com/api/discord/callback
```

Steps:

1. In the Developer Portal, open your application.
2. Go to `OAuth2`.
3. Find `Redirects` or `Redirect URIs`.
4. Add your production redirect URI:

   ```text
   https://watch.example.com/api/discord/callback
   ```

5. If you are testing through a tunnel, add the tunnel redirect URI too.
6. Save changes.
7. Update `.env`:

   ```bash
   DISCORD_REDIRECT_URI=https://watch.example.com/api/discord/callback
   ```

For local tunnel testing, temporarily change `.env`:

```bash
DISCORD_REDIRECT_URI=https://your-tunnel.example.com/api/discord/callback
PUBLIC_BASE_URL=https://your-tunnel.example.com
PUBLIC_WS_URL=wss://your-tunnel.example.com/ws
```

Keep the redirect URI exact. Scheme, host, path, and trailing slash behavior must match what the backend uses.

## 5. Configure Activity URL Mappings

Discord Activities run behind Discord's proxy. The Activity cannot freely call arbitrary external URLs unless the app has URL mappings that allow those requests. The Developer Portal mapping page is usually under:

```text
Activities -> URL Mappings
```

Important formatting rule:

- The `PREFIX` starts with `/`.
- The `TARGET` is a host, optionally with a path.
- The `TARGET` must not include `https://` or `wss://`.

Correct:

```text
PREFIX      TARGET
/           watch.example.com
```

Incorrect:

```text
PREFIX      TARGET
/           https://watch.example.com
```

### Recommended Production Mapping

Because this app serves frontend, API, WebSocket, and media proxy routes from one origin, start with one mapping:

```text
PREFIX      TARGET
/           watch.example.com
```

If Discord proxy behavior is easier to debug with explicit paths, add these:

```text
PREFIX      TARGET
/           watch.example.com
/api        watch.example.com
/ws         watch.example.com
/media      watch.example.com
/assets     watch.example.com
```

All of those should point at the same app domain.

### Recommended Local Tunnel Mapping

Start the local app:

```bash
pnpm dev
```

For a production-like local test, run the built backend on port `3000` or use Docker:

```bash
cp .env.example .env
docker compose up --build
```

Create a public tunnel to the app origin. With `cloudflared`, for example:

```bash
cloudflared tunnel --url http://localhost:3000
```

If the tunnel prints:

```text
https://example-tunnel.trycloudflare.com
```

then set the Activity URL mapping to:

```text
PREFIX      TARGET
/           example-tunnel.trycloudflare.com
```

Do not include `https://` in the target.

If you are testing only the Vite frontend through Discord, tunnel port `5173`:

```bash
cloudflared tunnel --url http://localhost:5173
```

Then map `/` to that tunnel hostname. This is useful for frontend-only work, but it is less production-like because API requests may still need to reach the backend through the proxy. For most end-to-end Activity testing, prefer tunneling `http://localhost:3000` after `pnpm build && pnpm start` or after `docker compose up --build`.

## 6. Configure Environment Variables

Set these in `.env` for production:

```bash
PUBLIC_BASE_URL=https://watch.example.com
PUBLIC_WS_URL=wss://watch.example.com/ws
PUBLIC_DISCORD_CLIENT_ID=your_application_id

DISCORD_CLIENT_ID=your_application_id
DISCORD_CLIENT_SECRET=your_client_secret
DISCORD_REDIRECT_URI=https://watch.example.com/api/discord/callback

APP_SESSION_SECRET=generate_32_bytes_minimum
APP_SESSION_TTL_SECONDS=28800
TOKEN_ENCRYPTION_KEY=base64_32_byte_key
DEV_AUTH_MOCK=false
JELLYFIN_DEFAULT_SERVER_URL=https://jellyfin.example.com
JELLYFIN_ALLOW_CUSTOM_SERVERS=false
JELLYFIN_AUTH_MODE=per-user
JELLYFIN_SHARED_USERNAME=
JELLYFIN_SHARED_PASSWORD=
ALLOWED_ORIGINS=https://watch.example.com
ROOM_MAX_PARTICIPANTS=20
ROOM_IDLE_TTL_SECONDS=900
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW=1 minute
NODE_ENV=production
PORT=3000
```

For local Vite development outside Discord:

```bash
VITE_API_BASE_URL=http://localhost:3000
VITE_PUBLIC_DISCORD_CLIENT_ID=your_application_id
VITE_DEV_DISCORD_MOCK=true
```

For local tunnel testing through Discord, update the public URLs to the tunnel:

```bash
PUBLIC_BASE_URL=https://example-tunnel.trycloudflare.com
PUBLIC_WS_URL=wss://example-tunnel.trycloudflare.com/ws
DISCORD_REDIRECT_URI=https://example-tunnel.trycloudflare.com/api/discord/callback
ALLOWED_ORIGINS=https://example-tunnel.trycloudflare.com
```

If you run the Vite frontend through Discord directly, use `VITE_` variables because those are read by the frontend build/dev server. If you run the built app from the backend container, use the non-`VITE_` backend variables shown in `.env.example`.

`DEV_AUTH_MOCK` must be `false` for any public deployment. Set it to `true` only for local frontend development or the documented pre-production smoke test, then set it back to `false` and recreate the container.

For Jellyfin, choose one mode:

- `JELLYFIN_AUTH_MODE=per-user`: each Discord user links their own Jellyfin account in the Activity.
- `JELLYFIN_AUTH_MODE=shared`: every Discord user uses the configured shared Jellyfin account. Set `JELLYFIN_SHARED_USERNAME` and `JELLYFIN_SHARED_PASSWORD`, and use a dedicated limited Jellyfin user such as `discord-watch`.

## 7. Enable Developer Mode In Discord

1. Open Discord.
2. Go to `User Settings`.
3. Open `Advanced`.
4. Enable `Developer Mode`.

Developer Mode makes it easier to copy IDs and access developer Activity launch surfaces.

## 8. Install Or Authorize The App In A Test Server

For private development, use your own test server first.

There are two different permission layers involved:

1. The Discord app installation scopes and optional bot permissions used when adding the app to a server.
2. The Discord server/channel permissions granted to the real Discord users who will launch and watch the Activity.

Do not mix those up. This project is currently an Embedded App / Activity plus backend service. It does not run a Discord gateway bot, does not send chat messages, does not create channels, does not move members, and does not moderate the server.

### Required App Installation Context

Configure the app so it can be installed into a server:

1. In the Developer Portal, open your application.
2. Go to `Installation`.
3. Under `Installation Contexts`, enable:

   ```text
   Guild Install
   ```

4. `User Install` is optional for this deployment. You may enable it if you also want users to install the app to their own account, but the server watch-party flow needs `Guild Install`.
5. Save changes.

The person installing the app into a server must have Discord's server management permission:

```text
Manage Server / MANAGE_GUILD
```

That permission is required for the installer only. Normal watchers do not need `Manage Server`.

### Required OAuth2 Install Scopes

For this project, use this minimum server install scope:

```text
applications.commands
```

Why:

- Discord uses `applications.commands` as the normal app installation scope for commands and app surfaces.
- The current app does not need a Discord bot user to function.
- The current app performs user authentication inside the Activity with the Embedded App SDK using these runtime user OAuth scopes:

  ```text
  identify
  guilds
  ```

- Do not add `identify` or `guilds` to the server install URL. Those are requested from each user inside the Activity when they click `Authenticate`.

### Bot Scope And Bot Permissions

Recommended setting:

```text
bot scope: not selected
bot permissions: 0
```

This app does not need any bot permissions for the current Activity flow.

Do not grant these to the app unless you later add real bot features that need them:

```text
Administrator
Manage Channels
Manage Roles
Manage Webhooks
Send Messages
Read Message History
Connect
Speak
Move Members
Mute Members
Deafen Members
Create Instant Invite
```

Those are not required for Jellyfin browsing, playback preparation, media proxying, or room sync.

If the Developer Portal forces you to include the `bot` scope for your chosen install-link style, set bot permissions to:

```text
0
```

That installs the bot user with no server powers. The Activity should still function because the browser Activity talks to this backend and to Discord through the Embedded App SDK, not through a bot token.

### Recommended Default Install Settings

In `Installation -> Default Install Settings`, use:

```text
Guild Install scopes:
applications.commands

Guild Install bot permissions:
0
```

If the portal shows separate user-install defaults, use:

```text
User Install scopes:
applications.commands
```

User-install settings are optional for the server deployment, but keeping them minimal avoids accidental extra access.

### Recommended Install Link

The simplest Discord-provided install link uses your application ID and the default install settings configured above:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID
```

For this deployment, with the current `.env` application ID, that shape is:

```text
https://discord.com/oauth2/authorize?client_id=1524768889580556289
```

If you want an explicit custom guild-install URL instead of relying on default install settings, use:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=applications.commands&integration_type=0
```

For the current application ID:

```text
https://discord.com/oauth2/authorize?client_id=1524768889580556289&scope=applications.commands&integration_type=0
```

Only use a bot-inclusive URL if the portal requires it for your install flow:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=applications.commands%20bot&permissions=0&integration_type=0
```

Do not replace `permissions=0` with `8` or with an Administrator permission value.

### Install The App Into The Server

1. Confirm the app has `Guild Install` enabled.
2. Confirm the default guild install scope is `applications.commands`.
3. Confirm bot permissions are `0` or the bot scope is not selected.
4. Open the install URL in a browser while logged into Discord.
5. Choose the target server.
6. Approve the installation.
7. In Discord, go to `Server Settings -> Integrations`.
8. Confirm the app appears in the integration/app list.

If the server does not appear in the install dropdown, the logged-in Discord user probably does not have `Manage Server` for that server, or the application does not have `Guild Install` enabled.

### Required Server And Channel Permissions For Watchers

Every Discord user who should launch or join the Activity in a voice channel needs these permissions in that voice channel:

```text
View Channel
Connect
Use Activities
```

Discord API names:

```text
VIEW_CHANNEL
CONNECT
USE_EMBEDDED_ACTIVITIES
```

Discord API values:

```text
VIEW_CHANNEL             0x0000000000000400  (1 << 10)
CONNECT                  0x0000000000100000  (1 << 20)
USE_EMBEDDED_ACTIVITIES  0x0000008000000000  (1 << 39)
```

Recommended for future slash-command launching:

```text
Use Application Commands
```

Discord API name:

```text
USE_APPLICATION_COMMANDS
```

Discord API value:

```text
USE_APPLICATION_COMMANDS 0x0000000080000000  (1 << 31)
```

`Use Application Commands` is not used by the current manual Activity launcher flow, but grant it now if you plan to add `/watch` or any command-based launch path later.

You can grant these permissions at the server role level or on the specific voice channel/category. If the voice channel has permission overrides, check the channel/category override too; a channel-level deny can block a permission that the role appears to have at the server level.

### Recommended Watcher Role

Create a role such as:

```text
Jellyfin Watch
```

Grant it these permissions on the intended voice channel or category:

```text
View Channel: Allow
Connect: Allow
Use Activities: Allow
Use Application Commands: Allow
```

Do not grant `Administrator` to this role.

If the server is private and the voice channel is hidden from `@everyone`, make sure the watch role has `View Channel` explicitly allowed on that category or channel.

### Permissions Not Required For Watchers

The Activity does not require watchers to have:

```text
Speak
Stream
Send Messages
Read Message History
Attach Files
Embed Links
Create Instant Invite
Manage Channels
Manage Server
Administrator
```

Users may need `Speak` for normal voice chat with each other, but the Jellyfin Activity itself does not depend on microphone access.

## 9. Launch The Activity In Discord

1. Start the app.

   Container:

   ```bash
   docker compose up --build
   ```

   Local production build:

   ```bash
   pnpm install
   pnpm build
   pnpm start
   ```

   Local dev frontend/backend:

   ```bash
   pnpm dev
   ```

2. If testing through Discord locally, start your tunnel and update the URL mapping to the tunnel hostname.
3. Open Discord desktop or Discord web.
4. Join a voice channel in your test server.
5. Open the Activities launcher or developer Activity shelf.
6. Choose the app, for example `Jellyfin Watch Party`.
7. Confirm the Activity iframe loads.
8. Click `Authenticate`.
9. Accept the Discord authorization prompt if Discord shows one.
10. Confirm the UI shows the Activity `instanceId`, your Discord display name, and participant count.
11. In per-user mode, link your Jellyfin account from the Jellyfin account panel. In shared mode, confirm the panel shows the shared Jellyfin account and no password fields.
12. Confirm the panel shows linked/shared status and at least one Jellyfin library if the active Jellyfin account has library access.
13. Claim host, select a Jellyfin item, and click `Prepare playback`.
14. Confirm the video element loads from a `/media/...` URL, not directly from Jellyfin.
15. Confirm a participant in the same Activity instance sees the selected title.
16. Confirm host play, pause, and seek events affect the participant player.

## 10. Add A Slash Command Later

After the Activity can launch and authenticate reliably, add an entry command such as:

```text
/watch
```

That command should launch or invite users into the Activity. This remains later-phase work because the launch behavior should be tested with the real Discord auth and room implementation first.

## 11. Production Checklist

Before using a production Discord app configuration:

- `PUBLIC_BASE_URL` is a public HTTPS URL.
- `PUBLIC_WS_URL` uses `wss://`.
- `DISCORD_CLIENT_ID` matches the Developer Portal application ID.
- `PUBLIC_DISCORD_CLIENT_ID` matches the same application ID.
- `DISCORD_CLIENT_SECRET` is set only on the backend/container.
- `DISCORD_REDIRECT_URI` exactly matches a redirect URI in the Developer Portal.
- Activity URL mapping `/` points to the production hostname without `https://`.
- The Discord app has `Guild Install` enabled.
- The Discord app default guild install scope includes `applications.commands`.
- The Discord app does not request unnecessary bot permissions; use bot permissions `0` if the bot scope is included.
- The target voice channel grants watchers `View Channel`, `Connect`, and `Use Activities`.
- The app container is reachable through your reverse proxy.
- `GET https://watch.example.com/health` returns `{ "ok": true }`.
- Caddy/Nginx/Nginx Proxy Manager forwards WebSocket upgrades to the app container.
- Jellyfin is reachable from the backend container before testing media playback.
- `JELLYFIN_AUTH_MODE` is set intentionally to either `per-user` or `shared`.
- If shared mode is enabled, the shared Jellyfin user is dedicated to this Activity, is not an admin, and has access only to intended libraries.
- The Discord app is tested in a private server before broader use.

## 12. Common Problems

### The Activity Does Not Load

Check:

- The URL mapping target does not include `https://`.
- The mapped hostname is public and reachable by Discord.
- Your local tunnel is still running.
- The tunnel hostname has not changed.
- The app returns HTML at `/`.
- The reverse proxy forwards to port `3000`.
- The Discord app has been installed into the server with the `applications.commands` scope.
- The watcher has `View Channel`, `Connect`, and `Use Activities` in the voice channel.

Run:

```bash
curl -i https://watch.example.com/
curl -i https://watch.example.com/health
```

### API Calls Fail Inside Discord But Work In A Browser

This usually means the Activity iframe is behind Discord's proxy and the request URL is not mapped.

Use same-origin relative URLs when possible:

```text
/api/health
/ws
/media/...
```

Avoid browser calls directly to:

```text
https://jellyfin.example.com
http://10.x.x.x:8096
```

Jellyfin calls should go through the backend.

### WebSocket Fails

Check:

- `PUBLIC_WS_URL` uses `wss://` in production.
- The reverse proxy supports WebSocket upgrade.
- The Discord URL mapping includes `/` or an explicit `/ws` prefix.
- The app container is listening on port `3000`.

### OAuth Redirect Fails

Check:

- The redirect URI in `.env` exactly matches the Developer Portal redirect URI.
- You are not mixing a production redirect with a local tunnel hostname.
- The backend route exists and the app has been restarted after deploying the current build.

### The Wrong App Opens

Check:

- The `PUBLIC_DISCORD_CLIENT_ID` and `DISCORD_CLIENT_ID` values match the application you configured.
- Your Vite dev server was restarted after changing `VITE_PUBLIC_DISCORD_CLIENT_ID`.
- Your container was rebuilt or restarted after changing `.env`.

### Users Cannot See Or Launch The Activity In A Server

Check:

- The app is installed into the server under `Server Settings -> Integrations`.
- The install used `Guild Install`, not only `User Install`.
- The install used the `applications.commands` scope.
- If the `bot` scope was included, bot permissions are `0`; the app does not need `Administrator`.
- The user trying to install the app has `Manage Server`.
- The user trying to launch the Activity has `View Channel`, `Connect`, and `Use Activities` in that voice channel.
- If launching through slash commands later, the user also has `Use Application Commands`.
- Channel/category permission overrides do not deny one of those permissions.

## 13. Official References

- Discord Activities overview: https://docs.discord.com/developers/activities/overview
- How Activities work: https://docs.discord.com/developers/activities/how-activities-work
- Local development and URL mappings: https://docs.discord.com/developers/activities/development-guides/local-development
- Networking guide: https://docs.discord.com/developers/activities/development-guides/networking
- Multiplayer and `instanceId`: https://docs.discord.com/developers/activities/development-guides/multiplayer-experience
- Embedded App SDK reference: https://docs.discord.com/developers/developer-tools/embedded-app-sdk
