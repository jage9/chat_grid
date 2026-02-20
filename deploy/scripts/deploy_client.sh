#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-/home/bestmidi/chgrid}"
PUBLISH_DIR="${2:-/home/bestmidi/public_html/chgrid}"
BASE_PATH="${3:-/chgrid/}"
CLIENT_DIR="$REPO_ROOT/client"

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

echo "client deploy complete: $PUBLISH_DIR"
echo "client base path: $BASE_PATH"
