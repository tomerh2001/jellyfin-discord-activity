# Jellyfin Discord Activity

Self-hosted [Discord Activity](https://discord.com/developers/docs/activities/overview) for **Jellyfin watch parties**.

Launch it from a voice channel, browse your Jellyfin library, and watch movies/episodes in sync—similar in spirit to Discord’s YouTube co-watch activity, but backed by your own media server.

## Features

- Discord Embedded App SDK boot + OAuth (short-lived app sessions)
- Per-user Jellyfin account linking **or** one shared Jellyfin account for trusted homes
- Library browse/search, artwork proxy, host media selection
- Playback via backend media proxy (browser never sees Jellyfin tokens)
  - Remux / **fMP4 HLS** when the client supports it (Windows Discord, web)
  - **Linux Discord** falls back to progressive **VP8/Opus WebM** (H.264 is rejected by that client)
- Host-authoritative WebSocket sync (play / pause / seek / drift correction)
- Docker Compose deployment, host-mapped logs, smoke tests

## Architecture

One public HTTPS origin serves everything Discord needs:

```text
/          Built React Activity UI
/api       REST API
/ws        Authenticated WebSocket sync
/media     Short-lived Jellyfin stream proxy
```

```text
Discord voice channel
  └─ Activity iframe (your HTTPS host)
       ├─ React frontend + hls.js
       └─ Fastify backend
            ├─ Discord OAuth exchange
            ├─ Jellyfin API (server-side)
            ├─ Stream tickets + HLS/WebM/MP4 proxy
            └─ Room sync over WebSocket
```

Jellyfin does **not** need to be public. Only this app must be reachable by Discord over HTTPS; the container talks to Jellyfin on your LAN.

## Requirements

| Component | Notes |
|-----------|--------|
| Docker + Compose v2 | Recommended production path |
| Public HTTPS hostname | Discord Activities require HTTPS |
| Reverse proxy | Nginx Proxy Manager, Caddy, Nginx, Traefik, etc. with **WebSocket** support |
| Discord application | Activities enabled + URL mappings |
| Jellyfin | Reachable from the **app container** (not necessarily from the internet) |
| Node 22 + pnpm | Only for local dev / running tests on the host |

## Quick start (Docker)

### 1. Clone and configure

```bash
git clone https://github.com/camarokris/jellyfin-discord-activity.git
cd jellyfin-discord-activity
cp .env.example .env
```

Generate secrets:

```bash
openssl rand -base64 32   # APP_SESSION_SECRET
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY
```

### 2. Edit `.env` (minimum)

Replace `watch.example.com` with your public hostname:

```bash
PUBLIC_BASE_URL=https://watch.example.com
PUBLIC_WS_URL=wss://watch.example.com/ws
ALLOWED_ORIGINS=https://watch.example.com
DISCORD_REDIRECT_URI=https://watch.example.com/api/discord/callback

PUBLIC_DISCORD_CLIENT_ID=your_discord_application_id
DISCORD_CLIENT_ID=your_discord_application_id
DISCORD_CLIENT_SECRET=your_discord_client_secret

APP_SESSION_SECRET=paste_generated_secret
TOKEN_ENCRYPTION_KEY=paste_generated_base64_key

JELLYFIN_DEFAULT_SERVER_URL=http://192.168.1.10:8096
JELLYFIN_AUTH_MODE=per-user   # or shared

TRUST_PROXY=true
DEV_AUTH_MOCK=false
NODE_ENV=production
PORT=3000
```

**Shared mode** (one Jellyfin user for everyone):

```bash
JELLYFIN_AUTH_MODE=shared
JELLYFIN_SHARED_USERNAME=discord-watch
JELLYFIN_SHARED_PASSWORD=strong_password
```

Use a dedicated, non-admin Jellyfin user limited to the libraries you want in Discord.

### 3. Discord Developer Portal

Follow **[docs/discord-setup.md](docs/discord-setup.md)** in full. Short version:

1. Create an application → copy Application ID and Client Secret into `.env`.
2. Enable **Activities**.
3. OAuth2 redirect: `https://watch.example.com/api/discord/callback`
4. Activity **URL Mapping** (target **without** `https://`):

   | PREFIX | TARGET |
   |--------|--------|
   | `/` | `watch.example.com` |

   Optional explicit prefixes: `/api`, `/ws`, `/media`, `/assets` → same host.

5. Install the app to your test server if required by your Discord client.

### 4. Reverse proxy

Point `https://watch.example.com` → `http://<docker-host>:3000` with:

- Valid TLS certificate  
- **WebSockets enabled**  
- No path stripping for `/api`, `/ws`, `/media`, `/assets`  
- Prefer not logging full query strings (`/ws?token=...`)

See **[docs/deployment.md](docs/deployment.md)** for Nginx Proxy Manager and Caddy examples.

### 5. Start

```bash
docker compose up --build -d
curl -sS http://localhost:3000/health
# expect: {"ok":true}
curl -sS https://watch.example.com/health
```

Logs on the host:

```bash
./scripts/tail-logs.sh app
# or
tail -f logs/app/app.log
```

### 6. Test in Discord

1. Join a voice channel → launch the Activity.  
2. Authenticate with Discord.  
3. Link Jellyfin (per-user) or confirm shared mode.  
4. Claim host → browse → prepare playback.  
5. Second user joins; confirm sync (play/pause/seek).  
6. Confirm media URLs are `/media/...` on your domain, not raw Jellyfin URLs.

## Client notes

| Client | Playback path |
|--------|----------------|
| Windows Discord / Discord Web | Remux when possible, else fMP4 HLS (H.264/AAC) |
| **Linux Discord** | Progressive **VP8/Opus WebM** (~480p). H.264 is rejected by that Electron build. Prefer Windows/Web hosts for multi-person parties. |

Open **Show diagnostics** under the player if something fails; combine with `logs/app/app.log`.

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/deployment.md](docs/deployment.md) | Topology, env, proxy, compose, ops |
| [docs/discord-setup.md](docs/discord-setup.md) | Developer Portal, OAuth, URL mappings, checklist |
| [docs/jellyfin-setup.md](docs/jellyfin-setup.md) | Auth modes, linking, playback, images |
| [docs/api.md](docs/api.md) | HTTP/WebSocket API reference |
| [docs/security.md](docs/security.md) | Secrets, tokens, logging redaction |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Health, proxy, WS, playback, Linux |
| [logs/README.md](logs/README.md) | Host log layout |
| [plan.md](plan.md) | Original design notes (historical) |

## Development

```bash
corepack enable
pnpm install
cp .env.example .env
# set DEV_AUTH_MOCK=true and VITE_DEV_DISCORD_MOCK as needed
pnpm dev
```

- API: `http://localhost:3000`  
- Vite UI: `http://localhost:5173` (proxies `/api`, `/media`, `/ws`)

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke          # needs running app; use DEV_AUTH_MOCK=true carefully
```

Dev compose: `docker compose -f docker-compose.dev.yml up`.

## Security checklist

- Never commit `.env`, `data/`, or `logs/**/*.log`
- `DEV_AUTH_MOCK=false` in production
- Generate unique `APP_SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`
- Do not put `DISCORD_CLIENT_SECRET` or Jellyfin tokens in frontend env (`VITE_*`)
- Prefer per-user Jellyfin linking; shared mode is for trusted private servers only
- Keep stream tickets and app sessions short-lived; use HTTPS/WSS

## Project layout

```text
apps/activity-web/   React + Vite Activity UI
apps/api/            Fastify API, WS, media proxy
packages/shared/     Shared Zod schemas / protocol
docs/                Operator documentation
scripts/             smoke-test, tail-logs, secrets helper
docker-compose.yml   Production app (+ optional Caddy profile)
```

## License

MIT — see [LICENSE](LICENSE).
