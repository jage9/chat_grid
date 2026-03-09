#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PUBLISH_DIR="${2:-$REPO_ROOT/deploy/publish/chgrid}"
BASE_PATH="${3:-/chgrid/}"
CLIENT_DIR="$REPO_ROOT/client"
PHP_PROXY_DIR="$REPO_ROOT/deploy/php"
SERVER_ENV_FILE="$REPO_ROOT/server/.env"
PUBLIC_HTACCESS_SRC="$REPO_ROOT/deploy/apache/chgrid-public-htaccess"

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

if [[ -f "$SERVER_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SERVER_ENV_FILE"
  set +a
fi

if [[ -n "${CHGRID_HOST_ORIGIN:-}" ]]; then
  escaped_host_origin=${CHGRID_HOST_ORIGIN//\\/\\\\}
  escaped_host_origin=${escaped_host_origin//\'/\\\'}
  cat > "$PUBLISH_DIR/media_proxy.config.php" <<EOF
<?php
return array(
    'host_origin' => '$escaped_host_origin',
);
EOF
else
  rm -f "$PUBLISH_DIR/media_proxy.config.php"
fi

if [[ -f "$PUBLIC_HTACCESS_SRC" ]]; then
  cp "$PUBLIC_HTACCESS_SRC" "$PUBLISH_DIR/.htaccess"
fi

# Normalize publish permissions for restrictive shared-host PHP handlers.
# - Directories must be executable/traversable.
# - PHP/static files must not be group-writable.
find "$PUBLISH_DIR" -type d -exec chmod 755 {} +
find "$PUBLISH_DIR" -type f -exec chmod 644 {} +

echo "client deploy complete: $PUBLISH_DIR"
echo "client base path: $BASE_PATH"
