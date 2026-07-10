# Jellyfin Discord Activity

A self-hosted Discord Embedded App / Activity for Jellyfin watch parties.

This repository currently implements Phase 7 from [plan.md](plan.md): a TypeScript pnpm monorepo, Fastify backend, Vite React Activity frontend, Discord Embedded App SDK boot/auth, short-lived app sessions, encrypted Jellyfin token storage, per-user or shared Jellyfin auth modes, Jellyfin library browsing/search, host-only media selection, HLS/direct media proxying, authenticated WebSocket room sync, host-authoritative playback commands, drift correction, rate limits, redacted structured logs, idle room cleanup, container deployment files, detailed deployment docs, and a smoke test that validates health, auth guard behavior, and WebSocket connectivity.

## What Runs In Production

The production container serves one origin:

```text
/          Built React Discord Activity frontend
/api       REST API
/ws        Authenticated WebSocket sync endpoint
/media     Short-lived Jellyfin media proxy URLs
```

Using one public HTTPS origin is the simplest Discord Activity deployment because Discord URL mappings, CORS, WebSocket upgrades, and media playback all point to the same host.

For your network, the intended public origin is:

```text
https://djf.techdaddydigital.com
```

Nginx Proxy Manager should forward that host to:

```text
http://10.1.0.82:3000
```

## Required Infrastructure

You need:

- Docker with Docker Compose v2.
- A public HTTPS hostname that Discord can reach.
- Nginx Proxy Manager, Nginx, Caddy, or another HTTPS reverse proxy in front of the app.
- WebSocket upgrade support enabled on the reverse proxy.
- A Discord Developer Portal application with Activities enabled.
- A Jellyfin server reachable from the app container.
- A Jellyfin access model:
  - Per-user mode: one Jellyfin user account for each Discord user who will watch media.
  - Shared mode: one dedicated, limited Jellyfin account for all Discord watchers.
- Node.js 22 and pnpm only if you want to run local development commands or `pnpm smoke` from the host.

The app container does not need Jellyfin to be public if the container can reach Jellyfin over your LAN. Remote Discord users stream from this app's `/media/...` proxy, not directly from Jellyfin.

## Fresh Clone To Running Container

1. Install dependencies for local tooling:

   ```bash
   corepack enable
   pnpm install
   ```

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

3. Generate secrets:

   ```bash
   openssl rand -base64 32
   openssl rand -base64 32
   ```

   Use one value for `APP_SESSION_SECRET` and one value for `TOKEN_ENCRYPTION_KEY`.

4. Edit `.env` for your production origin:

   ```bash
   PUBLIC_BASE_URL=https://djf.techdaddydigital.com
   PUBLIC_WS_URL=wss://djf.techdaddydigital.com/ws
   ALLOWED_ORIGINS=https://djf.techdaddydigital.com
   TRUST_PROXY=true
   NODE_ENV=production
   PORT=3000
   DEV_AUTH_MOCK=false
   ```

5. Add Discord values from the Developer Portal:

   ```bash
   PUBLIC_DISCORD_CLIENT_ID=your_application_id
   DISCORD_CLIENT_ID=your_application_id
   DISCORD_CLIENT_SECRET=your_client_secret
   DISCORD_REDIRECT_URI=https://djf.techdaddydigital.com/api/discord/callback
   ```

6. Choose a Jellyfin authentication mode and add Jellyfin values.

   Per-user mode is the default and most restrictive option:

   ```bash
   JELLYFIN_DEFAULT_SERVER_URL=http://your-jellyfin-lan-ip:8096
   JELLYFIN_ALLOW_CUSTOM_SERVERS=false
   JELLYFIN_AUTH_MODE=per-user
   STREAM_PROXY_MODE=hls-first
   STREAM_MAX_BITRATE=20000000
   STREAM_MAX_WIDTH=1920
   STREAM_MAX_HEIGHT=1080
   ```

   In per-user mode, every Discord user links their own Jellyfin account in the Activity. Jellyfin permissions are evaluated per viewer.

   Shared mode uses one Jellyfin account for every authenticated Discord user:

   ```bash
   JELLYFIN_DEFAULT_SERVER_URL=http://your-jellyfin-lan-ip:8096
   JELLYFIN_ALLOW_CUSTOM_SERVERS=false
   JELLYFIN_AUTH_MODE=shared
   JELLYFIN_SHARED_USERNAME=discord-watch
   JELLYFIN_SHARED_PASSWORD=replace_with_that_users_password
   STREAM_PROXY_MODE=hls-first
   STREAM_MAX_BITRATE=20000000
   STREAM_MAX_WIDTH=1920
   STREAM_MAX_HEIGHT=1080
   ```

   For shared mode, create a dedicated Jellyfin user such as `discord-watch` and grant it access only to libraries intended for Discord viewing. Do not use a Jellyfin admin account.

7. Start the container:

   ```bash
   docker compose up --build -d
   ```

8. Verify local health:

   ```bash
   curl http://localhost:3000/health
   ```

   Expected:

   ```json
   { "ok": true }
   ```

9. Verify public health through Nginx Proxy Manager:

   ```bash
   curl https://djf.techdaddydigital.com/health
   ```

10. Check logs (host-mapped files or Docker):

    ```bash
    # Preferred: files on the host under ./logs
    tail -f logs/app/app.log
    # or
    ./scripts/tail-logs.sh app

    # Docker stdout (still available)
    docker compose logs -f app
    ```

## Environment Variables

Required public app values:

```bash
PUBLIC_BASE_URL=https://djf.techdaddydigital.com
PUBLIC_WS_URL=wss://djf.techdaddydigital.com/ws
PUBLIC_DISCORD_CLIENT_ID=your_application_id
ALLOWED_ORIGINS=https://djf.techdaddydigital.com
```

Required Discord OAuth values:

```bash
DISCORD_CLIENT_ID=your_application_id
DISCORD_CLIENT_SECRET=your_client_secret
DISCORD_REDIRECT_URI=https://djf.techdaddydigital.com/api/discord/callback
```

Required security values:

```bash
APP_SESSION_SECRET=base64_or_random_32_bytes_minimum
APP_SESSION_TTL_SECONDS=28800
TOKEN_ENCRYPTION_KEY=base64_32_byte_key
DEV_AUTH_MOCK=false
```

`DEV_AUTH_MOCK` must be `false` for production. Set it to `true` only for local smoke tests or local frontend development.

Required Jellyfin values:

```bash
JELLYFIN_DEFAULT_SERVER_URL=http://10.x.x.x:8096
JELLYFIN_ALLOW_CUSTOM_SERVERS=false
JELLYFIN_AUTH_MODE=per-user
JELLYFIN_SHARED_USERNAME=
JELLYFIN_SHARED_PASSWORD=
DATABASE_URL=file:/data/app.db
```

`JELLYFIN_AUTH_MODE=per-user` keeps the original behavior. Users authenticate with Discord, then link their own Jellyfin account from the Activity. Link status, library browsing, item details, and playback preparation use that user's saved encrypted Jellyfin token.

`JELLYFIN_AUTH_MODE=shared` keeps Discord authentication but removes per-user Jellyfin linking. The backend authenticates once as `JELLYFIN_SHARED_USERNAME`, stores the returned Jellyfin access token encrypted in `/data/jellyfin-accounts.json`, and uses that Jellyfin account for all authenticated Discord users. If Jellyfin rejects the shared token, the backend reauthenticates once with `JELLYFIN_SHARED_PASSWORD` and retries the operation. Shared mode always uses `JELLYFIN_DEFAULT_SERVER_URL`; custom user-supplied Jellyfin server URLs are ignored.

Playback and room tuning:

```bash
STREAM_TICKET_TTL_SECONDS=14400
STREAM_MAX_BITRATE=20000000
STREAM_MAX_WIDTH=1920
STREAM_MAX_HEIGHT=1080
STREAM_PROXY_MODE=hls-first
ROOM_MAX_PARTICIPANTS=20
ROOM_IDLE_TTL_SECONDS=900
SYNC_STATE_UPDATE_MS=1000
SYNC_HARD_SEEK_THRESHOLD_SECONDS=2.0
SYNC_SOFT_DRIFT_THRESHOLD_SECONDS=0.08
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW=1 minute
```

Container/runtime values:

```bash
HOST=0.0.0.0
PORT=3000
TRUST_PROXY=true
LOG_LEVEL=info
# Docker sets LOG_DIR=/logs → host ./logs/app/{app,error}.log
NODE_ENV=production
```

## Discord Developer Portal Requirements

In the Discord Developer Portal:

1. Create an application.
2. Copy the Application ID into both `PUBLIC_DISCORD_CLIENT_ID` and `DISCORD_CLIENT_ID`.
3. Create or reset the OAuth2 client secret and put it in `DISCORD_CLIENT_SECRET`.
4. Add this OAuth2 redirect URI:

   ```text
   https://djf.techdaddydigital.com/api/discord/callback
   ```

5. Enable Activities or Embedded App support.
6. Configure Activity URL mappings.

Recommended mapping:

```text
PREFIX      TARGET
/           djf.techdaddydigital.com
```

The target must not include `https://`.

If Discord debugging is easier with explicit routes, add:

```text
PREFIX      TARGET
/api        djf.techdaddydigital.com
/ws         djf.techdaddydigital.com
/media      djf.techdaddydigital.com
/assets     djf.techdaddydigital.com
```

All mappings point to the same app host.

## Nginx Proxy Manager Requirements

Create a Proxy Host:

```text
Domain Names: djf.techdaddydigital.com
Scheme: http
Forward Hostname / IP: 10.1.0.82
Forward Port: 3000
Websockets Support: enabled
Block Common Exploits: enabled
SSL Certificate: valid certificate for djf.techdaddydigital.com
Force SSL: enabled
HTTP/2 Support: enabled
```

Do not add path-specific redirects for `/api`, `/ws`, or `/media`; they should all pass through to the app. Avoid logging query strings if possible because `/ws` uses a short-lived `token` query parameter.

## Jellyfin Requirements

The app container must be able to reach:

```text
JELLYFIN_DEFAULT_SERVER_URL/System/Info/Public
```

Test from inside the running container:

```bash
docker compose exec app wget -qO- "$JELLYFIN_DEFAULT_SERVER_URL/System/Info/Public"
```

In per-user mode, each viewer links their own Jellyfin account. Jellyfin permissions apply per viewer: if a user cannot play an item in Jellyfin, the Activity should not be able to play it for that user.

In shared mode, each viewer still authenticates with Discord, but Jellyfin permissions come from the shared Jellyfin account. Every Discord user who can enter the Activity can browse and prepare media visible to the shared Jellyfin user, so keep that account limited to the intended libraries.

## Smoke Tests

The smoke test validates:

- `GET /health` returns `{ "ok": true }`.
- `GET /api/me` without a bearer token returns `401`.
- A dev mock auth exchange can create an app token when `DEV_AUTH_MOCK=true`.
- `/ws` accepts that token and responds to `ping` with `pong`.

For local or pre-production smoke testing, temporarily set:

```bash
DEV_AUTH_MOCK=true
```

Then recreate the container and run:

```bash
docker compose up --build -d
pnpm smoke
```

For a non-local URL:

```bash
SMOKE_BASE_URL=https://djf.techdaddydigital.com \
SMOKE_WS_URL=wss://djf.techdaddydigital.com/ws \
pnpm smoke
```

After the smoke test passes, set:

```bash
DEV_AUTH_MOCK=false
```

Then recreate the container:

```bash
docker compose up -d --force-recreate
```

Do not leave `DEV_AUTH_MOCK=true` on a public deployment.

## End-To-End Discord Test

1. Start the container with `DEV_AUTH_MOCK=false`.
2. Confirm `https://djf.techdaddydigital.com/health` returns `{ "ok": true }`.
3. Open Discord desktop or Discord web.
4. Join a voice channel in your test server.
5. Launch the Activity.
6. Authenticate with Discord.
7. In per-user mode, link your Jellyfin account. In shared mode, confirm the Jellyfin panel shows the shared account.
8. Claim host.
9. Browse a library or search for a movie/episode.
10. Select media.
11. Prepare playback.
12. Confirm the browser loads media from `/media/...`, not directly from Jellyfin.
13. Have a second Discord user join the same Activity.
14. In per-user mode, have the second user link their Jellyfin account before preparing playback. In shared mode, no Jellyfin link form should appear.
15. Confirm the participant sees the selected title.
16. Confirm host play, pause, and seek actions affect the participant.

## Useful Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
docker compose up --build -d
docker compose logs -f app
docker compose down
```
