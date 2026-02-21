#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-/home/bestmidi/chgrid}"
UNIT_NAME="${2:-chat-grid.service}"
SRC_UNIT="$REPO_ROOT/deploy/systemd/$UNIT_NAME"
DST_UNIT="/etc/systemd/system/$UNIT_NAME"

if [[ ! -f "$SRC_UNIT" ]]; then
  echo "error: unit file not found: $SRC_UNIT" >&2
  exit 1
fi

sudo cp "$SRC_UNIT" "$DST_UNIT"
sudo install -d -m 0755 -o bestmidi -g bestmidi "$REPO_ROOT/server/runtime"
sudo touch "$REPO_ROOT/server/runtime/server.log"
sudo chown bestmidi:bestmidi "$REPO_ROOT/server/runtime/server.log"
sudo systemctl daemon-reload
sudo systemctl enable --now "$UNIT_NAME"
sudo systemctl restart "$UNIT_NAME"
sudo systemctl status "$UNIT_NAME" --no-pager
