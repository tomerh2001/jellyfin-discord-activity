# API and native gateway

Account, party and native-launch API requests require `Authorization: Bearer <appToken>` after Discord OAuth and authoritative Activity-instance verification. Config, initial exchange, session recovery and signed interactions use the authentication described below. Production also requires the configured ingress proof, except for the independently signed interaction endpoint. Never put real Jellyfin tokens in browser requests.

| Route | Purpose |
| --- | --- |
| GET `/api/config` | Public application ID and origin, behind ingress proof |
| POST `/api/discord/exchange` | Exchange an SDK code and validate instance membership |
| POST `/api/discord/resume` | Verify an existing in-memory Discord OAuth bearer and issue a fresh app session |
| GET `/api/me` | Current Discord identity/session |
| POST `/api/logout` | Revoke app session, sockets and active streams |
| GET `/api/connections` | Saved connection metadata, preferred selection and community availability |
| POST `/api/connections` | Connect `{serverUrl,username,password}` |
| POST `/api/connections/community` | Explicitly connect the configured community account |
| PUT `/api/connections/preference` | Save `{connectionId}` for this user/guild |
| DELETE `/api/connections/:id` | Disconnect and attempt upstream token revocation |
| POST `/api/connections/quick-connect` | Start Quick Connect with `{serverUrl}` |
| POST `/api/connections/quick-connect/:id/poll` | Check approval for the same app session |
| GET `/api/party` | Current Activity watch-party binding |
| POST `/api/party` | Bind/change the Activity to `{connectionId}` |
| POST `/api/native/launch` | Create a viewer gateway with `{connectionId,deviceId}` |
| POST `/api/discord/interactions` | Independently signed Discord commands |

`GET /api/connections` returns `defaultServerUrl` for the user-facing login address and `canonicalDefaultServerUrl` for matching the default server against saved connections and party metadata. These differ only when the operator configured `JELLYFIN_PUBLIC_SERVER_URL`; the canonical URL remains the approved upstream destination.

`/api/discord/resume` uses `Authorization: Bearer <discordOAuthAccessToken>`, not an app token. Its JSON body is `{instanceId,userId,guildId?,channelId?}`. The backend verifies the OAuth grant's application, `identify` scope and expiration through Discord, confirms the current user independently, and checks the own application's live Activity instance, participant list, channel/guild and allowlist. A claimed identity or an expired app token alone cannot recover access. This route retains ingress authentication and returns private/no-store responses.

Successful recovery returns the same response shape as exchange: `{appToken,discordAccessToken,user,expiresAt}`. The parent uses only the OAuth token already held in document memory and does not repeat SDK authorization/authentication on its authenticated connection. Concurrent rejected requests share one recovery attempt; failed proof grants no session. Leave disables automatic recovery and revokes a late session if recovery completes after disposal. Live server sessions and party timelines are not restored after a service restart. Renderer handoff retains the live party snapshot during its reconnect grace.

`/api/native/launch` returns opaque gateway credentials for a source/origin/nonce-checked message to the bundled client. It does not return the Jellyfin access token. `/jf/<capability>/…` proxies allowed native APIs, artwork, playlists and media; `/jf/<capability>/socket` bridges the native Jellyfin WebSocket. Every capability is tied to a live app session and a specific party/viewer. It is a bearer credential and must be excluded from logs.

The gateway replaces user, device and authentication identifiers, denies administration, arbitrary remote control and all upstream SyncPlay routes/events, and rewrites upstream media URLs below its validated base path. Native library notifications and playback reporting retain the Jellyfin WebSocket; Activity playback messages use that same authorized socket.

## Activity playback protocol

GET `/jf/:capability/Activity/Playback` returns `{snapshot,clientId,sequence}`. POST to the same route accepts one command and returns the same state with `ack`; it requires an already connected participant. Normal controls send `{MessageType:"ActivityPlaybackCommand",Data:command}` on `/jf/:capability/socket`. The server sends `ActivityPlaybackState` with that state envelope on connect and accepted changes. Duplicate retries receive an acknowledgement without broadcasting another mutation. A rejected command produces `ActivityPlaybackError` with `{id?,code,snapshot?,clientId,sequence?}`. HTTP errors contain `{error:{code,message},snapshot?,clientId?,sequence?}`; a revoked or newly denied account receives no snapshot.

The state envelope's `clientId` is the server-bound viewer device, and `sequence` is that viewer's consumed sequence high-water mark, including rejected intents. A recreated client resumes above it. `snapshot` contains `{epoch,revision,queueRevision,queue,index,positionTicks,paused,repeatMode,serverTimeMs,command?}`. Queue entries are `{id,itemId}`: entry IDs are unique even when the same media item occurs twice. `command`, when present, identifies the last accepted `{id,clientId,sequence}`. `positionTicks` is projected to `serverTimeMs`, not the timestamp at which the command arrived.

Every command includes `{type,epoch,id,sequence,expectedQueueRevision,issuedAt}`. `issuedAt` is the client's estimate of server milliseconds; clients estimate the offset using the snapshot request's round-trip midpoint. The coordinator rejects intent older than ten seconds, clamps future timestamps to now and compensates at most five seconds of transit. Positions use integer Jellyfin ticks and are bounded to seven days.

| Command type | Additional fields |
| --- | --- |
| `setQueue` | `queue`, `index`, `positionTicks`, `paused` |
| `enqueue` | Nonempty `queue` to append |
| `setPlayback` | `paused`, optional sampled `positionTicks` |
| `seek` | `positionTicks`, `paused` |
| `select` | Exact `queueItemId`, `positionTicks`, `paused` |
| `stop` | None; clears the queue |
| `setRepeatMode` | `repeatMode`: `RepeatNone`, `RepeatOne` or `RepeatAll` |

Requests and incoming WebSocket frames are bounded to 64 KiB and queues to 500 entries. Every accepted mutation increments `revision`; queue edits, stop, changes to repeat mode, and every explicit selection/restart increment `queueRevision`. This rejects duplicate simultaneous Next/Previous or repeat-one end events against the old selection generation. Repeat mode belongs to the party and remains selected through queue replacement or stop. A command ID can be retried only with the identical payload; a conflicting ID, old sequence, epoch or queue revision is rejected. Histories retain 256 results per actor. WebSocket connections permit at most 64 pending playback operations while permission checks run.

Discord playback commands use the same coordinator with a separate server-assigned actor sequence. Buffering, native Ready/Ping messages and upstream SyncPlay never alter its timeline. Account changes revoke the old capability; disconnected viewers rejoin the current snapshot without replaying old commands.
