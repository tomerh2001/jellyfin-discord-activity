<img src="apps/activity-web/public/branding/jellyfin-watch-icon.png" alt="Jellyfin Watch" width="96" height="96" />

# Jellyfin Watch

Watch Jellyfin together in a Discord call using the official Jellyfin Web interface and native SyncPlay. The Activity adds Discord authentication, saved Jellyfin connections, participant visibility and a protected gateway around the native client.

Jellyfin Web is the Activity document. Discord authentication, native sign-in, library browsing and playback run in that same document. The existing Jellyfin SyncPlay button opens **Watch party** in the native header and video controls.

## Watch together

1. Join a voice channel and open **Jellyfin Watch** from that call's **Activities** menu. You can also run `/watch` or use **Apps → Watch Jellyfin** on a user/message inside that voice channel's text chat.
2. Use Jellyfin's native login page to enter your server URL and sign in, or explicitly choose the community user where configured. Your connection is remembered for your Discord account, with a preferred connection for each Discord server.
3. Browse Jellyfin normally and play a movie, episode or series. Friends join the running Discord Activity, connect their own account to the same Jellyfin server, and join its SyncPlay group automatically.
4. Use Jellyfin's player and queue to pause, seek, skip to the next/previous episode, change the title, or add something to play next. Use Discord's native invite or Join Activity controls to bring friends into the same session.

The native **Watch party** button shows the people in this Activity, with live join and leave updates. Use Jellyfin's native **Sign out** to return to login and switch between personal and community accounts. To use a different server, start another Activity. Joining an existing party requires an account on its current server; a saved preference never replaces another viewer's party automatically.

Playback and the queue are shared. Volume, audio track, subtitles and quality belong to each viewer. Every viewer needs permission to watch the selected content. An operator may also offer a clearly labelled **community account** with shared watch history; personal accounts remain available.

| Discord command | Behavior |
| --- | --- |
| `/watch` or Apps → Watch Jellyfin | Open the Activity in the channel where invoked |
| `/jellyfin play query:…` | Find and play a movie or episode |
| `/jellyfin pause` / `resume` | Pause or resume the native group |
| `/jellyfin seek seconds:…` | Seek the group |
| `/jellyfin next` / `previous` | Move through the native queue |
| `/jellyfin stop` | Stop group playback |
| `/jellyfin now` | Show the native player's current title and position |

Starting from a different text channel creates a party in that channel; it does not move to your voice call. Friends must join the same running Activity to share playback. Launching does not post an invitation automatically after the [app entry point is configured](docs/discord-setup.md#install-and-register-commands); use Discord's own invitation controls when you want to share one.

Playback controls use the caller's current voice channel and require their active player in that channel's Activity. Command replies are visible only to the caller. All SyncPlay participants can control playback. Signing out revokes the selected Jellyfin connection while keeping Discord connected.

## Desktop and mobile

The Activity uses Jellyfin's responsive web client in Discord's embedded browser. Enable Web, iOS and Android in the Developer Portal. If autoplay is blocked, Jellyfin's **Join playback** dialog offers **Tap to play on this device**. Volume, tracks, subtitles, quality and fullscreen use the native player controls. Available codecs, fullscreen, background playback and operating-system picture-in-picture depend on Discord and the device; this does not launch the installed Jellyfin app. Each viewer receives a separate stream, so transcoding and bandwidth grow with the party.

Layout changes keep the same player and Discord connection. If an app session is interrupted, the open Activity can obtain a new session after Discord verifies its existing in-memory authorization and current membership. A failed verification grants no access; native connection dialogs offer **Try again** for a temporary outage, or ask you to reopen the Activity if required. Signing out requires another explicit Jellyfin login.

Verify the compiled client in a browser after integration changes. Responsive browser checks do not establish physical iOS/Android playback or guaranteed fullscreen in the outer Discord application.

## Deploy

The default branch publishes `ghcr.io/tomerh2001/jellyfin-discord-activity:latest` after checks pass. Copy `.env.example`, configure [Discord](docs/discord-setup.md), then follow [deployment](docs/deployment.md) and [security](docs/security.md).

Production requires strong credentials, an allowed Discord server/user and trusted Activity ingress proof. Generic servers must use public HTTPS. The exact operator-configured default URL is the only permitted private-network or HTTP target. All browser requests use the Activity's mapped origin; real Jellyfin tokens stay encrypted on the backend. Discord authorization and opaque gateway credentials stay in document memory. The native client's browser storage is replaced with document-local memory, and persistent response/service-worker caches are disabled.

## Development

Build the pinned Jellyfin Web12 client with Node24/npm11:

```bash
node native-client/build.mjs
```

Use the pinned pnpm version through Corepack for the workspace:

```bash
corepack enable
pnpm install --frozen-lockfile
node --test native-client/test/*.test.mjs
pnpm build
pnpm typecheck
pnpm lint
pnpm test
cp -R apps/activity-web/dist/. native-client/dist/
```

The last command combines the session library and branding assets with the native client for local API serving. The Dockerfile packages the complete document using Node24. Install workspace dependencies before running native DOM tests. Isolated development can use `NODE_ENV=development`, `DEV_AUTH_MOCK=true` and `VITE_DEV_DISCORD_MOCK=true`; production rejects mock authentication. The native source pin, patches and build instructions are in [native-client](native-client/README.md).

## Documentation and licensing

- [Jellyfin connections](docs/jellyfin-setup.md)
- [API and gateway](docs/api.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)

This fork derives from [camarokris/jellyfin-discord-activity](https://github.com/camarokris/jellyfin-discord-activity). The session library and backend retain the [MIT license](LICENSE). The bundled [Jellyfin Web](https://github.com/jellyfin/jellyfin-web) client and its modifications are GPL-2.0-or-later; its license and source revision ship with the native assets. This repository contains the adapter and reproducible source-build recipe. Original `plan.md` describes the retired custom player.
