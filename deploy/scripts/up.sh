#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-/home/bestmidi/chgrid}"
PUBLISH_DIR="${2:-/home/bestmidi/public_html/chgrid}"
BASE_PATH="${3:-/chgrid/}"
SERVICE_NAME="${4:-chat-grid.service}"
if [[ -z "${SERVICE_NAME// }" || "$SERVICE_NAME" == "-" || "$SERVICE_NAME" == ".service" ]]; then
  SERVICE_NAME="chat-grid.service"
fi

"$REPO_ROOT/deploy/scripts/deploy_client.sh" "$REPO_ROOT" "$PUBLISH_DIR" "$BASE_PATH"
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" --no-pager
