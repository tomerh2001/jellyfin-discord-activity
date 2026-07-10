# API

## Health

```text
GET /health
GET /api/health
```

Both return:

```json
{ "ok": true }
```

If the app-wide rate limit is exceeded, API endpoints return status `429`:

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests. Try again shortly."
  }
}
```

## Public Config

```text
GET /api/config
```

Returns browser-safe runtime configuration:

```json
{
  "publicBaseUrl": "https://watch.example.com",
  "publicWsUrl": "wss://watch.example.com/ws",
  "publicDiscordClientId": "your_application_id",
  "jellyfinAuthMode": "per-user"
}
```

`jellyfinAuthMode` is either `per-user` or `shared`. Frontends use it to decide whether to show the Jellyfin link form.

## Discord Auth

```text
POST /api/discord/exchange
```

Body:

```json
{
  "code": "discord_oauth_code",
  "instanceId": "discord_activity_instance_id",
  "guildId": "optional_guild_id",
  "channelId": "optional_channel_id"
}
```

Returns:

```json
{
  "appToken": "short_lived_app_session_jwt",
  "discordAccessToken": "discord_access_token_for_sdk_authenticate",
  "user": {
    "id": "discord_user_id",
    "username": "username",
    "globalName": "Display Name",
    "avatar": null
  },
  "expiresAt": "2026-07-09T12:00:00.000Z"
}
```

The app token is used as a bearer token for backend API calls:

```text
Authorization: Bearer short_lived_app_session_jwt
```

```text
GET /api/me
```

Returns:

```json
{
  "discordUser": {
    "id": "discord_user_id",
    "username": "username",
    "globalName": "Display Name",
    "avatar": null
  },
  "jellyfinLinked": false,
  "discordContext": {
    "instanceId": "discord_activity_instance_id",
    "guildId": "optional_guild_id",
    "channelId": "optional_channel_id"
  },
  "appSessionExpiresAt": "2026-07-09T12:00:00.000Z"
}
```

`jellyfinLinked` reflects whether Jellyfin is available for the authenticated Discord user in the active auth mode. In per-user mode, it means that Discord user has linked a Jellyfin account. In shared mode, it is `true` because the deployment uses the configured shared Jellyfin account.

```text
POST /api/logout
```

Invalidates the current in-memory app session when a valid bearer token is supplied, then returns:

```json
{ "ok": true }
```

## Jellyfin Account Status And Linking

All Jellyfin routes require:

```text
Authorization: Bearer short_lived_app_session_jwt
```

```text
GET /api/jellyfin/status
```

Returns:

```json
{
  "linked": true,
  "authMode": "per-user",
  "serverUrl": "https://jellyfin.example.com",
  "username": "jellyfin-user"
}
```

or:

```json
{
  "linked": false,
  "authMode": "per-user"
}
```

In shared mode, a verified shared account returns:

```json
{
  "linked": true,
  "authMode": "shared",
  "serverUrl": "https://jellyfin.example.com",
  "username": "discord-watch"
}
```

```text
POST /api/jellyfin/link
```

Body:

```json
{
  "serverUrl": "https://jellyfin.example.com",
  "username": "jellyfin-user",
  "password": "jellyfin-password"
}
```

`serverUrl` is optional. When `JELLYFIN_ALLOW_CUSTOM_SERVERS=false`, the backend uses `JELLYFIN_DEFAULT_SERVER_URL`.

Returns:

```json
{
  "linked": true,
  "jellyfinUser": {
    "id": "jellyfin_user_id",
    "name": "jellyfin-user"
  },
  "serverUrl": "https://jellyfin.example.com"
}
```

The response never includes the Jellyfin access token. The backend encrypts that token before writing it to local storage.

In shared mode, users do not link individual Jellyfin accounts. This endpoint returns `409`:

```json
{
  "error": {
    "code": "jellyfin_shared_mode_enabled",
    "message": "Jellyfin account linking is disabled because shared Jellyfin mode is enabled."
  }
}
```

```text
DELETE /api/jellyfin/link
```

Returns:

```json
{ "linked": false }
```

In shared mode, unlinking is disabled and returns the same `409 jellyfin_shared_mode_enabled` error as `POST /api/jellyfin/link`.

```text
GET /api/jellyfin/libraries
```

Returns libraries visible to the active Jellyfin account. In per-user mode, this is the linked Jellyfin user for the authenticated Discord user. In shared mode, this is the configured shared Jellyfin user:

```json
{
  "libraries": [
    {
      "id": "library_id",
      "name": "Movies",
      "collectionType": "movies"
    }
  ]
}
```

```text
GET /api/jellyfin/items?parentId=library_id&query=search_text&type=Movie,Episode&limit=50
```

Returns movies and episodes visible to the active Jellyfin account. Query parameters:

- `parentId`: optional Jellyfin library/folder id to search within.
- `query`: optional title search text.
- `type`: optional comma-separated Jellyfin item types. The current UI uses `Movie,Episode`.
- `limit`: optional result limit from `1` to `100`; defaults to `50`.

Example response:

```json
{
  "items": [
    {
      "id": "movie_id",
      "name": "Movie Title",
      "type": "Movie",
      "overview": "Optional overview.",
      "parentId": "library_id",
      "seriesName": null,
      "seasonName": null,
      "productionYear": 2026,
      "runtimeTicks": 72000000000,
      "imageItemId": "movie_id",
      "imageTag": "primary_image_tag"
    }
  ],
  "totalRecordCount": 1
}
```

`imageItemId` and `imageTag` are optional. When present, the frontend can request artwork from the authenticated backend image proxy. For episodes, `imageItemId` may point at the parent series when Jellyfin exposes a series primary image instead of an episode-specific primary image.

```text
GET /api/jellyfin/items/:itemId
```

Returns item details for one Jellyfin item visible to the linked user:

```json
{
  "item": {
    "id": "movie_id",
    "name": "Movie Title",
    "type": "Movie",
    "overview": "Optional overview.",
    "parentId": "library_id",
    "seriesName": null,
    "seasonName": null,
    "productionYear": 2026,
    "runtimeTicks": 72000000000,
    "imageItemId": "movie_id",
    "imageTag": "primary_image_tag"
  }
}
```

```text
GET /api/jellyfin/items/:itemId/image?width=320&height=480&tag=primary_image_tag
```

Requires the app session bearer token. Proxies the Jellyfin primary image for an item or parent image item through the backend. The browser should call this route with the same app session token used for library browsing; the Jellyfin access token is never exposed to the browser.

Query parameters:

- `width`: optional rendered image width. The backend clamps very small or very large values.
- `height`: optional rendered image height. The backend clamps very small or very large values.
- `tag`: optional Jellyfin image cache tag from `imageTag`.

Successful responses return image bytes, usually `image/jpeg`, with private browser cache headers. If Jellyfin has no primary image for that item, the backend returns `404 jellyfin_image_not_found`.

## Rooms

Room state is keyed by the Discord Activity `instanceId`. It is stored in memory, so room state resets when the backend process restarts or when idle room cleanup removes an inactive room after `ROOM_IDLE_TTL_SECONDS`.

```text
GET /api/rooms/current?instanceId=discord_activity_instance_id
```

This route does not require authentication. It returns the current room snapshot, creating an idle room if one does not exist:

```json
{
  "room": {
    "instanceId": "discord_activity_instance_id",
    "guildId": "optional_guild_id",
    "channelId": "optional_channel_id",
    "hostDiscordUserId": "discord_user_id",
    "itemId": "movie_id",
    "mediaSourceId": "optional_media_source_id",
    "title": "Movie Title",
    "runtimeTicks": 72000000000,
    "playState": "loading",
    "positionSeconds": 0,
    "updatedAt": "2026-07-09T12:00:00.000Z"
  }
}
```

```text
POST /api/rooms/current/claim-host
```

Requires the app session bearer token. Body:

```json
{
  "instanceId": "discord_activity_instance_id",
  "guildId": "optional_guild_id",
  "channelId": "optional_channel_id"
}
```

The first authenticated user to claim the room becomes host. The current host can safely call this endpoint again. If another user is already host, the backend returns `409` with `room_host_exists`.

```text
POST /api/rooms/current/select-media
```

Requires the app session bearer token and can only be used by the current room host. Body:

```json
{
  "instanceId": "discord_activity_instance_id",
  "itemId": "movie_id",
  "mediaSourceId": "optional_media_source_id",
  "title": "Movie Title",
  "runtimeTicks": 72000000000
}
```

Returns the updated room. Room updates are also broadcast over WebSocket.

## WebSocket Sync

```text
GET /ws?token=short_lived_app_session_jwt&instanceId=discord_activity_instance_id
```

Use `wss://` in production. The `token` query parameter is the same app session JWT returned by `POST /api/discord/exchange`. Connections with a missing, invalid, or expired token are closed. If the room has reached `ROOM_MAX_PARTICIPANTS`, the server sends an error with code `room_full` and closes the new connection.

On connect, the backend sends:

```json
{ "type": "hello_ack", "clientId": "client_id", "serverTs": 1783600000000 }
```

Then it sends the current `room_state` and a `participants_update`. Reconnecting to the same `instanceId` restores the current in-memory room snapshot.

Client messages:

```text
hello
claim_host
select_media
ready
player_event
state_update
ping
leave
```

Malformed JSON and messages that do not match the protocol schema are rejected with an `error` server message. They do not crash the WebSocket server.

Host-only messages:

```json
{
  "type": "player_event",
  "action": "play",
  "positionSeconds": 12.5,
  "ts": 1783600000000
}
```

`action` can be `play`, `pause`, `seek`, `buffering`, or `ended`. Only the current host can send shared playback commands or state updates. Non-host playback commands return an `error` message and do not update room state.

Server playback broadcasts:

```json
{
  "type": "player_event",
  "action": "play",
  "positionSeconds": 12.5,
  "targetServerTs": 1783600001000,
  "serverTs": 1783600000000
}
```

The frontend uses `ping`/`pong` to estimate clock offset, schedules remote player events using `targetServerTs`, and applies soft playback-rate drift correction before falling back to hard seeks for larger drift.

## Playback

Playback routes require:

```text
Authorization: Bearer short_lived_app_session_jwt
```

```text
POST /api/playback/prepare
```

Body:

```json
{
  "itemId": "movie_id",
  "mediaSourceId": "optional_media_source_id",
  "audioStreamIndex": 1,
  "subtitleStreamIndex": 2,
  "maxStreamingBitrate": 20000000
}
```

The backend calls Jellyfin `PlaybackInfo` using the active Jellyfin account for the auth mode. Per-user mode uses the authenticated Discord user's linked Jellyfin token. Shared mode uses the configured shared Jellyfin account. The backend selects an HLS or direct stream, creates a short-lived stream ticket, and returns only a local media proxy URL:

```json
{
  "playback": {
    "itemId": "movie_id",
    "mediaSourceId": "media_source_id",
    "playMethod": "hls",
    "streamUrl": "/media/hls/opaque_ticket/master.m3u8",
    "expiresAt": "2026-07-09T12:05:00.000Z",
    "container": "ts",
    "videoCodec": "h264",
    "audioCodec": "aac"
  }
}
```

The Jellyfin access token is never returned to the browser. The opaque stream ticket expires according to `STREAM_TICKET_TTL_SECONDS` and is rejected when the app session that created it has expired.

## Media Proxy

Media proxy routes use the stream ticket from `POST /api/playback/prepare`. They do not require the app session bearer token because browser video players load playlists and segments directly.

```text
GET /media/hls/:ticket/master.m3u8
GET /media/hls/:ticket/asset?u=/Videos/...
```

The HLS master route fetches the Jellyfin playlist server-side and rewrites playlist entries so segments, child playlists, and URI attributes point back through `/media/hls/:ticket/asset`. Rewritten playlists must not expose the Jellyfin access token.

If the ticket is invalid or expired, media routes return:

```json
{
  "error": {
    "code": "stream_ticket_invalid",
    "message": "Stream ticket is invalid or expired."
  }
}
```

```text
GET /media/direct/:ticket/stream
```

Direct mode proxies a Jellyfin direct stream and forwards the browser's `Range` header. This is used when `STREAM_PROXY_MODE=direct`, or as a direct-stream path for supported media sources.
