# Deployment

The published container serves the Activity, REST API, WebSocket endpoint, and media proxy on port 3000. Use `ghcr.io/tomerh2001/jellyfin-discord-activity:latest`; GitHub Actions publishes it from `main` after checks pass.

## Configuration and storage

Copy `.env.example` to an untracked `.env`. Fill in the Discord IDs, keys, allowlists, public HTTPS/WSS URLs, and Jellyfin account configuration. `PUBLIC_DISCORD_CLIENT_ID` must match `DISCORD_CLIENT_ID`. Production requires `DEV_AUTH_MOCK=false` and `JELLYFIN_ALLOW_CUSTOM_SERVERS=false`.

The container runs as an unprivileged user. Its UID/GID can be remapped with Compose `user:`. Mount a writable persistent volume at `/data`; `DATABASE_URL=file:/data/app.db` places the encrypted Jellyfin account store and `rooms.json` snapshots there. Set `LOG_DIR=/data/logs` for file logging, or leave it empty for Docker logs only. Room snapshots restore paused and without host ownership; live app sessions never persist.

Five backend secrets support Docker secret files:

```text
DISCORD_CLIENT_SECRET_FILE=/run/secrets/discord_client_secret
DISCORD_BOT_TOKEN_FILE=/run/secrets/discord_bot_token
APP_SESSION_SECRET_FILE=/run/secrets/app_session_secret
TOKEN_ENCRYPTION_KEY_FILE=/run/secrets/token_encryption_key
JELLYFIN_SHARED_PASSWORD_FILE=/run/secrets/jellyfin_shared_password
```

Do not also set their plain environment equivalents. Use random secrets of at least 32 characters for app sessions, and base64-encoded random 32 bytes for the token encryption key. Keep files readable only by the service and administrators. Back up the encryption key with `/data`; changing it invalidates stored Jellyfin tokens.

Shared mode uses a dedicated non-admin Jellyfin user. Grant media playback, remuxing/transcoding, and only the intended movie/show libraries. Disable deletion, downloads, administration, and management. Do not mount Jellyfin's administrator key into this app.

## HTTPS routing

Route one HTTPS hostname to the container's port 3000, preserving `/`, `/api`, `/ws`, `/media`, and `/assets`. Enable WebSocket upgrades. Map `/` in Discord's Activities URL Mappings to that hostname without a scheme.

Keep existing Authentik routing policies intact. The app has Discord OAuth and room authorization; it has no native Authentik OIDC or trusted-header login. A forward-auth middleware must preserve the app's `Authorization: Bearer` header. A service-local copy of the same Authentik middleware can omit only `Authorization` from its response-header list while keeping the login gate unchanged.

The Activity proxy and Discord webhook verifier cannot normally complete an interactive edge login. If this prevents use, an exact operator-approved routing decision is required. Do not silently exempt media, API, static, WebSocket, callback, or webhook routes.

Media URLs contain short-lived bearer tickets. The app redacts them from request logs; configure reverse-proxy logs to omit sensitive URLs as well. Disable public caching of authenticated API and media responses.

## Start and verify

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose exec app node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(console.log)"
```

The image has a healthcheck. Confirm the built frontend is served at `/`, unauthenticated room/library requests return 401, unsigned interactions return 401, and backend Jellyfin authentication succeeds. Check the HTTPS route separately from internal health; an edge redirect means Discord access remains unverified.

Complete [Discord setup](discord-setup.md), register commands, and test the same Activity with two real Discord users. Verify video/audio, pause/seek synchronization, audio/subtitle choices, host handoff, logout revocation, and a restart. A healthcheck or unit test does not establish Discord client playback compatibility.

## Updates

Application changes go through a source branch, reviewed pull request, merge to `main`, and successful CI image publication. Pull the moving `latest` tag and recreate the container. Record the deployed OCI revision/digest when diagnosing changes. Do not deploy live source bind mounts or permanent locally built patches.

The home-server provisioning input is [deploy/service-spec.yaml](../deploy/service-spec.yaml). Its generated operational Compose and environment files live in the host's Stacks repository; runtime credentials live in 1Password and the service's data dataset.

After filling the reserved Discord fields in **Home Server → Jellyfin Discord Activity**, check and synchronize the existing home-server configuration with:

```bash
python3 deploy/configure-home-server.py --check
python3 deploy/configure-home-server.py --apply
```

The helper resolves secrets without printing them, validates all required fields before writing, preserves the private TrueNAS ACL, and updates public IDs in the stack's `.env`. It does not start the service, edit ingress, or change Authentik policy.
