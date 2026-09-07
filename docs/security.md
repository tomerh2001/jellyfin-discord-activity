# Security

- Do not expose Discord client secrets or Jellyfin tokens in the browser bundle.
- Use HTTPS/WSS in production.
- Generate all session and token encryption secrets with at least 32 bytes of entropy.
- Prefer `JELLYFIN_AUTH_MODE=per-user` when you want Jellyfin permissions enforced separately for each Discord user.
- Use `JELLYFIN_AUTH_MODE=shared` only for trusted/private deployments where every authenticated Discord user should receive the same Jellyfin access.
- In shared mode, create a dedicated Jellyfin user such as `discord-watch`, do not make it an administrator, and grant it access only to libraries intended for Discord viewing.
- Do not use your personal Jellyfin admin account as the shared account. Every Discord user who can authenticate to the Activity can browse and prepare media visible to the shared Jellyfin user.
- Set `TOKEN_ENCRYPTION_KEY` to a base64-encoded 32-byte key before linking Jellyfin accounts in production.
- Per-user Jellyfin passwords are not stored. Shared-mode `JELLYFIN_SHARED_PASSWORD` is read from the backend environment and should be protected like any other server secret.
- Jellyfin access tokens are encrypted before being written under `/data`.
- Stream tickets are bearer URLs for `/media/...`. Default TTL is long enough for feature films (`STREAM_TICKET_TTL_SECONDS=14400`) and slides while the ticket is actively used, but tickets are still capped by the creating app session and should only be served over HTTPS.
- WebSocket sync uses the short-lived app session JWT in the `/ws` query string. Use `wss://` in production and avoid logging query strings at the reverse proxy.
- The backend enforces host-only shared playback commands; participant player events must not mutate room playback state.
- The backend applies an app-wide rate limit. Tune `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW` for your deployment and set `TRUST_PROXY=true` only when the app is behind a trusted reverse proxy.
- Fastify request logs are structured JSON and redact authorization headers, cookies, common token fields, passwords, Discord OAuth codes, `/ws?token=...`, and other sensitive query parameters before writing URLs.
- When `LOG_DIR` is set (Docker default `/data/logs`), the same redacted JSON is appended to `app.log` / `error.log`. Treat that directory as sensitive and do not commit log files.
- Stream tickets are also invalidated when the app session that created them has expired, or has been revoked, even if `STREAM_TICKET_TTL_SECONDS` has not elapsed. In-flight transfers are cancelled on logout and at session expiry.
- Invalid WebSocket payloads return an `invalid_json` or validation error message instead of crashing the room process.
- Rooms without active WebSocket participants are removed after `ROOM_IDLE_TTL_SECONDS`; active rooms are skipped during idle cleanup.
- `DEV_AUTH_MOCK=true` bypasses live Discord OAuth for local development and smoke tests. It must be `false` for public deployments, and the backend only accepts mock users when that flag is enabled.

## Media proxy boundary

Each ticket stores its creating app session ID and a server-side map of opaque HLS asset IDs. The proxy accepts only those IDs, never arbitrary upstream URLs or paths. Manifest rewriting checks the original reference origin before stripping credentials, so external absolute references cannot be silently rebased onto Jellyfin. Nested playlists can issue their own assets within the same ticket.

Authenticated upstream fetches do not follow redirects. Upstream error bodies and Location headers are never returned to clients. Media responses are not cacheable; reverse-proxy access logs must redact or omit `/media/` ticket paths as well as authentication query strings.

Transfers have bounded header, idle-body, and total-duration deadlines. Client disconnection and session revocation cancel both pending fetches and active body streams. Media transfers also renew Discord Activity membership at most once per minute, independently of WebSocket traffic, so a retained stream URL cannot avoid membership checks. Browser buffers can still contain bytes already delivered before cancellation. Selected audio/subtitles use transcoding because a static file response cannot apply those choices.

Regression tests in `apps/api/src/test/mediaSecurity.test.ts` cover arbitrary same-origin API targets, query tampering, cross-ticket assets, nested HLS resources, redirects, ranges, expiry, logout, and streaming cancellation. `playbackCompatibility.test.ts` covers track selection and the VP8/Opus fallback.

## Discord and room authorization

Production startup rejects development authentication, missing allowlists, invalid public keys, and placeholder credentials. Discord OAuth establishes identity; the Bot-authenticated Activity Instance API establishes current membership and the actual channel/guild. An allowlisted user or participant in an allowlisted guild may connect. Every room read, write, and WebSocket hello must match that session's verified Activity context.

Membership renews at most once per minute through authenticated API, WebSocket, or media traffic. Failed verification revokes the session. Logout closes associated sockets and cancels live media transfers. Previously buffered media bytes cannot be recalled.

Slash and context-menu commands require exact-body Ed25519 verification, a five-minute timestamp window, the expected application ID, and an allowed caller. Duplicate interaction IDs reuse their initial response without repeating mutations. Controls verify the caller's current voice channel and Activity membership; only the connected host can change playback. Command responses are ephemeral and disable mentions.

Room snapshots contain selection and playback state, never app sessions. They restore paused and without host ownership. Host departure transfers control to the first remaining connected participant; duplicate tabs do not create duplicate participants or prematurely remove a host.
