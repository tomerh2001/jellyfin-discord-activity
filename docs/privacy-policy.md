# Jellyfin Discord Activity Privacy Policy

Effective date: September 8, 2026

This policy covers the private community Jellyfin Discord Activity operated by **tomerh2001** for **tomer's community**. For privacy questions or requests, contact **tomerh2001 on Discord**. Other operators of this open-source project are responsible for their own deployments and policies.

## Information used

The Activity processes the information needed to authorize access, show participants, browse the permitted Jellyfin library, and synchronize playback:

- Discord user ID, username, display name and avatar reference; server, channel and Activity instance IDs; current Activity participants and the command caller's voice-channel membership.
- Discord authorization codes and access tokens, signed proxy and command payloads, temporary application sessions, and temporary media-access tickets. Context-menu interactions may include information about the selected message or user; the application does not use selected message text to choose media or retain a message-history archive.
- Library searches, media identifiers and titles, selected audio/subtitle tracks, playback position and state, host identity, and connection/update timestamps.
- Operational and security logs, including request paths and query parameters, available connection/IP information, timestamps, response status, errors and playback metadata. Search terms and room/media identifiers can appear in these logs. The application redacts configured credential fields and media-ticket URLs.

This deployment uses a dedicated shared Jellyfin account restricted to its permitted libraries. It does not ask participants for their personal Jellyfin password. The operator's shared account credentials and encrypted Jellyfin access token are kept on the server. The Activity does not record voice conversations, capture screens, or read channel message history. It has no advertising or marketing analytics integration.

## Use and disclosure

Participant names, avatar references, presence, host status and shared playback state are shown to other participants in the same watch room.

Discord processes authentication, Activity launches, commands and proxied Activity traffic. Cloudflare handles the service's public proxy, network delivery and security. The operator's Jellyfin server receives library and streaming requests under the shared account and may keep its own session and server logs. The operator can access application data and logs for administration, support and security. GitHub hosts these policy documents and the public source code; visiting GitHub is subject to its own privacy policy.

These providers have their own practices: [Discord](https://discord.com/privacy), [Cloudflare](https://www.cloudflare.com/privacypolicy/) and [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). This policy covers the operator's Activity, not those providers' independent services.

## Storage and retention

Application sessions normally remain valid for up to eight hours. Logging out revokes the session and associated media access; expired or revoked sessions cannot authorize new requests. Profile records and inactive session/ticket objects can remain in server memory until cleanup or a restart. The Activity keeps its browser session in memory rather than its own persistent browser storage.

Room snapshots are written to server storage so playback can recover after a restart. They include room/server/channel IDs, host ID when assigned, media selection, playback state and timestamps. While the service runs, rooms without connected participants are eligible for automatic removal after approximately 15 minutes without an update. Saved rooms restore paused and without a host.

Shared Jellyfin credentials and account records remain until the operator replaces or removes them. Application log files have no automatic age-based deletion schedule in the current implementation; they require operator cleanup. Removing the app, closing the Activity or logging out does not automatically erase logs or saved copies. Infrastructure backups and provider logs may retain copies separately; this application does not set their retention schedules.

## Your choices and requests

You can stop using the Activity, log out, and revoke its authorization in Discord. To request access to, correction of, or deletion of your Activity data, contact **tomerh2001 on Discord** with your Discord account and request. The operator may need to verify that the request concerns your account. Deletion requests require operator action; the app has no automatic account-deletion feature. Contact the relevant provider for data it controls independently.

This page will be updated when the service's data practices change. Its effective date identifies the current version.
