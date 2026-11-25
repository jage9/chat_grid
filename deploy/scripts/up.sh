#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PUBLISH_DIR="${2:-$REPO_ROOT/deploy/publish/chgrid}"
BASE_PATH="${3:-}"
SERVICE_NAME="${4:-chat-grid.service}"
SERVER_CONFIG_PATH="${5:-$REPO_ROOT/server/config.toml}"

"$REPO_ROOT/deploy/scripts/deploy_client.sh" "$REPO_ROOT" "$PUBLISH_DIR" "$BASE_PATH" "$SERVER_CONFIG_PATH"
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" --no-pager
