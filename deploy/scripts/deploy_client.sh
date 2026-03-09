#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PUBLISH_DIR="${2:-$REPO_ROOT/deploy/publish/chgrid}"
BASE_PATH="${3:-/chgrid/}"
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
  config_python="python3"
  if [[ -x "$SERVER_VENV_PYTHON" ]]; then
    config_python="$SERVER_VENV_PYTHON"
  fi
  session_check_url="$(
    "$config_python" - "$REPO_ROOT/server/config.toml" <<'PY'
from pathlib import Path
import sys

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - compatibility fallback
    import tomli as tomllib

config_path = Path(sys.argv[1])
host = "127.0.0.1"
port = 8765
base_path = "/"
if config_path.exists():
    with config_path.open("rb") as fp:
        data = tomllib.load(fp)
    server = data.get("server", {})
    bind_ip = str(server.get("bind_ip", host)).strip() or host
    if bind_ip in {"0.0.0.0", ""}:
        host = "127.0.0.1"
    elif bind_ip == "::":
        host = "[::1]"
    else:
        host = bind_ip
    try:
        port = int(server.get("port", port))
    except (TypeError, ValueError):
        port = 8765
    raw_base_path = str(server.get("base_path", base_path)).strip() or "/"
    base_path = "/" if raw_base_path == "/" else f"/{raw_base_path.strip('/')}/"
print(f"http://{host}:{port}{base_path}auth/session/check")
PY
  )"
  escaped_host_origin=${CHGRID_HOST_ORIGIN//\\/\\\\}
  escaped_host_origin=${escaped_host_origin//\'/\\\'}
  escaped_session_check_url=${session_check_url//\\/\\\\}
  escaped_session_check_url=${escaped_session_check_url//\'/\\\'}
  cat > "$PUBLISH_DIR/media_proxy.config.php" <<EOF
<?php
return array(
    'host_origin' => '$escaped_host_origin',
    'session_check_url' => '$escaped_session_check_url',
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
