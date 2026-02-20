#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-/home/bestmidi/chgrid}"
INCLUDE_PATH="${2:-}"
RESTART_CMD="${3:-/usr/local/cpanel/scripts/restartsrv_httpd}"
SNIPPET_PATH="$REPO_ROOT/deploy/apache/chgrid-vhost-snippet.conf"

if [[ -z "$INCLUDE_PATH" ]]; then
  echo "usage: $0 <repo_root> <apache_include_path> [restart_cmd]" >&2
  echo "example: $0 /home/bestmidi/chgrid /etc/apache2/conf.d/userdata/ssl/2_4/bestmidi/example.com/chgrid.conf" >&2
  exit 1
fi

if [[ ! -f "$SNIPPET_PATH" ]]; then
  echo "error: snippet not found: $SNIPPET_PATH" >&2
  exit 1
fi

sudo mkdir -p "$(dirname "$INCLUDE_PATH")"
sudo cp "$SNIPPET_PATH" "$INCLUDE_PATH"

echo "installed apache include: $INCLUDE_PATH"

if [[ -x /usr/local/cpanel/scripts/rebuildhttpdconf ]]; then
  sudo /usr/local/cpanel/scripts/rebuildhttpdconf
else
  echo "warning: /usr/local/cpanel/scripts/rebuildhttpdconf not found; skipping rebuild" >&2
fi

if [[ -x "$RESTART_CMD" ]]; then
  sudo "$RESTART_CMD"
elif [[ -x /scripts/restartsrv_httpd ]]; then
  sudo /scripts/restartsrv_httpd
else
  echo "error: apache restart command not found" >&2
  echo "tried: $RESTART_CMD and /scripts/restartsrv_httpd" >&2
  exit 1
fi

echo "apache include applied and apache restarted"
