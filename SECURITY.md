# Security Policy

## Supported versions

This project is provided as-is for self-hosting. Use the latest `main` commit for security fixes.

## Reporting a vulnerability

If you discover a security issue (for example token leakage, auth bypass, or remote code execution):

1. Prefer GitHub **Security Advisories** on this repository (private disclosure).
2. Do not file a public issue with exploit details.
3. Include reproduction steps, affected versions/commits, and impact.

## Operator responsibilities

Self-hosters must:

- Keep `DEV_AUTH_MOCK=false` in any public deployment
- Generate strong unique values for `APP_SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`
- Never commit `.env`, `data/`, or log files
- Terminate TLS correctly and enable WebSocket support on the reverse proxy
- Use a limited Jellyfin account for shared mode (never an admin account)
- Treat `logs/` as sensitive even though the app redacts common secrets

See [docs/security.md](docs/security.md) for application-level security notes.
