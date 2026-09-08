# Discord setup

Use a dedicated Discord application for this Activity. Its normal bot token verifies room membership and supports commands through HTTP interactions; no Gateway connection or privileged intent is needed.

## Developer Portal

Create an application at [Discord Developer Portal](https://discord.com/developers/applications), then configure:

| Portal setting | Value |
| --- | --- |
| General Information → Application ID | `DISCORD_CLIENT_ID` and `PUBLIC_DISCORD_CLIENT_ID` |
| General Information → Public Key | `DISCORD_PUBLIC_KEY` |
| OAuth2 → Client Secret | Backend `DISCORD_CLIENT_SECRET` or its `_FILE` setting |
| Bot → Token | Backend `DISCORD_BOT_TOKEN` or its `_FILE` setting |
| OAuth2 → Redirects | Placeholder `https://127.0.0.1` |
| Activities | Enabled for Web, iOS and Android |
| Activities → URL Mappings | Prefix `/`, target `watch.example.com` (no scheme) |
| Installation → Installation Contexts | Guild Install |
| Installation → Default Install Settings | Scopes `bot`, `applications.commands`; permissions View Channels and Connect (`1049600`) |
| General Information → Interactions Endpoint URL | `https://watch.example.com/api/discord/interactions` |

The OAuth redirect is a Developer Portal placeholder, as described in Discord's [Activity setup guide](https://docs.discord.com/developers/activities/building-an-activity#add-a-redirect-uri). The Embedded App SDK handles authorization and returns a code directly to the Activity; this app does not use a browser callback route. Its backend exchanges SDK codes without a `redirect_uri`, matching Discord's [official Activity server example](https://github.com/discord/embedded-app-sdk-examples/blob/main/discord-activity-starter/packages/server/src/app.ts). The SDK requests only `identify`; guild and voice checks use the dedicated bot token. `DISCORD_REDIRECT_URI` only validates an explicitly supplied redirect for a separately implemented authorization flow; it is not inserted into Activity exchanges.

Replace the example hostname everywhere. The Interaction endpoint must be reachable by Discord and correctly answer its signed PING before the portal will save it. Every request is verified against the app's Ed25519 public key; stale or altered requests are rejected.

Keep privileged intents disabled. The bot needs Connect permission in each target voice channel so Discord permits the voice-state lookup; it does not join or send voice audio. Watchers need View Channel, Connect, Use Activities, and Use Application Commands in the voice channel. Installers need Manage Server. Administrator permission is unnecessary.

Activity availability can depend on Discord's development/distribution status. During development, enable Developer Mode and use the developer Activity launcher; add testers through the application's team/testing controls if Discord restricts access. Broader distribution must satisfy the current [Activity setup requirements](https://docs.discord.com/developers/activities/building-an-activity).

## Restrict library access

Set `DISCORD_ALLOWED_GUILD_IDS` to the comma-separated server IDs permitted to use this Jellyfin library. Optionally set `DISCORD_ALLOWED_USER_IDS` for named users. These are alternatives: a user listed explicitly **or** an actual participant in a listed server can access the app. Leaving both empty is invalid in production.

Copy IDs using Discord Settings → Advanced → Developer Mode. Room identity is checked against Discord's [Activity Instance API](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience), including its `users` list, application, guild, and channel. Browser-supplied room IDs do not grant access.

## Install and register commands

Use the Installation page's link, or substitute the Application ID in:

```text
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot%20applications.commands&permissions=1049600&integration_type=0
```

Select your server and authorize. Register commands after installation:

```bash
# Standard compose service name:
docker compose exec app node apps/api/dist/registerCommands.js SERVER_ID

# Home-server stack service name:
docker compose exec jellyfin-discord-activity node apps/api/dist/registerCommands.js SERVER_ID
```

With no server ID, the script registers globally and preserves Discord's auto-created Activity entry point. Guild registration is useful for immediate testing. The script replaces this application's command list in the selected scope; use a dedicated application.

## Start watching

1. Join a voice channel and open its text chat.
2. Run `/watch`, or right-click a user/message → Apps → Watch Jellyfin.
3. Authenticate inside the Activity. Other viewers join the same running Activity.
4. Connect a personal Jellyfin account or explicitly choose the available community account.
5. Browse native Jellyfin and play a title. Friends join the running Activity and its SyncPlay group. A phone may need one tap to enable audio.
6. Test playback, pause/seek, next/previous episode, personal tracks and reconnects with two people.

`/jellyfin play query:...` searches movies and episodes and offers a selection menu for multiple results. `pause`, `resume`, `seek seconds:...`, `next`, `previous`, `stop` and `now` operate through the caller's live native player. Commands find the caller's voice channel even when issued elsewhere in the same server. Use **Invite friends** to open Discord's native invite dialog; channel permissions still apply.

Enable each mobile platform separately and test the actual iOS and Android Discord clients. Responsive browser tests do not establish operating-system fullscreen, background, picture-in-picture or codec behavior.

## Networking checks

All browser API, WebSocket, artwork, and media requests must remain on the Activity's mapped origin. The backend reaches Jellyfin privately. Add `https://APPLICATION_ID.discordsays.com` to `ALLOWED_ORIGINS` alongside your public origin. WebRTC is not used; Discord's Activity proxy supports WebSockets and HTTP media.

An edge login page can prevent Discord's iframe, media requests, or signed webhook verification from reaching the app. Existing Authentik protection must remain in place unless the operator explicitly approves an exact exception. Do not treat a successful standalone browser login as a working Activity test.

Official references: [networking](https://docs.discord.com/developers/activities/development-guides/networking), [launch actions](https://docs.discord.com/developers/activities/development-guides/user-actions), [interactions](https://docs.discord.com/developers/interactions/receiving-and-responding), [voice state API](https://docs.discord.com/developers/resources/voice).
