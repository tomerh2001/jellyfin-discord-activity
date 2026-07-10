# Jellyfin Setup

Set `JELLYFIN_DEFAULT_SERVER_URL` to a Jellyfin URL reachable from the app container. For remote Discord users, media should route through the app backend instead of exposing LAN-only Jellyfin URLs to the browser.

## Required Environment

```bash
JELLYFIN_DEFAULT_SERVER_URL=https://jellyfin.example.com
JELLYFIN_ALLOW_CUSTOM_SERVERS=false
JELLYFIN_AUTH_MODE=per-user
JELLYFIN_SHARED_USERNAME=
JELLYFIN_SHARED_PASSWORD=
STREAM_TICKET_TTL_SECONDS=14400
STREAM_MAX_BITRATE=20000000
STREAM_MAX_WIDTH=1920
STREAM_MAX_HEIGHT=1080
STREAM_PROXY_MODE=hls-first
TOKEN_ENCRYPTION_KEY=base64_32_byte_key
```

Generate `TOKEN_ENCRYPTION_KEY` with:

```bash
openssl rand -base64 32
```

The app stores Jellyfin access tokens encrypted in `./data/jellyfin-accounts.json` when running with the default Docker Compose volume. Jellyfin passwords are not written to that file. In per-user mode, passwords are only sent to the backend during the link request. In shared mode, the shared account password comes from environment variables and is used only server-side to obtain or refresh an access token.

## Auth Mode Options

### Per-User Mode

Per-user mode is the default:

```bash
JELLYFIN_AUTH_MODE=per-user
```

Use this mode when you want Jellyfin permissions, watch access, and account revocation to apply separately for each Discord user.

Flow:

1. A Discord user authenticates in the Activity.
2. The user enters their Jellyfin username and password in the Jellyfin account panel.
3. The user can leave `Server URL` blank to use `JELLYFIN_DEFAULT_SERVER_URL`.
4. The backend authenticates with Jellyfin using `POST /Users/AuthenticateByName`.
5. The backend encrypts the returned Jellyfin access token with `TOKEN_ENCRYPTION_KEY`.
6. The encrypted token is stored under that Discord user's internal id in `/data/jellyfin-accounts.json`.
7. The frontend receives only link status and Jellyfin user metadata, never the Jellyfin token.

If `JELLYFIN_ALLOW_CUSTOM_SERVERS=false`, any submitted `serverUrl` is ignored and the configured default server is used.

### Shared Mode

Shared mode is explicitly enabled:

```bash
JELLYFIN_AUTH_MODE=shared
JELLYFIN_SHARED_USERNAME=discord-watch
JELLYFIN_SHARED_PASSWORD=replace_with_that_users_password
```

Use shared mode only for trusted/private deployments where every authenticated Discord watcher should receive the same Jellyfin library access. Discord authentication is still required, but individual Discord users do not link Jellyfin accounts and do not see password fields in the Activity.

Recommended Jellyfin account setup:

1. In Jellyfin, create a dedicated user such as `discord-watch`.
2. Do not make that user an administrator.
3. Give the user access only to libraries intended for Discord viewing.
4. Disable library access that should remain private.
5. Confirm the user can play the intended media directly in Jellyfin.
6. Put that username and password in `.env`.
7. Restart the app container after changing `.env`.

Shared mode behavior:

- The backend always uses `JELLYFIN_DEFAULT_SERVER_URL`.
- Custom per-user Jellyfin server URLs are ignored.
- `GET /api/jellyfin/status` authenticates or verifies the shared account and returns `authMode: "shared"`.
- `POST /api/jellyfin/link` and `DELETE /api/jellyfin/link` return `409 jellyfin_shared_mode_enabled`.
- The shared Jellyfin access token is encrypted and stored in `/data/jellyfin-accounts.json` under a reserved internal key.
- If Jellyfin rejects the shared token with `jellyfin_token_invalid`, the backend reauthenticates once with `JELLYFIN_SHARED_USERNAME` and `JELLYFIN_SHARED_PASSWORD`, stores the new encrypted token, and retries the original operation.

## Library Browsing And Playback

The app resolves the active Jellyfin account before these routes:

```text
GET /api/jellyfin/libraries
GET /api/jellyfin/items
GET /api/jellyfin/items/:itemId
GET /api/jellyfin/items/:itemId/image
POST /api/playback/prepare
```

In per-user mode, those routes use the authenticated Discord user's linked Jellyfin account.

In shared mode, those routes use the configured shared Jellyfin account for every authenticated Discord user.

The backend calls Jellyfin from the container and returns reduced item metadata to the browser. Jellyfin permissions still apply to whichever Jellyfin account the active mode resolved.

Artwork is loaded on demand through the backend image proxy:

1. Library and item responses include `imageTag` when Jellyfin reports a primary image.
2. Responses include `imageItemId` when the UI should request artwork from a specific Jellyfin item id.
3. For movies, `imageItemId` is usually the movie id.
4. For episodes, `imageItemId` may be the parent series id when Jellyfin exposes series poster art instead of episode art.
5. The Activity frontend fetches `/api/jellyfin/items/:imageItemId/image` with the app session bearer token.
6. The backend adds the Jellyfin access token server-side and streams the image bytes back to the Activity.
7. The browser never receives the Jellyfin access token.

## Host And Participant Requirements

Per-user mode:

1. Authenticate with Discord.
2. Link a Jellyfin account.
3. Claim host in the Activity room.
4. Browse a library or search by title.
5. Select a movie or episode.
6. Each participant links their own Jellyfin account before preparing playback.

Shared mode:

1. Authenticate with Discord.
2. Confirm the Jellyfin panel shows the shared account.
3. Claim host in the Activity room.
4. Browse a library or search by title.
5. Select a movie or episode.
6. Participants authenticate with Discord but do not link Jellyfin accounts.

Participants receive room state through `/ws`, see the title selected by the current host, and prepare playback through the Jellyfin account resolved for the active mode.

## Media Proxy

When a user clicks `Prepare playback`, the backend:

1. Calls Jellyfin `PlaybackInfo` for the selected item.
2. Chooses HLS by default when available.
3. Creates a short-lived stream ticket.
4. Returns an app-local `/media/...` URL to the browser.
5. Fetches playlists, segments, or direct stream bytes from Jellyfin server-side.

The browser never receives a Jellyfin access token. HLS playlist entries are rewritten through `/media/hls/...`, and direct streams support `Range` requests through `/media/direct/...`.

Playback selection is remux-first for browser-safe codecs (H.264/AAC and similar when Jellyfin reports DirectPlay or DirectStream). Incompatible media uses HLS with Jellyfin's `TranscodingUrl` when available. If the current client rejects HLS, only that local player retries with `preferredPlayMethod=direct`; other participants are unchanged.

Use `STREAM_PROXY_MODE=hls-first` for normal Discord clients. Use `STREAM_PROXY_MODE=direct` only when you want to force progressive/direct delivery for every prepare.

## Verifying From The Container

After the app is running:

```bash
docker compose exec app wget -qO- "$JELLYFIN_DEFAULT_SERVER_URL/System/Info/Public"
```

If that cannot reach Jellyfin, account linking and shared account authentication will fail even if Jellyfin works from your browser.
