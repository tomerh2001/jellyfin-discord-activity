# Security

## Accounts and server access

Discord OAuth identifies the user. The bot-authenticated Activity Instance API verifies this application's instance, participants, guild and channel. Production also requires strong secrets, a server/user allowlist and the ingress proof described below. User-supplied context, referrers and IP headers are not membership proof.

An open Activity may recover a lost app session through `/api/discord/resume` using the Discord OAuth token already held in memory. The backend checks `/oauth2/@me` for this application, `identify` scope and an unexpired grant, independently confirms `/users/@me`, and verifies current Activity membership and the allowlist before issuing a new app token. No cached identity, cookie or browser-storage fallback grants access when those checks fail. The route remains behind ingress proof and returns private/no-store responses. Concurrent failures share one recovery attempt; explicit Leave suppresses recovery and revokes any late completion.

Personal Jellyfin tokens are encrypted in SQLite and scoped to their Discord owner and normalized server identity. Passwords are not stored. Quick Connect approval secrets stay on the backend and are session-bound. Community access requires an explicit selection and an allowed guild; its dedicated non-admin account shares watch history. Disconnecting removes the saved connection and cancels its active viewers before attempting upstream token revocation.

Generic targets require public HTTPS, checked DNS answers and pinned-IP HTTP/WebSocket connections. The only private/HTTP upstream exception is the exact configured default URL. An optional `JELLYFIN_PUBLIC_SERVER_URL` maps an exact normalized HTTPS alias to that same default before any DNS lookup; it does not grant the alias hostname, other paths or other ports private-network access. Account storage and party matching use the canonical destination. Redirects and paths escaping the configured base are rejected. Only the bundled, pinned Jellyfin Web client is served; remote servers cannot supply executable client code through the gateway.

## Native gateway and revocation

Browser credentials are temporary `/jf/<capability>/…` bearer URLs, not upstream tokens. Each capability belongs to a live Discord app session, connection, party and native device. The gateway replaces authentication, user/device/session identifiers, limits routes to supported client operations and checks item/media-source permissions. Administrative and arbitrary remote-control requests are denied. All selected queue items must be accessible to the party's active viewers.

The native client controls playback through Jellyfin SyncPlay. Everyone in the group can control playback; personal volume, tracks and quality are not synchronized. The gateway limits its clients to their bound group. Native Jellyfin users outside Discord may still discover/join that group directly; strict Discord-only group membership would need a Jellyfin server extension.

Activity membership renews at most once per minute during API, WebSocket and media traffic. Failed renewal, logout, expiry and connection removal revoke capabilities and abort sockets and in-flight streams. Already delivered media buffers cannot be recalled. Lost browser sockets explicitly leave SyncPlay so Jellyfin10.11 does not wait indefinitely for a disconnected viewer. A short reconnect grace retains the party; empty groups are removed. Live groups and app sessions are not restored after a service restart.

The bundled client keeps gateway credentials in memory and does not register a service worker. Requests and gateway responses are uncached. Native gateway responses use a sandboxed content security policy and reject executable upstream content. Configure reverse proxies to omit capability paths and authentication query parameters; application logging redacts them, but upstream Jellyfin's own browser diagnostics can include gateway addresses. Never publish raw console/network dumps.

Complete native JSON and rewritten HLS playlists may use Brotli or gzip after credential removal and URL scoping; they remain `no-store`. Compression is explicitly enabled only for these responses, with a 1 KiB threshold and asynchronous compression. Keep the playlist MIME type in the compressor's explicit type list: its MIME database does not identify `application/vnd.apple.mpegurl` as compressible. Broker credentials, binary media, range requests, HEAD responses and non-200 statuses bypass compression; incoming request decompression remains disabled. Regression checks must decode the actual compressed bytes and compare them with the sanitized uncompressed response.

**Leave watch party** waits for successful session revocation, removes the player, then closes the Discord Embedded SDK connection normally. The voice call remains connected. A failed revocation can be retried; a fresh `/watch` launch creates the next authenticated RPC session.

Discord command callbacks require exact-body Ed25519 verification, a bounded timestamp, the expected application and an allowed caller. Duplicate interaction IDs reuse the initial response. The primary entry point uses the app handler and returns only a launch response; it does not post an automatic invitation. Playback commands additionally verify current voice channel, authoritative Activity membership and the caller's live native player. Selection menus include the party binding ID so stale results cannot change a new group. Playback responses are ephemeral and disable mentions.

The connection, native-gateway and Discord security test suites cover URL/DNS/redirect isolation, stored-token ownership, Quick Connect, native authorization, real WebSocket upgrades, queue permissions, logout/expiry and stream cancellation.

## Discord Activity ingress

With `NODE_ENV=production`, the ingress gate is mandatory and cannot be disabled by setting `DISCORD_REQUIRE_PROXY_AUTH=false`. The flag enables the same gate in development/test environments. `DISCORD_PROXY_AUTH_MODE` selects exactly one proof mechanism; there is no automatic fallback. Unknown mode values fail startup. Neither mechanism replaces user, guild or Activity-instance authorization.

### Discord signatures (default)

`DISCORD_PROXY_AUTH_MODE=signature` uses the application's `DISCORD_PUBLIC_KEY` and does not need a shared origin secret.

Discord's [proxy authentication protocol](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience#validating-proxy-request-headers) sends `X-Discord-Proxy-Payload` (base64), `X-Signature-Ed25519`, and `X-Signature-Timestamp`. The verifier checks the Ed25519 signature over the decoded payload bytes, the timestamp's exact match to `created_at`, a bounded future clock skew, and `expires_at`. Invalid encodings and payloads fail closed. Discord's JavaScript sample encodes the signature as base64 while its Python sample uses hex; this implementation strictly accepts either representation of a 64-byte signature.

The published protocol signs a reusable token, **not the request method, URL, body, or a unique nonce**. A captured valid token can therefore be reused until it expires. This gate is additional protection, not proof that an HTTP client is physically inside Discord. OAuth identity, allowed server/user checks, active-instance verification, session expiry and party authorization remain required for all library and playback access. Neither CORS, referrers, client-provided instance IDs nor IP headers count as identity proof.

Some Discord launch paths do not deliver the optional signature headers. In September 2026, this deployment observed absent headers for both direct type-12 slash/context-menu launches and a normal App Launcher launch that had successfully obtained a proxy ticket. The client omitted the ticket in the direct command flow, but ticket presence alone did not establish header delivery. Verify actual iframe, asset, API and WebSocket requests rather than assuming a ticket or a launch path guarantees signatures. Missing signatures are denied in this mode.

### Cloudflare Worker attestation

`DISCORD_PROXY_AUTH_MODE=cloudflare-worker` supports deployments whose Discord launch flow lacks signed proxy headers. This mode requires all of the following edge controls before activation:

1. Match only the Activity hostname and Cloudflare's authoritative `cf.worker.upstream_zone eq "discordsays.com"` field. The ordinary `CF-Worker` HTTP header is not proof and must never be used as the security condition.
2. For that verified Worker traffic, a request-header Transform Rule must **overwrite** `x-jellyfin-discord-edge` with a secret shared only by this application's origin and the trusted Cloudflare configuration. A complementary rule must remove the header from all other traffic to this hostname, including client-supplied copies.
3. An exact-host WAF rule must block nonmatching Worker traffic, with only exact `POST /api/discord/interactions` excepted for Discord's independently signed callbacks. Preserve existing security rules. Do not cache this hostname, including HTML and assets.
4. Set `DISCORD_PROXY_EDGE_SECRET` or `DISCORD_PROXY_EDGE_SECRET_FILE` at the origin to the same secret. Generate at least 32 cryptographically random bytes, encoded as 64 hex characters or unpadded base64url. Startup rejects missing, short, malformed or obviously weak values. The verifier compares fixed-length SHA-256 digests with `timingSafeEqual`; duplicate/altered headers are rejected. The secret and header are redacted in application logs and must not be exposed to the browser, source repository, response headers or diagnostic output.

See Cloudflare's [Worker zone field](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.worker.upstream_zone/) and [CF-Worker header guidance](https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#cf-worker). This attestation proves traversal of the configured trusted Discord Worker, not which Discord user or application instance sent the request. The backend still verifies its own application's OAuth identity, active-instance users and allowed guild before granting library, room or media access. A captured origin secret would weaken this ingress layer until rotated; keep it restricted and rotate the edge and origin values together.

Before activating this mode, verify that genuine Discord traffic receives a header matching the secret without printing either value. Then confirm direct and forged-`CF-Worker` requests are blocked, the origin rejects absent/wrong secrets, signed interactions still work, and real WebSocket upgrades and media requests retain both ingress and application authorization.

### Shared invariants

Only exact `POST /api/discord/interactions` bypasses the selected ingress verifier, because Discord callbacks instead require the existing exact-body interaction signature. An edge secret or proxy token cannot authenticate an interaction, or vice versa. Exact `GET`/`HEAD /health` is available only to the container's actual loopback TCP peer without forwarded headers; it remains inaccessible through the public proxy. `/api/health` follows normal ingress authentication.

The gate runs before CORS, request-body parsing, static handling and the WebSocket handshake. Register the WebSocket plugin first so its request bookkeeping and rejected-upgrade cleanup hooks are installed; authentication still runs before the upgrade handler. A real TCP upgrade regression test covers both rejection and acceptance, including closing refused sockets cleanly.

Every gated HTTP response sends `Cache-Control: private, no-store` and CDN-specific no-store headers, including frontend assets, so a shared cache cannot serve previously authorized responses without checking credentials. Keep a hostname-wide cache bypass at Cloudflare and preserve the configured proof headers through the tunnel/reverse proxy. Never log proxy tokens, signatures or origin secrets. This application does not rely on a shared Discord egress-IP allowlist.
