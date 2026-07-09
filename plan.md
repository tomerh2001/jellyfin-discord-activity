# PLAN.md — Discord Activity for Jellyfin Watch Parties

Last updated: 2026-07-06

## 1. Goal

Build a Discord Embedded App / Activity that can be launched inside Discord voice channels and lets users watch media from a Jellyfin server together, similar in spirit to Discord's YouTube co-watch Activity, but using a self-hosted Jellyfin backend.

The application should be private/self-hostable first. Public App Directory distribution is out of scope for the MVP because it adds review, abuse prevention, multi-tenant onboarding, and support burden.

## 2. Core idea

Discord Activities are web apps rendered inside a Discord iframe. The Activity frontend uses Discord's Embedded App SDK to identify the current Discord user, channel, guild, and Activity `instanceId`. The Activity backend talks to Jellyfin, manages user linking, proxies media playback, and provides a WebSocket room for synchronized playback.

OpenWatchParty should be treated as the reference implementation for watch-party sync behavior and protocol ideas. Do not assume its Jellyfin Web injected client can run unchanged inside Discord. The Discord version should be a purpose-built Activity client with OpenWatchParty-inspired room and playback synchronization.

```text
Discord voice channel
  └─ launches Activity iframe
      ├─ React/Vite Activity frontend
      │   ├─ Discord Embedded App SDK
      │   ├─ Jellyfin library browser UI
      │   ├─ HTML5 video player + hls.js
      │   └─ WebSocket sync client
      └─ Activity backend
          ├─ Discord OAuth code exchange/session verification
          ├─ Jellyfin account linking and API proxy
          ├─ media stream ticketing and HLS/MP4 proxy
          ├─ watch-party room state keyed by Discord instanceId
          └─ WebSocket sync server
```

## 3. Important platform constraints

1. Discord Activities run in a sandboxed iframe and need the Embedded App SDK for Discord client communication.
2. Network calls from an Activity are constrained by Discord's Activity proxy and URL mappings. Production should avoid direct calls to random Jellyfin URLs from the client.
3. Users in the same launched Activity receive the same Discord `instanceId`; use that as the primary room key.
4. Private LAN Jellyfin URLs such as `http://10.x.x.x:8096` are not usable for remote Discord users. The app needs either a public HTTPS Jellyfin endpoint or, preferably, a backend proxy reachable over HTTPS.
5. Never put Jellyfin admin tokens, long-lived Jellyfin user tokens, or Discord client secrets in the browser bundle.
6. Every user should normally authenticate to Jellyfin with their own Jellyfin account. Avoid using the host's Jellyfin token to stream to everyone unless this is explicitly accepted as a trusted-home-server-only shortcut.
7. Media traffic comes from the Jellyfin server/app backend, not from Discord. Bandwidth and transcoding capacity remain your responsibility.
8. Use HTTPS/WSS in production. Browsers and Discord's proxy will make insecure media/WebSocket flows painful or impossible.
9. Respect media rights. The app must not bypass Jellyfin permissions, DRM, geo restrictions, or licensing limits.

## 4. Recommended MVP scope

### MVP features

- Discord Activity frontend launches in a voice channel.
- Discord user can authenticate through Discord OAuth from inside the Activity.
- User can link one Jellyfin account.
- Host can browse/search Jellyfin libraries.
- Host can select a movie/episode.
- Participants see the selected item and join the room.
- Each participant uses their own Jellyfin-linked account to request playback access.
- Video plays inside the Activity using HLS first, direct MP4 as fallback.
- Host controls play, pause, seek, and media selection.
- Participants are kept in sync with drift correction.
- Basic participant list using Discord participant info.
- Basic error states: not linked, no access to item, transcode unavailable, server offline, room closed.
- Docker Compose deployment behind Caddy or Nginx.

### Defer until after MVP

- Public App Directory distribution.
- Multi-Jellyfin-server SaaS onboarding.
- Subtitles beyond Jellyfin's default selected subtitle stream.
- Audio/subtitle stream picker.
- Host transfer.
- Persistent watch history.
- Text chat inside the Activity. Discord voice/text already exists.
- Native Jellyfin SyncPlay integration. Use custom sync first.
- Admin dashboard.
- Mobile-polished UX.
- Multi-region scaling.

## 5. Source/reference docs

Use these as implementation references, not as copy-paste specs. Verify exact API shapes during implementation because Discord and Jellyfin move quickly.

- Discord Activities overview: https://docs.discord.com/developers/activities/overview
- Discord Activities platform page: https://docs.discord.com/developers/platform/activities
- Discord Embedded App SDK reference: https://docs.discord.com/developers/developer-tools/embedded-app-sdk
- Discord local development and URL mappings: https://docs.discord.com/developers/activities/development-guides/local-development
- Discord multiplayer/instance management: https://docs.discord.com/developers/activities/development-guides/multiplayer-experience
- Discord Embedded App SDK GitHub: https://github.com/discord/embedded-app-sdk
- OpenWatchParty repo: https://github.com/mhbxyz/OpenWatchParty
- OpenWatchParty docs: https://mhbxyz.github.io/OpenWatchParty/
- OpenWatchParty architecture: https://mhbxyz.github.io/OpenWatchParty/technical/architecture/
- OpenWatchParty WebSocket protocol: https://mhbxyz.github.io/OpenWatchParty/technical/protocol/
- OpenWatchParty deployment/security/configuration docs:
  - https://mhbxyz.github.io/OpenWatchParty/operations/deployment/
  - https://mhbxyz.github.io/OpenWatchParty/operations/configuration/
  - https://mhbxyz.github.io/OpenWatchParty/operations/security/
- Jellyfin docs: https://jellyfin.org/docs/
- Jellyfin TypeScript SDK docs: https://typescript-sdk.jellyfin.org/
- Jellyfin plugin template, only needed if a companion plugin is later added: https://github.com/jellyfin/jellyfin-plugin-template

## 6. Technical stack

Use a TypeScript-first monorepo so Codex can work in one language across frontend, backend, shared schemas, and tests.

### Runtime and tooling

- Node.js 22 LTS or newer.
- pnpm workspaces.
- TypeScript strict mode.
- Vite for frontend.
- React for UI.
- Fastify for backend HTTP API.
- `@fastify/websocket` or `ws` for WebSocket server.
- Zod for request/message validation.
- Prisma or Drizzle ORM.
- SQLite for MVP self-hosting; Postgres optional for production.
- `@discord/embedded-app-sdk` for the Activity frontend.
- `@jellyfin/sdk` or generated Jellyfin client for typed Jellyfin API calls.
- `hls.js` for HLS playback in Chromium/WebView environments.
- `video.js` optional; plain `<video>` + hls.js is better for MVP simplicity.
- Vitest for unit tests.
- Playwright for end-to-end frontend tests.
- Docker and Docker Compose for deployment.
- Caddy as the recommended reverse proxy.

### Why not start with a Jellyfin plugin?

A Jellyfin plugin is not required for the MVP because the Discord Activity can talk to Jellyfin through the backend using normal Jellyfin API calls. A companion plugin can be added later if you want Jellyfin-side configuration, server-generated short-lived tokens, deeper library integration, or a clean OpenWatchParty bridge.

## 7. Repository structure

Create this structure from the start:

```text
jellyfin-discord-activity/
  PLAN.md
  README.md
  LICENSE
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .editorconfig
  .gitignore
  .env.example
  docker-compose.yml
  docker-compose.dev.yml
  Dockerfile
  Caddyfile.example

  apps/
    activity-web/
      package.json
      index.html
      vite.config.ts
      tsconfig.json
      src/
        main.tsx
        App.tsx
        env.ts
        styles.css
        discord/
          sdk.ts
          auth.ts
          participants.ts
        api/
          client.ts
          types.ts
        jellyfin/
          LibraryBrowser.tsx
          SearchBox.tsx
          MediaCard.tsx
          LinkAccount.tsx
        player/
          WatchPlayer.tsx
          hls.ts
          controls.ts
          usePlaybackSync.ts
        room/
          RoomProvider.tsx
          ParticipantList.tsx
          HostControls.tsx
        components/
          ErrorPanel.tsx
          Loading.tsx
          Button.tsx
        test/
          setup.ts

    api/
      package.json
      tsconfig.json
      src/
        server.ts
        env.ts
        logger.ts
        plugins/
          db.ts
          cookies.ts
          auth.ts
          websocket.ts
        routes/
          health.ts
          discordAuth.ts
          jellyfinAuth.ts
          jellyfinLibrary.ts
          playback.ts
          rooms.ts
        services/
          discord.ts
          jellyfin.ts
          jellyfinPlayback.ts
          streamProxy.ts
          roomManager.ts
          syncEngine.ts
          crypto.ts
          tickets.ts
        ws/
          index.ts
          messages.ts
          handlers.ts
          roomSocket.ts
        db/
          schema.ts
          migrations/
        test/
          jellyfin.mock.ts
          roomManager.test.ts
          syncEngine.test.ts

  packages/
    shared/
      package.json
      tsconfig.json
      src/
        env.ts
        types.ts
        schemas.ts
        constants.ts
        protocol.ts
        errors.ts

  docs/
    discord-setup.md
    jellyfin-setup.md
    deployment.md
    security.md
    troubleshooting.md
    api.md

  scripts/
    dev.sh
    generate-secret.ts
    migrate.ts
    smoke-test.ts
```

## 8. Environment variables

Create `.env.example` with these values:

```bash
# Public app URLs
PUBLIC_BASE_URL=https://watch.example.com
PUBLIC_WS_URL=wss://watch.example.com/ws
PUBLIC_DISCORD_CLIENT_ID=replace_me

# Discord OAuth
DISCORD_CLIENT_ID=replace_me
DISCORD_CLIENT_SECRET=replace_me
DISCORD_REDIRECT_URI=https://watch.example.com/api/discord/callback

# App session security
APP_SESSION_SECRET=generate_32_bytes_minimum
COOKIE_SECRET=generate_32_bytes_minimum
TOKEN_ENCRYPTION_KEY=base64_32_byte_key

# Database
DATABASE_URL=file:/data/app.db

# Jellyfin defaults
JELLYFIN_DEFAULT_SERVER_URL=https://jellyfin.example.com
JELLYFIN_ALLOW_CUSTOM_SERVERS=false
JELLYFIN_REQUIRE_PER_USER_AUTH=true

# Stream proxy
STREAM_TICKET_TTL_SECONDS=300
STREAM_MAX_BITRATE=8000000
STREAM_PROXY_MODE=hls-first

# WebSocket / rooms
ROOM_MAX_PARTICIPANTS=20
ROOM_IDLE_TTL_SECONDS=900
ROOM_HOST_DISCONNECT_GRACE_SECONDS=30
SYNC_STATE_UPDATE_MS=1000
SYNC_HARD_SEEK_THRESHOLD_SECONDS=2.0
SYNC_SOFT_DRIFT_THRESHOLD_SECONDS=0.08

# CORS / security
ALLOWED_ORIGINS=https://watch.example.com
NODE_ENV=production
LOG_LEVEL=info
```

## 9. Discord application setup

Document this in `docs/discord-setup.md`.

1. Go to the Discord Developer Portal.
2. Create a new application, for example `Jellyfin Watch Party`.
3. Enable Activities / Embedded App support.
4. Set supported platforms for desktop/web first. Add mobile only after testing.
5. Add OAuth redirect URL:
   - `https://watch.example.com/api/discord/callback`
6. Set Activity URL mappings. The target must not include `https://`.

Example production URL mappings:

```text
PREFIX      TARGET
/           watch.example.com
/api        watch.example.com
/ws         watch.example.com
/media      watch.example.com
/assets     watch.example.com
```

Because all routes point to one app domain, this can often be simplified to just `/ -> watch.example.com`, but keep explicit mappings during development to make intent obvious.

7. For local development through Discord's proxy, use a tunnel such as `cloudflared` and update the `/` mapping to the temporary tunnel hostname.
8. Turn on Developer Mode in Discord.
9. Join a voice channel and launch the app from the developer Activity shelf.
10. Add an entry-point command after the MVP works, for example `/watch`, so users can launch the Activity more easily.

## 10. Authentication design

### 10.1 Discord auth

Frontend flow:

1. Instantiate `DiscordSDK` with the public Discord client ID.
2. Read `discordSdk.instanceId` immediately and store it as `discordInstanceId`.
3. Await `discordSdk.ready()`.
4. Call `discordSdk.commands.authorize()` with scopes:
   - `identify`
   - `guilds`
   - Optional: `guilds.members.read` only if using channel permission checks.
5. Send the returned OAuth `code` to backend endpoint `POST /api/discord/exchange`.
6. Backend exchanges code using `DISCORD_CLIENT_SECRET`.
7. Backend returns a short-lived app session JWT or sets an HTTP-only secure cookie.
8. Frontend calls `discordSdk.commands.authenticate({ access_token })` if using Discord's authenticated user flow.
9. Backend stores/updates Discord user record.

Backend should verify:

- Discord user ID.
- Guild ID and channel ID when provided by the Activity client.
- The Activity `instanceId` supplied by the frontend.
- Optional: whether the user is allowed to use this app in that guild/channel.

### 10.2 Jellyfin auth

MVP approach:

1. User opens Activity.
2. User clicks `Link Jellyfin`.
3. User provides Jellyfin username/password for the configured server.
4. Backend calls Jellyfin authentication API server-side.
5. Backend stores the returned Jellyfin access token encrypted at rest, associated with the Discord user ID.
6. Backend never sends the long-lived Jellyfin token back to the browser.
7. Browser only receives app-session tokens and short-lived media tickets.

Optional later approaches:

- Jellyfin Quick Connect linking.
- Companion Jellyfin plugin that issues short-lived Activity tokens.
- Admin-managed mapping of Discord users to Jellyfin users.

Security rules:

- Do not store Jellyfin passwords.
- Encrypt Jellyfin access tokens using `TOKEN_ENCRYPTION_KEY`.
- Allow users to unlink/delete their Jellyfin token.
- Use per-user Jellyfin tokens for library browsing and playback checks.
- Do not use a Jellyfin admin API key for user playback.

## 11. Database model

Use SQLite for MVP, with migration support.

Suggested tables:

```text
users
  id text primary key                  # Discord user id
  username text
  avatar text nullable
  created_at datetime
  updated_at datetime

jellyfin_accounts
  id text primary key
  discord_user_id text references users(id)
  server_url text
  jellyfin_user_id text
  jellyfin_username text
  encrypted_access_token text
  token_created_at datetime
  last_verified_at datetime nullable
  created_at datetime
  updated_at datetime

activity_sessions
  id text primary key
  discord_user_id text references users(id)
  discord_access_token_encrypted text nullable
  expires_at datetime
  created_at datetime

rooms
  instance_id text primary key         # Discord Activity instanceId
  guild_id text nullable
  channel_id text nullable
  host_discord_user_id text references users(id)
  jellyfin_server_url text
  item_id text nullable
  media_source_id text nullable
  item_name text nullable
  item_runtime_ticks integer nullable
  play_state text                      # idle | loading | playing | paused | ended
  position_seconds real default 0
  last_state_at datetime
  created_at datetime
  updated_at datetime

stream_tickets
  id text primary key
  hashed_token text unique
  discord_user_id text references users(id)
  server_url text
  item_id text
  media_source_id text nullable
  playback_session_id text nullable
  expires_at datetime
  created_at datetime
```

Rooms may remain in memory for MVP, but persisting a small room snapshot helps reconnects and debugging.

## 12. Backend API routes

All routes should return structured JSON errors:

```ts
type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
```

### Health

```text
GET /health
GET /api/health
```

### Discord auth

```text
POST /api/discord/exchange
  body: { code: string }
  returns: { appToken: string, user: DiscordUser }

GET /api/me
  auth: app session
  returns: { discordUser, jellyfinLinked: boolean }

POST /api/logout
```

### Jellyfin account linking

```text
POST /api/jellyfin/link
  auth: app session
  body: { serverUrl?: string, username: string, password: string }
  returns: { linked: true, jellyfinUser: { id, name }, serverUrl }

DELETE /api/jellyfin/link
  auth: app session
  returns: { linked: false }

GET /api/jellyfin/status
  auth: app session
  returns: { linked: boolean, serverUrl?: string, username?: string }
```

### Jellyfin library browsing

```text
GET /api/jellyfin/libraries
GET /api/jellyfin/items?parentId=...&query=...&type=Movie,Episode&limit=50
GET /api/jellyfin/items/:itemId
```

Backend uses the current user's Jellyfin token and only returns what that user can access.

### Playback

```text
POST /api/playback/prepare
  auth: app session
  body: {
    itemId: string,
    mediaSourceId?: string,
    audioStreamIndex?: number,
    subtitleStreamIndex?: number,
    maxStreamingBitrate?: number
  }
  returns: {
    ticket: string,
    expiresAt: string,
    streamType: "hls" | "mp4",
    playbackUrl: "/media/:ticket/master.m3u8" | "/media/:ticket/stream.mp4",
    item: {...},
    mediaSource: {...}
  }
```

### Media proxy

```text
GET /media/:ticket/master.m3u8
GET /media/:ticket/segments/:segmentId
GET /media/:ticket/stream.mp4
GET /media/:ticket/subtitles/:subtitleId
```

Rules:

- Validate stream ticket.
- Validate ticket has not expired.
- Resolve encrypted Jellyfin user token server-side.
- Proxy request to Jellyfin.
- For HLS playlists, rewrite segment URLs so they point back through `/media/:ticket/...`.
- For direct MP4, support `Range` requests and preserve `Content-Type`, `Content-Length`, `Content-Range`, and `Accept-Ranges` headers.
- Do not leak Jellyfin token in URLs, HTML, logs, or browser-visible response bodies.

### Room state

```text
GET /api/rooms/current?instanceId=...
POST /api/rooms/current/claim-host
POST /api/rooms/current/select-media
```

Most room updates should happen over WebSocket, but simple REST endpoints are useful for initial load and recovery.

## 13. WebSocket protocol

Endpoint:

```text
wss://watch.example.com/ws?token=<app-session-jwt>&instanceId=<discord-instance-id>
```

Use Zod schemas in `packages/shared/src/protocol.ts`.

### Client to server messages

```ts
type ClientMessage =
  | { type: 'hello'; instanceId: string; guildId?: string; channelId?: string; ts: number }
  | { type: 'claim_host'; ts: number }
  | { type: 'select_media'; itemId: string; mediaSourceId?: string; title: string; runtimeTicks?: number; ts: number }
  | { type: 'ready'; itemId: string; positionSeconds?: number; ts: number }
  | { type: 'player_event'; action: 'play' | 'pause' | 'seek' | 'buffering' | 'ended'; positionSeconds: number; ts: number }
  | { type: 'state_update'; playState: 'playing' | 'paused' | 'buffering'; positionSeconds: number; ts: number }
  | { type: 'ping'; clientTs: number; ts: number }
  | { type: 'leave'; ts: number };
```

### Server to client messages

```ts
type ServerMessage =
  | { type: 'hello_ack'; clientId: string; serverTs: number }
  | { type: 'room_state'; room: RoomState; serverTs: number }
  | { type: 'participants_update'; participants: Participant[]; serverTs: number }
  | { type: 'host_changed'; hostDiscordUserId: string; serverTs: number }
  | { type: 'media_selected'; itemId: string; mediaSourceId?: string; title: string; runtimeTicks?: number; serverTs: number }
  | { type: 'player_event'; action: 'play' | 'pause' | 'seek' | 'buffering' | 'ended'; positionSeconds: number; targetServerTs: number; serverTs: number }
  | { type: 'state_update'; playState: 'playing' | 'paused' | 'buffering'; positionSeconds: number; serverTs: number }
  | { type: 'pong'; clientTs: number; serverTs: number }
  | { type: 'error'; code: string; message: string; serverTs: number };
```

### Sync behavior

Use OpenWatchParty's behavior as the model:

- Host is authoritative.
- Only host can send playback commands and state updates.
- Non-host player events should be ignored or treated as local UI events only.
- `instanceId` identifies the room.
- Send host `state_update` every `SYNC_STATE_UPDATE_MS` while media is loaded.
- On `play`, schedule playback with a small future `targetServerTs`, for example `now + 1000ms`, so clients can start together.
- On `pause` or `seek`, schedule with a shorter delay, for example `now + 300ms`.
- Use ping/pong to estimate clock offset.
- For small drift, adjust playback rate within a safe range, for example 0.95x to 1.05x for subtle correction.
- For large drift, hard seek.
- Suppress feedback loops for about 2 seconds after applying a remote command.
- Pause sync correction while the local player is buffering.

## 14. Frontend Activity UX

### Screens

1. `BootScreen`
   - Initializes Discord SDK.
   - Shows launch errors.

2. `DiscordAuthScreen`
   - Runs Discord authorize flow.
   - Shows retry button if auth fails.

3. `LinkJellyfinScreen`
   - Server URL field if `JELLYFIN_ALLOW_CUSTOM_SERVERS=true`.
   - Username/password fields.
   - Link button.
   - Security note: credentials are sent to your self-hosted backend over HTTPS and not stored.

4. `LobbyScreen`
   - Shows current Discord channel/guild if available.
   - Shows participants.
   - If no host, first user can become host.
   - If user is host, show library browser.
   - If user is not host, show waiting state.

5. `LibraryBrowser`
   - Libraries list.
   - Search bar.
   - Movie/episode cards.
   - Select item button.

6. `WatchRoom`
   - Video player.
   - Host controls.
   - Participant list.
   - Current media title/runtime.
   - Sync status: synced, catching up, buffering, disconnected.

7. `ErrorPanel`
   - No Jellyfin access.
   - Stream ticket expired.
   - Playback unsupported.
   - Host disconnected.
   - Activity reconnecting.

### UX rules

- Do not show Jellyfin passwords after entry.
- Do not expose raw Jellyfin stream URLs.
- Use Discord participant display names/avatars where available.
- Keep UI readable in a compact iframe.
- Make host-only controls visibly disabled for participants.
- Add a `Copy diagnostics` button for debugging.
- Add `Unlink Jellyfin` in settings.

## 15. Media playback strategy

### HLS-first

1. Backend calls Jellyfin PlaybackInfo for the current user and item.
2. Prefer HLS/transcoded stream when direct-play compatibility is uncertain.
3. Return a short-lived `/media/:ticket/master.m3u8` URL to the browser.
4. Frontend uses `hls.js` if `Hls.isSupported()`.
5. If native HLS is supported, set `video.src` directly.
6. On HLS errors, show retry and optionally request a lower bitrate.

### Direct MP4 fallback

Use direct stream only if:

- Jellyfin reports a browser-compatible container/codec.
- Range requests work through the proxy.
- The file does not require unsupported subtitles/audio transforms.

### Subtitles

MVP:

- Use Jellyfin's default subtitle stream if included in HLS.
- Otherwise defer subtitle selection.

Later:

- Add stream picker.
- Proxy VTT subtitles.
- Synchronize subtitle settings per user or per room.

## 16. Jellyfin API implementation notes

Backend service `services/jellyfin.ts` should provide a small internal interface so the rest of the app is not tied to one SDK shape:

```ts
interface JellyfinService {
  authenticateByName(serverUrl: string, username: string, password: string): Promise<JellyfinAuthResult>;
  getPublicSystemInfo(serverUrl: string): Promise<JellyfinSystemInfo>;
  getLibraries(account: JellyfinAccount): Promise<JellyfinLibrary[]>;
  searchItems(account: JellyfinAccount, input: SearchInput): Promise<JellyfinItem[]>;
  getItem(account: JellyfinAccount, itemId: string): Promise<JellyfinItem>;
  getPlaybackInfo(account: JellyfinAccount, input: PlaybackInfoInput): Promise<PlaybackInfo>;
  openStream(account: JellyfinAccount, input: StreamInput): Promise<ProxyResponse>;
}
```

Implementation reminders:

- Verify exact Jellyfin auth and playback endpoints against the target Jellyfin server's `/api-docs/swagger/index.html`.
- Use Jellyfin's expected `Authorization`/`X-Emby-Authorization` headers consistently.
- Include a stable client name, device name, device ID, and version in Jellyfin authorization headers.
- Set conservative bitrate defaults to avoid hammering the Jellyfin transcode box.
- Handle 401 by marking Jellyfin account as needing relink.
- Handle 403 as item access denied.
- Handle 404 as item unavailable/deleted.
- Handle 5xx as Jellyfin unavailable.

## 17. Backend security requirements

- Use Helmet/security headers where compatible with Discord Activity embedding.
- Carefully test CSP because Discord also applies its own sandbox/proxy behavior.
- Set cookies as `HttpOnly`, `Secure`, `SameSite=None` if cookies must work inside the Discord iframe. If cookies are unreliable in embedded contexts, use short-lived bearer app tokens kept in memory only.
- Encrypt tokens at rest.
- Do not log Discord access tokens, Jellyfin tokens, passwords, stream tickets, or media URLs containing credentials.
- Rate limit:
  - login attempts,
  - playback prepare requests,
  - WebSocket messages,
  - stream ticket creation.
- Stream tickets must expire quickly and be bound to Discord user ID, Jellyfin user ID, item ID, and optionally IP/session fingerprint if practical.
- Validate all WebSocket messages with Zod.
- Enforce max message size.
- Enforce max participants per room.
- Close idle rooms.
- Make host-only commands server-enforced, not just UI-enforced.
- Provide a `TRUST_PROXY` setting if deployed behind Caddy/Nginx/Cloudflare.

## 18. Deployment design

### Recommended production layout

```text
Internet
  └─ Cloudflare DNS optional
      └─ Caddy HTTPS reverse proxy
          └─ jellyfin-discord-activity app container
              ├─ serves built React frontend
              ├─ serves REST API
              ├─ serves /ws WebSocket
              └─ serves /media stream proxy
          └─ Jellyfin server, same Docker network or private LAN
```

Using one app domain avoids complex Discord URL mappings and CORS problems.

### Example `docker-compose.yml`

```yaml
services:
  app:
    build: .
    container_name: jellyfin-discord-activity
    env_file: .env
    restart: unless-stopped
    volumes:
      - ./data:/data
    expose:
      - "3000"
    networks:
      - internal

  caddy:
    image: caddy:2-alpine
    container_name: jellyfin-watch-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - internal

networks:
  internal:

volumes:
  caddy_data:
  caddy_config:
```

### Example `Caddyfile`

```caddyfile
watch.example.com {
  encode zstd gzip
  reverse_proxy app:3000
}
```

If Jellyfin is not on the same Docker network, set `JELLYFIN_DEFAULT_SERVER_URL` to the LAN or public URL reachable from the app container.

### Discord URL mappings for this deployment

```text
/      watch.example.com
```

If Discord requires explicit mappings for WebSocket/media in testing:

```text
/      watch.example.com
/api   watch.example.com
/ws    watch.example.com
/media watch.example.com
```

## 19. Development workflow

### Bootstrap

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

### Local Discord proxy testing

```bash
cloudflared tunnel --url http://localhost:3000
```

Then update Discord URL mapping `/` to the generated tunnel hostname, without `https://`.

### Suggested package scripts

Root `package.json`:

```json
{
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "db:migrate": "pnpm --filter @app/api db:migrate",
    "start": "node apps/api/dist/server.js"
  }
}
```

## 20. Implementation phases for Codex

### Phase 0 — Repo bootstrap

Deliverables:

- pnpm monorepo.
- TypeScript config.
- Shared package with initial types/schemas.
- Fastify API skeleton.
- Vite React skeleton.
- Dockerfile and Docker Compose.
- `.env.example`.
- Health endpoint.

Acceptance criteria:

- `pnpm install` succeeds.
- `pnpm typecheck` succeeds.
- `pnpm test` succeeds with at least one trivial test.
- `docker compose up --build` starts app.
- `GET /health` returns `{ ok: true }`.

### Phase 1 — Discord Activity boot/auth

Deliverables:

- Discord SDK initialization.
- `instanceId` capture.
- `ready()` flow.
- OAuth `authorize()` flow.
- Backend code exchange endpoint.
- App session token/cookie.
- `/api/me` endpoint.
- Basic participant list from SDK when available.

Acceptance criteria:

- Activity launches in Discord dev shelf.
- User can authenticate with Discord.
- Backend can identify Discord user.
- UI shows instance ID, user display name, and participant count.

### Phase 2 — Jellyfin linking

Deliverables:

- Link Jellyfin screen.
- Backend Jellyfin auth service.
- Encrypted Jellyfin token storage.
- `/api/jellyfin/status`.
- `/api/jellyfin/link`.
- `/api/jellyfin/libraries`.
- Unlink endpoint.

Acceptance criteria:

- User can link Jellyfin account.
- Linked account persists across reload.
- User can list Jellyfin libraries.
- Wrong password returns friendly error.
- Token is not visible in browser dev tools responses.

### Phase 3 — Library browsing

Deliverables:

- Library list UI.
- Item grid UI.
- Search endpoint/UI.
- Item details endpoint/UI.
- Host-only media selection.

Acceptance criteria:

- Host can browse movies/episodes.
- Host can search by title.
- Selecting media updates room state.
- Participants see selected title.

### Phase 4 — Playback preparation and media proxy

Deliverables:

- PlaybackInfo integration.
- Stream ticket service.
- HLS playlist proxy/rewrite.
- HLS segment proxy.
- Optional direct MP4 proxy with Range support.
- Frontend video player with hls.js.

Acceptance criteria:

- User can play a selected Jellyfin item inside the Activity.
- Browser never receives Jellyfin access token.
- HLS playlist segment URLs are rewritten through `/media`.
- Expired ticket returns 401/403 and frontend can request a fresh ticket.
- Direct MP4 Range test passes if direct mode is enabled.

### Phase 5 — Watch-party WebSocket sync

Deliverables:

- `/ws` authenticated WebSocket endpoint.
- In-memory room manager keyed by Discord `instanceId`.
- Host claim logic.
- Participant join/leave tracking.
- Player event broadcast.
- Clock sync ping/pong.
- Drift correction hook on frontend.
- Reconnect behavior.

Acceptance criteria:

- Two clients in same Activity instance join same room.
- Host play/pause/seek affects participant.
- Participant controls do not affect host.
- Drift over threshold is corrected.
- WebSocket reconnect restores room state.

### Phase 6 — Hardening

Deliverables:

- Rate limits.
- Structured logging.
- Better error mapping.
- Token redaction in logs.
- Room idle cleanup.
- Max participants enforcement.
- Security docs.
- Troubleshooting docs.

Acceptance criteria:

- Invalid WebSocket messages are rejected safely.
- Non-host playback commands are rejected server-side.
- Expired app sessions cannot use API/WS/media endpoints.
- Logs contain no secrets.
- Idle rooms close after TTL.

### Phase 7 — Deployment docs and smoke tests

Deliverables:

- `docs/deployment.md`.
- `docs/discord-setup.md`.
- `docs/jellyfin-setup.md`.
- `docs/troubleshooting.md`.
- `scripts/smoke-test.ts`.
- Production Dockerfile.

Acceptance criteria:

- Fresh clone can be configured using docs.
- `docker compose up --build` works.
- Discord URL mapping instructions are complete.
- Smoke test validates health, auth guard, and WebSocket connection.

### Phase 8 — Optional OpenWatchParty compatibility bridge

Deliverables:

- Compatibility mapping document from OpenWatchParty protocol to local protocol.
- Optional mode that connects to an existing OpenWatchParty session server.
- Optional adapter for `create_room`, `join_room`, `player_event`, `state_update`, `ping/pong`.

Acceptance criteria:

- Existing OpenWatchParty server can relay basic playback events.
- Discord Activity remains the player UI.
- Auth model remains safe; no Jellyfin tokens leak to OpenWatchParty unless explicitly intended.

## 21. Testing plan

### Unit tests

- Protocol schema validation.
- Room manager host/participant logic.
- Non-host command rejection.
- Drift correction calculations.
- Stream ticket creation/expiration.
- HLS playlist URL rewriting.
- Token encryption/decryption.

### Integration tests

- Mock Jellyfin auth success/failure.
- Mock PlaybackInfo and HLS playlist proxy.
- WebSocket connect/join/play/pause/seek.
- Expired token on API/WS/media routes.
- Range request proxy behavior.

### E2E tests

- Launch frontend outside Discord in dev mock mode.
- Mock Discord SDK object for browser tests.
- Link Jellyfin with mock server.
- Browse library.
- Select item.
- Start playback.
- Second browser joins same mock `instanceId` and syncs.

### Manual Discord tests

- Desktop Discord Activity launch.
- Discord web launch.
- Two users in same voice channel.
- Host leaves.
- Participant reloads.
- Jellyfin server offline.
- Transcoding failure.
- Stream ticket expiration during playback.

## 22. Dev mock mode

Because Discord Activities are annoying to test locally, implement `VITE_DEV_DISCORD_MOCK=true`.

Mock values:

```ts
const mockDiscord = {
  user: {
    id: 'dev-user-1',
    username: 'DevHost',
    avatar: null
  },
  guildId: 'dev-guild-1',
  channelId: 'dev-channel-1',
  instanceId: 'dev-instance-1'
};
```

Add query params for testing:

```text
?mockUser=host&mockInstance=room1
?mockUser=guest&mockInstance=room1
?mockUser=guest2&mockInstance=room2
```

This allows local multi-tab sync tests without Discord.

## 23. Production checklist

- [ ] Public HTTPS domain configured.
- [ ] Discord app created and Activities enabled.
- [ ] Discord URL mapping points to production domain.
- [ ] Discord OAuth redirect configured.
- [ ] `.env` secrets generated with at least 32 bytes of entropy.
- [ ] Jellyfin is reachable from app container.
- [ ] Jellyfin hardware transcoding tested.
- [ ] App logs redact secrets.
- [ ] Caddy/Nginx handles WebSocket upgrade.
- [ ] Stream proxy handles HLS and Range requests.
- [ ] Rate limits enabled.
- [ ] Backups include SQLite DB and `.env`, stored securely.
- [ ] Media permissions tested with a restricted Jellyfin user.
- [ ] Two-user Discord voice test passed.

## 24. Known risks and spikes

### Risk: Discord proxy/CSP blocks media or WebSocket paths

Mitigation:

- Use one app domain.
- Use URL mappings for `/`, `/api`, `/ws`, and `/media`.
- Test through Discord proxy early, not only localhost override.

### Risk: Jellyfin HLS playlist contains URLs that bypass the proxy

Mitigation:

- Parse and rewrite every playlist URI.
- Support nested playlists.
- Keep segment paths relative to `/media/:ticket/...`.

### Risk: Jellyfin direct-play codecs fail inside Discord's iframe/WebView

Mitigation:

- Default to HLS/transcoding.
- Add max bitrate setting.
- Add clear error if no compatible stream is available.

### Risk: Jellyfin server overloaded by transcodes

Mitigation:

- Default max bitrate.
- Encourage hardware transcoding.
- Display warning when multiple users join.
- Later: preflight transcode capacity or admin limit.

### Risk: Cookie restrictions inside iframe

Mitigation:

- Prefer short-lived bearer app token in memory for Activity API calls.
- If cookies are used, set `Secure`, `HttpOnly`, `SameSite=None` and test in Discord desktop/web.

### Risk: Using host token leaks content to users without Jellyfin permission

Mitigation:

- Require per-user Jellyfin auth for MVP.
- On media selection, participants call prepare playback with their own account.
- If a user lacks access, show an access denied panel.

## 25. Suggested first Codex prompt

Use this after placing `PLAN.md` in the repo root:

```text
You are building the repository described in PLAN.md. Start with Phase 0 only. Create the pnpm monorepo, strict TypeScript configs, shared package, Fastify API skeleton, Vite React frontend skeleton, Dockerfile, docker-compose files, .env.example, and a health endpoint. Do not implement Discord or Jellyfin auth yet. Add minimal tests and make sure pnpm install, pnpm typecheck, pnpm test, pnpm build, and docker compose up --build are expected to work. Keep the implementation small, clean, and ready for Phase 1.
```

Then proceed phase by phase. Do not ask Codex to build every phase in one prompt; that will create messy code and skipped edge cases.

## 26. MVP definition of done

The MVP is done when:

1. A developer can deploy the app at `https://watch.example.com`.
2. A Discord developer Activity can launch in a voice channel.
3. Two Discord users can join the same Activity instance.
4. Both users can link Jellyfin accounts.
5. Host can select a Jellyfin movie or episode.
6. Each user gets a user-specific stream ticket.
7. Playback starts inside the Activity.
8. Host play/pause/seek synchronizes to participant.
9. No Jellyfin tokens are visible in frontend responses, logs, localStorage, or URLs.
10. The deployment can be restarted without losing linked accounts.

## 27. Recommended future enhancements

- Jellyfin Quick Connect linking.
- Audio/subtitle stream selection.
- Host transfer.
- Queue/playlist support.
- Rich Presence showing current title without exposing private library details broadly.
- Invite button using Discord SDK user actions.
- Admin allowlist for guild IDs.
- Companion Jellyfin plugin for cleaner token issuance and admin config.
- OpenWatchParty protocol adapter or direct session-server reuse.
- Metrics dashboard: rooms, participants, stream starts, transcode errors.
- Postgres support for larger deployments.
- Redis room state if scaling beyond one app process.
