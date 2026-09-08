# Contributing

Thanks for your interest in improving Jellyfin Discord Activity.

## Development setup

```bash
corepack enable
pnpm install
cp .env.example .env
```

Useful defaults for local UI work without Discord:

```bash
# in .env (API)
DEV_AUTH_MOCK=true

# for apps/activity-web (optional)
# VITE_DEV_DISCORD_MOCK=true
```

```bash
pnpm dev
```

- API: `http://localhost:3000`
- Frontend: `http://localhost:5173`

## Checks before opening a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If you change deployment or auth flows, also run a smoke test against a local container with `DEV_AUTH_MOCK=true` (never leave that enabled on a public host):

```bash
docker compose up --build -d
pnpm smoke
```

## Project conventions

- TypeScript strict mode across the monorepo
- Zod validation for HTTP and WebSocket payloads (`packages/shared`)
- Do not log tokens, passwords, OAuth codes, or stream ticket secrets
- Prefer remux / fMP4 HLS for quality; treat progressive WebM as a Linux Discord compatibility path
- Keep production as a single HTTPS origin for `/`, `/api`, `/jf`, and `/jellyfin-web`

## Pull requests

- Keep changes focused and documented when they affect operators (env vars, Discord setup, playback behavior)
- Update `docs/` and `.env.example` when you add configuration
- Include tests for API and player behavior when practical

## Security reports

Please do **not** open public issues for vulnerabilities that expose secrets or remote code execution. Prefer a private report to the maintainer via GitHub Security Advisories on the repository.
