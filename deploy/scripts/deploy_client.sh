#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PUBLISH_DIR="${2:-$REPO_ROOT/deploy/publish/chgrid}"
EXPECTED_BASE_PATH="${3:-}"
SERVER_CONFIG_PATH="${4:-$REPO_ROOT/server/config.toml}"
CLIENT_DIR="$REPO_ROOT/client"
PHP_PROXY_DIR="$REPO_ROOT/deploy/php"
SERVER_ENV_FILE="$REPO_ROOT/server/.env"
SERVER_VENV_PYTHON="$REPO_ROOT/server/.venv/bin/python"
PUBLIC_HTACCESS_SRC="$REPO_ROOT/deploy/apache/chgrid-public-htaccess"

if [[ ! -d "$CLIENT_DIR" ]]; then
  echo "error: client directory not found: $CLIENT_DIR" >&2
  exit 1
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "error: rsync is required but not found in PATH" >&2
  exit 1
fi

if [[ ! -r "$SERVER_CONFIG_PATH" ]]; then
  echo "error: server config not found: $SERVER_CONFIG_PATH" >&2
  exit 1
fi

if [[ -n "${CHGRID_CLIENT_DIST:-}" ]]; then
  dist_dir="$CHGRID_CLIENT_DIST"
else
  (cd "$CLIENT_DIR" && npm install && npm run build)
  dist_dir="$CLIENT_DIR/dist"
fi

if [[ -f "$SERVER_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SERVER_ENV_FILE"
  set +a
fi

config_python="python3"
if [[ -x "$SERVER_VENV_PYTHON" ]]; then
  config_python="$SERVER_VENV_PYTHON"
fi
config_dir="$(mktemp -d)"
trap 'rm -rf -- "$config_dir"' EXIT
base_path="$("$config_python" "$SCRIPT_DIR/configure_client.py" "$SERVER_CONFIG_PATH" \
  "$dist_dir/index.html" "$config_dir" --expected-base "$EXPECTED_BASE_PATH")"

mkdir -p "$PUBLISH_DIR"
# Install the configured entry page after its assets. Keep the current page and
# proxy configuration available until their replacements are ready.
rsync -a --delete --exclude=/index.html --exclude=/client_branding.json \
  --exclude=/media_proxy.config.php --exclude=/media_proxy.php "$dist_dir/" "$PUBLISH_DIR/"
if [[ -d "$PHP_PROXY_DIR" ]]; then
  rsync -a "$PHP_PROXY_DIR/" "$PUBLISH_DIR/"
fi
if [[ ! -f "$config_dir/media_proxy.config.php" ]]; then
  rm -f "$PUBLISH_DIR/media_proxy.config.php"
fi
rsync -aI "$config_dir/" "$PUBLISH_DIR/"

if [[ -f "$PUBLIC_HTACCESS_SRC" ]]; then
  cp "$PUBLIC_HTACCESS_SRC" "$PUBLISH_DIR/.htaccess"
fi

# Normalize publish permissions for restrictive shared-host PHP handlers.
# - Directories must be executable/traversable.
# - PHP/static files must not be group-writable.
find "$PUBLISH_DIR" -type d -exec chmod 755 {} +
find "$PUBLISH_DIR" -type f -exec chmod 644 {} +

echo "client deploy complete: $PUBLISH_DIR"
echo "client base path: $base_path"
echo "server config path: $SERVER_CONFIG_PATH"
