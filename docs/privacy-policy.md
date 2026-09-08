# Jellyfin Discord Activity Privacy Policy

Effective date: September 8, 2026

This policy covers the private community Jellyfin Discord Activity operated by **tomerh2001** for **tomer's community**. For privacy questions or requests, contact **tomerh2001 on Discord**. Other operators of this open-source project are responsible for their own deployments and policies.

## Information used

The Activity processes the information needed to authorize access, show participants, browse the permitted Jellyfin library, and synchronize playback:

- Discord user ID, username, display name and avatar reference; server, channel and Activity instance IDs; current Activity participants and the command caller's voice-channel membership.
- Discord authorization codes and access tokens, signed proxy and command payloads, temporary application sessions, and temporary native-player gateway credentials. Context-menu interactions may include information about the selected message or user; the application does not use selected message text to choose media or retain a message-history archive.
- Library searches, media identifiers and titles, selected audio/subtitle tracks, playback position and state, and connection/update timestamps.
- Operational and security logs, including request paths and query parameters, available connection/IP information, timestamps, response status, errors and playback metadata. Search terms and room/media identifiers can appear in these logs. The application redacts configured credential fields and gateway credential URLs.

Participants may connect a personal Jellyfin account by supplying its server URL and credentials or by approving Quick Connect. Personal passwords are used for authentication and are not saved. Encrypted access tokens, Jellyfin server/user identities and per-Discord-server preferred connections are saved on the backend. This deployment also offers an explicit dedicated community account restricted to its permitted libraries; its users share watch history and account preferences.

The Activity does not record voice conversations, capture screens, or read channel message history. It has no advertising or marketing analytics integration.

## Use and disclosure

Participant names, avatar references, presence and shared playback state are shown to other participants in the same watch room.

Discord processes authentication, Activity launches, commands and proxied Activity traffic. Cloudflare handles the service's public proxy, network delivery and security. Each connected Jellyfin server receives library, SyncPlay and streaming requests under the selected account and may keep its own history, session and server logs. Authorized Jellyfin users outside Discord can discover and join native SyncPlay groups directly. The operator can access application data and logs for administration, support and security. GitHub hosts these policy documents and the public source code; visiting GitHub is subject to its own privacy policy.

These providers have their own practices: [Discord](https://discord.com/privacy), [Cloudflare](https://www.cloudflare.com/privacypolicy/) and [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). This policy covers the operator's Activity, not those providers' independent services.

## Storage and retention

Application sessions normally remain valid for up to eight hours. Logging out revokes the session and associated media access; expired or revoked sessions cannot authorize new requests. Profile records and inactive session/ticket objects can remain in server memory until cleanup or a restart. The Activity keeps its browser session in memory rather than its own persistent browser storage.

Saved Jellyfin connections and preferred selections remain until disconnected or removed by the operator. **Disconnect** deletes that connection, cancels active viewers and attempts to revoke its Jellyfin token. Native groups and live application sessions are held in memory and are not restored after a service restart. Disconnected viewers leave SyncPlay; empty Activity groups are cleaned up after a short grace period.

Configured community credentials remain until the operator replaces or removes them. Application log files have no automatic age-based deletion schedule in the current implementation; they require operator cleanup. Removing the app, closing the Activity or logging out does not automatically erase logs or saved copies. Infrastructure backups and provider logs may retain copies separately; this application does not set their retention schedules.

## Your choices and requests

You can stop using the Activity, log out, and revoke its authorization in Discord. To request access to, correction of, or deletion of your Activity data, contact **tomerh2001 on Discord** with your Discord account and request. The operator may need to verify that the request concerns your account. Deletion requests require operator action; the app has no automatic account-deletion feature. Contact the relevant provider for data it controls independently.

This page will be updated when the service's data practices change. Its effective date identifies the current version.
