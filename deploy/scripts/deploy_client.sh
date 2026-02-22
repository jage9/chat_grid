#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-/home/bestmidi/chgrid}"
PUBLISH_DIR="${2:-/home/bestmidi/public_html/chgrid}"
BASE_PATH="${3:-/chgrid/}"
CLIENT_DIR="$REPO_ROOT/client"
PHP_PROXY_DIR="$REPO_ROOT/deploy/php"

if [[ ! -d "$CLIENT_DIR" ]]; then
  echo "error: client directory not found: $CLIENT_DIR" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "error: rsync is required but not found in PATH" >&2
  exit 1
fi

cd "$CLIENT_DIR"
npm install
VITE_BASE_PATH="$BASE_PATH" npm run build

mkdir -p "$PUBLISH_DIR"
rsync -a --delete dist/ "$PUBLISH_DIR/"

if [[ -d "$PHP_PROXY_DIR" ]]; then
  rsync -a "$PHP_PROXY_DIR/" "$PUBLISH_DIR/"
fi

# Normalize publish permissions for restrictive shared-host PHP handlers.
# - Directories must be executable/traversable.
# - PHP/static files must not be group-writable.
find "$PUBLISH_DIR" -type d -exec chmod 755 {} +
find "$PUBLISH_DIR" -type f -exec chmod 644 {} +

echo "client deploy complete: $PUBLISH_DIR"
echo "client base path: $BASE_PATH"
