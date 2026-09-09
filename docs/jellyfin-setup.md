# Jellyfin connections

The bundled native client is pinned to Jellyfin Web12.0. It uses the upstream Legacy layout to retain native playback and watch-party controls. Server URLs are generic; test compatibility before changing the client pin or server major version.

Jellyfin12 disables legacy authentication by default. The broker uses the supported `Authorization: MediaBrowser ...` header for password login, Quick Connect, authenticated API requests and WebSocket upgrades. Keep legacy authentication disabled.

## Personal accounts

Each Discord user supplies a Jellyfin server URL and username/password inside the Activity, or uses Quick Connect. The password is sent to that Jellyfin server once and is not saved. Quick Connect codes are approved in an existing Jellyfin session; its temporary secret stays on the backend and is bound to the requesting Discord session.

Encrypted tokens and server/user identities are stored in `/data/jellyfin-connections.sqlite`. A saved connection belongs to a Discord account and a normalized server URL. Preferred selections are saved separately per Discord server. Restoration verifies the Jellyfin server's identity and account before use. **Disconnect** removes the connection, cancels its active viewers and attempts to revoke the upstream token.

New participants join the current party's server. A saved preference cannot replace an existing party. Each participant uses their own account and permissions; library, item and media-source checks precede playback. Selecting a queue requires access for all connected viewers. Different Jellyfin instances do not have interchangeable item IDs.

## Allowed URLs

Set `JELLYFIN_ALLOW_CUSTOM_SERVERS=true` to accept public HTTPS Jellyfin servers. DNS answers are checked and connections pin the approved IP to prevent rebinding. URLs cannot contain credentials, query strings or fragments; redirects are rejected. Supply the Jellyfin base URL, including a configured base path, without `/web`.

`JELLYFIN_DEFAULT_SERVER_URL` is the sole operator-approved exception for private or HTTP servers, for example `http://jellyfin:8096`. Disabling custom servers restricts connections to that exact URL. It never silently sends submitted credentials to a different server.

## Optional community account

`JELLYFIN_AUTH_MODE=shared`, a dedicated `JELLYFIN_SHARED_USERNAME`, and a protected `JELLYFIN_SHARED_PASSWORD_FILE` offer **Use community account** to participants in explicitly allowed Discord servers. Personal login remains available. Community connections are scoped to their Discord user and guild.

Use a non-administrator account with only the intended libraries and playback/transcoding permissions. Community viewers share Jellyfin watch history and preferences. Separate native device/session identities keep SyncPlay participants distinct even when their underlying Jellyfin account is the same.

## Native playback

The app serves a pinned build of official Jellyfin Web; it never embeds an arbitrary instance's JavaScript. The native player negotiates direct play, remuxing or transcoding for each device. Jellyfin's native SyncPlay owns play/pause/seek and the episode queue. Audio, subtitle, volume and quality controls stay local. Automatic segment skipping is changed to an explicit skip prompt so one viewer's saved preference does not unexpectedly seek everyone.

SyncPlay itself allows authorized Jellyfin users outside Discord to discover and join groups. The Activity gateway restricts its own clients to their party but cannot make a native Jellyfin group Discord-exclusive without a server-side Jellyfin extension. Party groups expire when their viewers leave; there is no persistent playback timeline after an Activity or service restart.
