<img src="apps/activity-web/public/branding/jellyfin-watch-icon.png" alt="Jellyfin Watch" width="96" height="96" />

# Jellyfin Watch

A self-hosted Discord Activity for watching Jellyfin movies and episodes together in a voice channel. Each participant opens the shared player; playback follows the room host.

This MIT-licensed fork of [camarokris/jellyfin-discord-activity](https://github.com/camarokris/jellyfin-discord-activity) adds Discord commands, verified room access, safer media delivery, and container publishing.

## What it does

- Browse and search Jellyfin movies, shows, seasons, and episodes inside Discord.
- Share play, pause, seek, audio, and subtitle selections through a host-controlled room.
- Launch with `/watch` or right-click a user/message → **Apps → Watch Jellyfin**.
- Use `/jellyfin play`, `pause`, `resume`, `seek`, `stop`, and `now` from Discord.
- Connect each viewer's Jellyfin account, or use one dedicated account limited to selected libraries.
- Verify Activity membership with Discord's Bot API, renew it periodically, and restrict access by server/user allowlists.
- Hand host control to a remaining connected participant when the host leaves. Restore room snapshots paused after a restart; viewers authenticate again.

The backend serves the React player, API, WebSocket synchronization, and ticketed media proxy from one HTTPS origin. Jellyfin stays reachable only from the backend. Each viewer receives a separate stream, so bandwidth and transcoding demand increase with the number of viewers.

## Deploy

The default branch publishes `ghcr.io/tomerh2001/jellyfin-discord-activity:latest` after build, type checks, lint, and tests pass.

1. Copy `.env.example` to `.env` and fill in the production values. Configure a Discord bot token, OAuth client secret, public key, and at least one server/user allowlist.
2. Follow [Discord setup](docs/discord-setup.md) for Activities, URL mappings, commands, and installation.
3. Follow [deployment](docs/deployment.md) for persistent storage, secrets, HTTPS routing, and validation.
4. Run `docker compose pull && docker compose up -d`.

Production startup rejects mock authentication, placeholder credentials, weak app keys, missing allowlists, and custom Jellyfin servers. Backend secrets support `*_FILE` settings for Docker secrets. Do not configure both a secret and its file setting.

## Use in a call

Join the voice channel, run `/watch` in its chat, and authenticate in the Activity. The first connected participant becomes host. Choose a movie or episode, prepare playback, and press Play when everyone has joined. Discord/browser autoplay rules may require each viewer to click the player once.

| Command | Behavior |
| --- | --- |
| `/watch` | Open the Activity in the channel where invoked |
| Apps → Watch Jellyfin | Open the Activity from a user or message context menu |
| `/jellyfin play query:...` | Search movies/episodes; select from matching results |
| `/jellyfin pause` / `resume` | Pause or continue the host's current video |
| `/jellyfin seek seconds:...` | Move to the requested position and pause |
| `/jellyfin stop` | Pause and return to the beginning |
| `/jellyfin now` | Show the current title, state, and position |

Playback commands use the caller's current voice channel. The caller must be in that channel's Activity; changes require its connected host. `/jellyfin play` selects a video; press Play in the Activity after preparing it.

## Development

Use Node 24 and the pinned pnpm version through Corepack:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

For local UI development, set `NODE_ENV=development`, `DEV_AUTH_MOCK=true`, and `VITE_DEV_DISCORD_MOCK=true` only in your isolated development environment, then run `pnpm dev`. The built production player never enables mock mode.

## Documentation

- [Discord setup and installation](docs/discord-setup.md)
- [Deployment and upgrades](docs/deployment.md)
- [Jellyfin configuration](docs/jellyfin-setup.md)
- [API and WebSocket protocol](docs/api.md)
- [Security](docs/security.md)
- [Playback troubleshooting](docs/troubleshooting.md)

MIT — see [LICENSE](LICENSE). Upstream design notes in `plan.md` describe the original implementation and are historical.
