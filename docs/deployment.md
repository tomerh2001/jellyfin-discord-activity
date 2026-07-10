# Deployment

This app is designed to run as one backend container that serves the built Discord Activity frontend, REST API, WebSocket endpoint, and media proxy from a single origin.

## Production Topology

Recommended production shape:

```text
Discord client
  -> Discord Activity iframe/proxy
    -> https://djf.techdaddydigital.com
      -> Nginx Proxy Manager
        -> http://10.1.0.82:3000
          -> jellyfin-discord-activity container
            -> Jellyfin over LAN or private Docker network
```

The browser should never call Jellyfin directly. The browser calls `/api`, `/ws`, and `/media` on the Activity domain. The backend calls Jellyfin server-side.

## Host Requirements

Install on the machine that will run the app:

- Docker Engine.
- Docker Compose v2.
- Git.
- Node.js 22 and pnpm if you want to run host-side checks such as `pnpm smoke`.

The app listens on container port `3000`. The default `docker-compose.yml` publishes host port `3000`.

## Fresh Clone Deployment

1. Clone the repository and enter it:

   ```bash
   git clone <repo-url>
   cd DiscordJellyfin
   ```

2. Create `.env`:

   ```bash
   cp .env.example .env
   ```

3. Generate secrets:

   ```bash
   openssl rand -base64 32
   openssl rand -base64 32
   ```

4. Edit `.env`.

   Minimum values for your Nginx Proxy Manager setup:

   ```bash
   PUBLIC_BASE_URL=https://djf.techdaddydigital.com
   PUBLIC_WS_URL=wss://djf.techdaddydigital.com/ws
   PUBLIC_DISCORD_CLIENT_ID=your_application_id

   DISCORD_CLIENT_ID=your_application_id
   DISCORD_CLIENT_SECRET=your_client_secret
   DISCORD_REDIRECT_URI=https://djf.techdaddydigital.com/api/discord/callback

   APP_SESSION_SECRET=generated_32_byte_value
   APP_SESSION_TTL_SECONDS=28800
   TOKEN_ENCRYPTION_KEY=generated_base64_32_byte_value
   DEV_AUTH_MOCK=false

   DATABASE_URL=file:/data/app.db
   JELLYFIN_DEFAULT_SERVER_URL=http://your-jellyfin-lan-ip:8096
   JELLYFIN_ALLOW_CUSTOM_SERVERS=false
   JELLYFIN_AUTH_MODE=per-user
   JELLYFIN_SHARED_USERNAME=
   JELLYFIN_SHARED_PASSWORD=

   ALLOWED_ORIGINS=https://djf.techdaddydigital.com
   TRUST_PROXY=true
   NODE_ENV=production
   LOG_LEVEL=info
   PORT=3000
   ```

   Leave `JELLYFIN_AUTH_MODE=per-user` if each Discord user should link their own Jellyfin account. Change to shared mode only if one dedicated Jellyfin account should be used for all Discord watchers:

   ```bash
   JELLYFIN_AUTH_MODE=shared
   JELLYFIN_SHARED_USERNAME=discord-watch
   JELLYFIN_SHARED_PASSWORD=replace_with_that_users_password
   ```

   For shared mode, create the `discord-watch` user in Jellyfin first and grant it access only to libraries intended for the Discord Activity. Do not use a Jellyfin admin account.

5. Start the app:

   ```bash
   docker compose up --build -d
   ```

6. Confirm the container is running:

   ```bash
   docker compose ps
   docker compose logs --tail 100 app
   ```

7. Confirm local health:

   ```bash
   curl http://localhost:3000/health
   ```

8. Confirm public health:

   ```bash
   curl https://djf.techdaddydigital.com/health
   ```

## Nginx Proxy Manager

Create or edit a Proxy Host:

```text
Domain Names: djf.techdaddydigital.com
Scheme: http
Forward Hostname / IP: 10.1.0.82
Forward Port: 3000
Cache Assets: optional
Block Common Exploits: enabled
Websockets Support: enabled
Access List: public, unless you know Discord can still reach it
SSL Certificate: valid certificate for djf.techdaddydigital.com
Force SSL: enabled
HTTP/2 Support: enabled
```

Do not create separate Nginx locations that strip or rewrite `/api`, `/ws`, `/media`, or `/assets`. The app expects to receive those paths unchanged.

Because `/ws` carries a short-lived app session token in a query parameter, avoid storing query strings in reverse proxy access logs when possible.

## Discord Portal Deployment Values

OAuth2 redirect:

```text
https://djf.techdaddydigital.com/api/discord/callback
```

Activity URL mapping:

```text
PREFIX      TARGET
/           djf.techdaddydigital.com
```

The mapping target is only the hostname. Do not include `https://`.

Optional explicit mappings:

```text
PREFIX      TARGET
/api        djf.techdaddydigital.com
/ws         djf.techdaddydigital.com
/media      djf.techdaddydigital.com
/assets     djf.techdaddydigital.com
```

## Jellyfin Reachability

The app container must reach Jellyfin. If Jellyfin is on your LAN, use the LAN URL in `.env`, for example:

```bash
JELLYFIN_DEFAULT_SERVER_URL=http://10.1.0.50:8096
```

Test from inside the container:

```bash
docker compose exec app wget -qO- "$JELLYFIN_DEFAULT_SERVER_URL/System/Info/Public"
```

If that fails, fix routing, firewall, Docker networking, or the Jellyfin URL before testing Discord playback.

## Jellyfin Auth Mode

Per-user mode:

```bash
JELLYFIN_AUTH_MODE=per-user
JELLYFIN_SHARED_USERNAME=
JELLYFIN_SHARED_PASSWORD=
```

This is the default. After Discord authentication, each user links their own Jellyfin account in the Activity. Library browsing, item lookup, and playback preparation use that user's saved encrypted Jellyfin access token.

Shared mode:

```bash
JELLYFIN_AUTH_MODE=shared
JELLYFIN_SHARED_USERNAME=discord-watch
JELLYFIN_SHARED_PASSWORD=replace_with_that_users_password
```

In shared mode, Discord authentication is still required, but the Activity hides the Jellyfin link form. The backend authenticates as the shared Jellyfin user, stores the returned access token encrypted under `/data`, and uses that account for all authenticated Discord users. Shared mode always uses `JELLYFIN_DEFAULT_SERVER_URL`; custom Jellyfin server URLs are ignored.

Restart the container after changing auth mode or shared account credentials:

```bash
docker compose up -d --force-recreate
```

## Persistent Data

The compose file mounts:

```yaml
./data:/data
```

Linked Jellyfin tokens are stored under `/data` and encrypted with `TOKEN_ENCRYPTION_KEY`. In per-user mode, those records belong to individual Discord users. In shared mode, one reserved internal shared account record is stored in the same file. If you change `TOKEN_ENCRYPTION_KEY` after accounts have been stored, existing encrypted tokens will no longer decrypt. Per-user users will need to relink Jellyfin; shared mode will need to reauthenticate with the configured shared username and password.

Room state, participants, and stream tickets are in memory. They are intentionally cleared on restart.

## Production Smoke Test

The smoke script needs a valid app token to test `/ws`. For local pre-production testing, use dev mock auth:

1. Temporarily set:

   ```bash
   DEV_AUTH_MOCK=true
   ```

2. Recreate the app:

   ```bash
   docker compose up --build -d
   ```

3. Run:

   ```bash
   pnpm smoke
   ```

4. For the public URL:

   ```bash
   SMOKE_BASE_URL=https://djf.techdaddydigital.com \
   SMOKE_WS_URL=wss://djf.techdaddydigital.com/ws \
   pnpm smoke
   ```

5. Set mock auth back to:

   ```bash
   DEV_AUTH_MOCK=false
   ```

6. Recreate the app:

   ```bash
   docker compose up -d --force-recreate
   ```

Never leave `DEV_AUTH_MOCK=true` on a public deployment.

## Runtime Tuning

Recommended defaults:

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

Lower `STREAM_MAX_BITRATE` if Jellyfin transcoding or upload bandwidth is struggling. Lower `ROOM_MAX_PARTICIPANTS` if your Jellyfin host cannot handle many simultaneous transcodes.

## Updating

From the repo directory:

```bash
git pull
docker compose up --build -d
docker compose logs --tail 100 app
curl http://localhost:3000/health
```

If dependencies or environment variables changed, compare your `.env` with `.env.example`.
