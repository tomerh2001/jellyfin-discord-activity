<img src="apps/activity-web/public/branding/jellyfin-watch-icon.png" alt="Jellyfin Watch" width="96" height="96" />

# Jellyfin Watch

Watch Jellyfin together in a Discord call using the official Jellyfin Web interface and native SyncPlay. The Activity adds Discord authentication, saved Jellyfin connections, invitations and a protected gateway around the native client.

## Watch together

1. Join a voice channel and open **Jellyfin Watch** from Activities, `/watch`, or **Apps → Watch Jellyfin** on a user/message.
2. Enter your Jellyfin server URL and sign in, or approve a Quick Connect code from an existing Jellyfin session. Your connection is remembered for your Discord account, with a preferred connection for each Discord server.
3. Browse Jellyfin normally and play a movie, episode or series. Friends join the running Discord Activity, connect their own account to the same Jellyfin server, and join its SyncPlay group automatically.
4. Use Jellyfin's player and queue to pause, seek, skip to the next/previous episode, change the title, or add something to play next. Use **Invite friends** to open Discord's invitation dialog.

Playback and the queue are shared. Volume, audio track, subtitles and quality belong to each viewer. Every viewer needs permission to watch the selected content. An operator may also offer a clearly labelled **community account** with shared watch history; personal accounts remain available.

| Discord command | Behavior |
| --- | --- |
| `/watch` or Apps → Watch Jellyfin | Open the Activity |
| `/jellyfin play query:…` | Find and play a movie or episode |
| `/jellyfin pause` / `resume` | Pause or resume the native group |
| `/jellyfin seek seconds:…` | Seek the group |
| `/jellyfin next` / `previous` | Move through the native queue |
| `/jellyfin stop` | Stop group playback |
| `/jellyfin now` | Show the native player's current title and position |

Controls use the caller's current voice channel and require their active player in that channel's Activity. All SyncPlay participants can control playback. Leaving the watch party revokes its session and keeps the voice call connected.

## Desktop and mobile

The Activity uses Jellyfin's responsive web client in Discord's embedded browser. Enable Web, iOS and Android in the Developer Portal. A phone may need a tap to start audio. Available codecs, fullscreen, background playback and operating-system picture-in-picture depend on Discord and the device; this does not launch the installed Jellyfin app. Each viewer receives a separate stream, so transcoding and bandwidth grow with the party.

## Deploy

The default branch publishes `ghcr.io/tomerh2001/jellyfin-discord-activity:latest` after checks pass. Copy `.env.example`, configure [Discord](docs/discord-setup.md), then follow [deployment](docs/deployment.md) and [security](docs/security.md).

Production requires strong credentials, an allowed Discord server/user and trusted Activity ingress proof. Generic servers must use public HTTPS. The exact operator-configured default URL is the only permitted private-network or HTTP target. All browser requests use the Activity's mapped origin; real Jellyfin tokens stay encrypted on the backend.

## Development

Build the pinned native client with Node22/npm10:

```bash
node native-client/build.mjs
node --test native-client/test/*.test.mjs
```

Then use Node24 and the pinned pnpm version through Corepack:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The Dockerfile handles both toolchains. Isolated development can use `NODE_ENV=development`, `DEV_AUTH_MOCK=true` and `VITE_DEV_DISCORD_MOCK=true`; production rejects mock authentication. The native source pin, patches and build instructions are in [native-client](native-client/README.md).

## Documentation and licensing

- [Jellyfin connections](docs/jellyfin-setup.md)
- [API and gateway](docs/api.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)

This fork derives from [camarokris/jellyfin-discord-activity](https://github.com/camarokris/jellyfin-discord-activity). The Activity shell/backend retain the [MIT license](LICENSE). The bundled [Jellyfin Web](https://github.com/jellyfin/jellyfin-web) client and its modifications are GPL-2.0-or-later; its license and source revision ship with the native assets. This repository contains the adapter and reproducible source-build recipe. Original `plan.md` describes the retired custom player.
