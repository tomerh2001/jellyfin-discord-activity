# API and native gateway

Application API requests require `Authorization: Bearer <appToken>` after Discord OAuth and authoritative Activity-instance verification. Production also requires the configured ingress proof. Never put real Jellyfin tokens in browser requests.

| Route | Purpose |
| --- | --- |
| GET `/api/config` | Public application ID and origin, behind ingress proof |
| POST `/api/discord/exchange` | Exchange an SDK code and validate instance membership |
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

`/api/native/launch` returns opaque gateway credentials for a source/origin/nonce-checked message to the bundled client. It does not return the Jellyfin access token. `/jf/<capability>/…` proxies allowed native APIs, artwork, playlists and media; `/jf/<capability>/socket` bridges the native Jellyfin WebSocket. Every capability is tied to a live app session and a specific party/viewer. It is a bearer credential and must be excluded from logs.

The gateway replaces user, device and authentication identifiers, limits group discovery/join to the bound SyncPlay group, denies administration and arbitrary remote control, and rewrites all upstream media URLs below its validated base path. There is no separate custom playback WebSocket protocol.
