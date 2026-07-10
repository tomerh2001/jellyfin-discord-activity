# Runtime logs

This directory is mounted into containers so logs are available on the host without `docker compose logs`.

| Path | Source | Contents |
|------|--------|----------|
| `logs/app/app.log` | App container (`LOG_DIR=/logs`) | Structured JSON request/app logs (all levels ≥ `LOG_LEVEL`) |
| `logs/app/error.log` | App container | Error-level and above only |
| `logs/caddy/access.log` | Caddy (compose profile `proxy`) | Reverse-proxy access logs (JSON) when using the example Caddyfile |

## After `docker compose up`

```bash
# Follow app logs on the host
tail -f logs/app/app.log

# Errors only
tail -f logs/app/error.log

# Still available via Docker if needed
docker compose logs -f app
```

## Useful filters

```bash
# Playback prepare events
grep -E 'Playback prepared|Playback prepare' logs/app/app.log | tail -50

# Media proxy failures
grep -E 'HLS|Direct stream|playback' logs/app/app.log | tail -80

# Pretty-print last N JSON lines (if jq is installed)
tail -n 30 logs/app/app.log | jq -c .
```

## Notes

- Sensitive values (tokens, passwords, OAuth codes) are redacted in app logs.
- Log files append forever until rotated or truncated; Docker `json-file` logs are capped at 20MB × 5 files.
- To raise verbosity temporarily, set `LOG_LEVEL=debug` in `.env` and recreate the app container.
