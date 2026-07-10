# Troubleshooting

- `GET /health` should return `{ "ok": true }`.
- If Discord cannot load the Activity, verify URL mappings use hostnames without `https://`.
- If container startup fails, confirm `.env` exists and port `3000` is available.

## Host log files

With the default `docker-compose.yml`, app logs are written to:

```text
logs/app/app.log      # all structured JSON logs
logs/app/error.log    # error-level only
```

```bash
./scripts/tail-logs.sh app
grep -E 'Playback prepared|Playback prepare|HLS|Direct stream' logs/app/app.log | tail -50
```

If you also run Caddy via `docker compose --profile proxy`, access logs go to `logs/caddy/access.log` when the Caddyfile uses file logging (see `Caddyfile.example`).

Share relevant `logs/app/app.log` excerpts together with Activity **Copy diagnostics** when reporting Linux playback issues.

## Container Startup

Run:

```bash
docker compose up --build
```

Then verify from the host:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{ "ok": true }
```

If the container exits immediately, check:

- `.env` exists in the repository root.
- `PORT=3000` or your compose port mapping matches the port you expect.
- `APP_SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` are set to production values before linking real Jellyfin accounts.
- `JELLYFIN_DEFAULT_SERVER_URL` is reachable from inside the container.
- If `JELLYFIN_AUTH_MODE=shared`, both `JELLYFIN_SHARED_USERNAME` and `JELLYFIN_SHARED_PASSWORD` are set.

## Nginx Proxy Manager

For `https://watch.example.com` forwarding to `YOUR_DOCKER_HOST_IP:3000`, the app environment should use:

```bash
PUBLIC_BASE_URL=https://watch.example.com
PUBLIC_WS_URL=wss://watch.example.com/ws
DISCORD_REDIRECT_URI=https://watch.example.com/api/discord/callback
ALLOWED_ORIGINS=https://watch.example.com
TRUST_PROXY=true
```

In Nginx Proxy Manager:

- Forward to scheme `http`, host `YOUR_DOCKER_HOST_IP`, port `3000`.
- Enable WebSocket support.
- Use a valid SSL certificate for the public hostname.
- Avoid logging query strings if possible because `/ws` uses a short-lived `token` query parameter.

## Rate Limited Requests

If an endpoint returns:

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests. Try again shortly."
  }
}
```

wait for the current `RATE_LIMIT_WINDOW` to pass. For a private home deployment, the defaults are:

```bash
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW=1 minute
```

If many Discord clients appear to come from one proxy IP, confirm `TRUST_PROXY=true` is set only behind Nginx Proxy Manager or another trusted proxy.

## WebSocket Fails Or Reconnects

The WebSocket endpoint is:

```text
wss://your-domain.example/ws?token=short_lived_app_session_jwt&instanceId=discord_activity_instance_id
```

Common causes:

- The reverse proxy does not have WebSocket support enabled.
- `PUBLIC_WS_URL` is still set to `ws://` instead of `wss://` in production.
- The app session token expired. Reload the Activity and authenticate again.
- `ROOM_MAX_PARTICIPANTS` has been reached. Additional clients receive `room_full`.
- The client sent malformed JSON. The server responds with `invalid_json` and keeps the process alive.

## Smoke Test Fails

Run smoke tests from the repository root:

```bash
pnpm smoke
```

For a public or non-default base URL:

```bash
SMOKE_BASE_URL=https://watch.example.com \
SMOKE_WS_URL=wss://watch.example.com/ws \
pnpm smoke
```

The smoke test needs an app token so it can verify `/ws`. For local or pre-production smoke tests, temporarily set:

```bash
DEV_AUTH_MOCK=true
```

Then recreate the app container and rerun smoke. If the test passes, immediately set `DEV_AUTH_MOCK=false` and recreate the app again before public use.

Smoke test failure meanings:

- `Health check failed`: the app is not reachable at `SMOKE_BASE_URL`, the container is not running, or the reverse proxy is not forwarding correctly.
- `/api/me auth guard failed`: the API auth guard is not rejecting unauthenticated requests as expected.
- `Dev mock exchange failed`: `DEV_AUTH_MOCK` is not enabled on the target app, or the request is not reaching the current backend.
- `WebSocket connection failed`: WebSocket support is disabled in the reverse proxy, `SMOKE_WS_URL` is wrong, or `/ws` is not mapped in Discord/proxy routing.
- `Expected first WebSocket message type hello_ack`: the WebSocket connected to something other than this backend, or the sync server failed before room initialization.

## Playback Or Media Proxy Fails

If playback prepare works but video later returns `stream_ticket_invalid`, request playback again from the Activity. Stream tickets expire quickly and are also rejected after the creating app session expires.

If playback never prepares:

- In per-user mode, confirm the user has linked a Jellyfin account.
- In per-user mode, confirm that same Jellyfin user can access the selected item in Jellyfin.
- In shared mode, confirm the shared Jellyfin user can access the selected item in Jellyfin.
- Confirm the app container can reach `JELLYFIN_DEFAULT_SERVER_URL`.
- Confirm `STREAM_MAX_BITRATE` is not higher than your Jellyfin server can handle.

If playback works but looks much softer than Jellyfin direct playback:

- Browser-safe sources (H.264/AAC in MP4 and similar) should **remux/direct-play** through `/media/direct/...` without re-encoding. The player status pill shows `direct` in that case.
- Only incompatible codecs (HEVC, TrueHD, etc.) are forced through H.264/AAC HLS or MP4 transcoding under `STREAM_MAX_BITRATE`, `STREAM_MAX_WIDTH`, and `STREAM_MAX_HEIGHT`.
- Defaults are `STREAM_MAX_BITRATE=20000000`, `STREAM_MAX_WIDTH=1920`, `STREAM_MAX_HEIGHT=1080`. Raise those only for forced transcodes / 4K if your Jellyfin host can handle it.
- Stream tickets default to `STREAM_TICKET_TTL_SECONDS=14400` and slide forward while the proxy is actively used (still capped by the app session).

If the Linux Discord client fails while Chrome or Windows Discord works:

1. Discord Linux Electron rejects **H.264** (MPEG-TS HLS, fMP4 HLS, and progressive MP4) with `MEDIA_ERR_SRC_NOT_SUPPORTED` even when `canPlayType` says `"probably"`.
2. Linux therefore uses **only progressive VP8/Opus WebM** (~480p / 1.5 Mbps) with a ~10s soak before play. Electron often reports `buffered=0` for live progressive streams, so soak uses wall-clock + `readyState` as well as TimeRanges.
3. Stalls on WebM still mean the Jellyfin encode is falling behind realtime (CPU). Each Linux viewer is a separate software transcode — prefer Windows/Web hosts for multi-person watch parties.
4. Windows/Web: remux when possible, else fMP4 HLS → progressive MP4 → WebM. Unchanged.
5. Diagnostics + `logs/app/app.log` (`Playback prepared`) remain the best debug combo.

## Jellyfin Auth Mode Problems

Check the active mode from a browser-safe config request:

```bash
curl https://watch.example.com/api/config
```

The response includes:

```json
{
  "jellyfinAuthMode": "per-user"
}
```

or:

```json
{
  "jellyfinAuthMode": "shared"
}
```

### Shared Mode Shows Not Ready

If the Activity shows the shared Jellyfin account is not ready, call status while authenticated or check backend logs around `/api/jellyfin/status`.

The most common API error is:

```json
{
  "error": {
    "code": "jellyfin_shared_not_configured",
    "message": "Shared Jellyfin account mode requires JELLYFIN_SHARED_USERNAME and JELLYFIN_SHARED_PASSWORD."
  }
}
```

Fix:

```bash
JELLYFIN_AUTH_MODE=shared
JELLYFIN_SHARED_USERNAME=discord-watch
JELLYFIN_SHARED_PASSWORD=replace_with_that_users_password
```

Then recreate the container:

```bash
docker compose up -d --force-recreate
```

If the username and password are set but status still fails:

- Confirm the shared Jellyfin user exists.
- Confirm the password is current.
- Confirm the user is allowed to log in.
- Confirm `JELLYFIN_DEFAULT_SERVER_URL` points to the Jellyfin server reachable from the app container.
- Confirm the shared user has library access.

### Link Button Returns 409

In shared mode, linking and unlinking are intentionally disabled. The API returns:

```json
{
  "error": {
    "code": "jellyfin_shared_mode_enabled",
    "message": "Jellyfin account linking is disabled because shared Jellyfin mode is enabled."
  }
}
```

This is expected. Change back to per-user mode if individual Discord users should manage their own Jellyfin credentials:

```bash
JELLYFIN_AUTH_MODE=per-user
JELLYFIN_SHARED_USERNAME=
JELLYFIN_SHARED_PASSWORD=
```

### Shared Token Expires Or Is Revoked

If Jellyfin rejects the stored shared token, the backend reauthenticates once with `JELLYFIN_SHARED_USERNAME` and `JELLYFIN_SHARED_PASSWORD`, stores the new encrypted token, and retries the original library, item, or playback operation.

If the retry still fails:

- Confirm the shared password in `.env` is current.
- Restart the app after changing `.env`.
- Check that the Jellyfin user was not disabled.
- Check that `TOKEN_ENCRYPTION_KEY` has not been changed unexpectedly.
- If needed, stop the app, back up `data/jellyfin-accounts.json`, remove the reserved shared record, and start the app so it can authenticate again.

## Library Artwork Does Not Show

The Activity loads posters through:

```text
GET /api/jellyfin/items/:itemId/image
```

If cards still show the text placeholder instead of artwork:

- Confirm the Jellyfin item has a Primary image in Jellyfin.
- For TV episodes, confirm the parent series has poster artwork; the Activity can fall back to the series primary image when Jellyfin reports `SeriesPrimaryImageTag`.
- Confirm the active Jellyfin account can see the item and its parent series.
- Open browser developer tools and check whether `/api/jellyfin/items/.../image` returns `200`, `401`, `404`, or `502`.
- `404 jellyfin_image_not_found` means Jellyfin did not return a primary image for that item id.
- `401 jellyfin_token_invalid` means the Jellyfin token needs to be refreshed or the shared account credentials need to be checked.
- `502 jellyfin_image_failed` means the backend reached Jellyfin but Jellyfin failed the image request.

## Room State Disappears

Rooms are stored in memory. They disappear when:

- The app container restarts.
- No clients are connected for longer than `ROOM_IDLE_TTL_SECONDS`.

Linked Jellyfin accounts are not room state; they persist in `/data/jellyfin-accounts.json`. In shared mode, the reserved shared Jellyfin account token is stored in the same file.
