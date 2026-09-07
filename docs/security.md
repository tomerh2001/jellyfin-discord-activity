# Security

- Production accepts browser, API, media, and WebSocket requests only with a valid Discord Activity proxy signature. Direct requests to the origin are denied even with a spoofed Discord referrer or source-IP header.
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

## Discord Activity ingress

With `NODE_ENV=production`, the signed proxy gate is mandatory and cannot be disabled by setting `DISCORD_REQUIRE_PROXY_AUTH=false`. The flag enables the same gate in development/test environments. The gate uses the existing application's `DISCORD_PUBLIC_KEY`; no shared secret is sent to the frontend.

Discord's [proxy authentication protocol](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience#validating-proxy-request-headers) sends `X-Discord-Proxy-Payload` (base64), `X-Signature-Ed25519`, and `X-Signature-Timestamp`. The verifier checks the Ed25519 signature over the decoded payload bytes, the timestamp's exact match to `created_at`, a bounded future clock skew, and `expires_at`. Invalid encodings and payloads fail closed. Discord's JavaScript sample encodes the signature as base64 while its Python sample uses hex; this implementation strictly accepts either representation of a 64-byte signature.

The published protocol signs a reusable token, **not the request method, URL, body, or a unique nonce**. A captured valid token can therefore be reused until it expires. This gate is additional protection, not proof that an HTTP client is physically inside Discord. OAuth identity, allowed server/user checks, active-instance verification, session expiry and host authorization remain required for all library and playback access. Neither CORS, referrers, client-provided instance IDs nor IP headers count as identity proof.

Only exact `POST /api/discord/interactions` bypasses the proxy-token verifier, because Discord callbacks instead require the existing exact-body interaction signature. A proxy token cannot authenticate an interaction, or vice versa. Exact `GET`/`HEAD /health` is available only to the container's actual loopback TCP peer without forwarded headers; it remains inaccessible through the public proxy. `/api/health` follows normal proxy authentication.

The gate runs before CORS, request-body parsing, static handling and the WebSocket handshake. Register the WebSocket plugin first so its request bookkeeping and rejected-upgrade cleanup hooks are installed; authentication still runs before the upgrade handler. A real TCP upgrade regression test covers both rejection and acceptance, including closing refused sockets cleanly.

Every gated HTTP response sends `Cache-Control: private, no-store` and CDN-specific no-store headers, including frontend assets, so a shared cache cannot serve previously authorized responses without checking credentials. Keep a hostname-wide cache bypass at Cloudflare and preserve the signature headers through the tunnel/reverse proxy. Never log proxy tokens or signatures. This application does not rely on a shared Discord egress-IP allowlist.

Before opening public ingress, launch the Activity through the configured Discord URL mapping and verify that real requests carry valid proxy headers; the documentation does not describe a portal toggle or promise per-request header availability for every launch context. If headers are absent, the service will deny access. Do not disable the gate to make an unverified launch work.
