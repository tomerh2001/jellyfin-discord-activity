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
| GET `/api/party` | Current Activity's native group binding |
| POST `/api/party` | Bind/change the Activity to `{connectionId}` |
| POST `/api/native/launch` | Create a viewer gateway with `{connectionId,deviceId}` |
| POST `/api/discord/interactions` | Independently signed Discord commands |

`GET /api/connections` returns `defaultServerUrl` for the user-facing login address and `canonicalDefaultServerUrl` for matching the default server against saved connections and party metadata. These differ only when the operator configured `JELLYFIN_PUBLIC_SERVER_URL`; the canonical URL remains the approved upstream destination.

`/api/discord/resume` uses `Authorization: Bearer <discordOAuthAccessToken>`, not an app token. Its JSON body is `{instanceId,userId,guildId?,channelId?}`. The backend verifies the OAuth grant's application, `identify` scope and expiration through Discord, confirms the current user independently, and checks the own application's live Activity instance, participant list, channel/guild and allowlist. A claimed identity or an expired app token alone cannot recover access. This route retains ingress authentication and returns private/no-store responses.

Successful recovery returns the same response shape as exchange: `{appToken,discordAccessToken,user,expiresAt}`. The parent uses only the OAuth token already held in document memory and does not repeat SDK authorization/authentication on its authenticated connection. Concurrent rejected requests share one recovery attempt; failed proof grants no session. Leave disables automatic recovery and revokes a late session if recovery completes after disposal. Old server sessions or native queues are not restored from storage.

`/api/native/launch` returns opaque gateway credentials for a source/origin/nonce-checked message to the bundled client. It does not return the Jellyfin access token. `/jf/<capability>/…` proxies allowed native APIs, artwork, playlists and media; `/jf/<capability>/socket` bridges the native Jellyfin WebSocket. Every capability is tied to a live app session and a specific party/viewer. It is a bearer credential and must be excluded from logs.

The gateway replaces user, device and authentication identifiers, limits group discovery/join to the bound SyncPlay group, denies administration and arbitrary remote control, and rewrites all upstream media URLs below its validated base path. There is no separate custom playback WebSocket protocol.
