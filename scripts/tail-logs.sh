#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TARGET="${1:-app}"

case "$TARGET" in
  app)
    FILE="$ROOT/logs/app/app.log"
    ;;
  error|app-error)
    FILE="$ROOT/logs/app/error.log"
    ;;
  caddy)
    FILE="$ROOT/logs/caddy/access.log"
    ;;
  *)
    echo "Usage: $0 [app|error|caddy]" >&2
    exit 1
    ;;
esac

if [ ! -f "$FILE" ]; then
  echo "Log file not found yet: $FILE" >&2
  echo "Start the stack with: docker compose up --build -d" >&2
  exit 1
fi

exec tail -n 100 -f "$FILE"
