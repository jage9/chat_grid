# Deployment Guide

This guide is intentionally host-agnostic.

## 1) Choose Your Paths Once

Pick your own repo path, publish path, base URL path, and service name.

Example values:

```bash
REPO_ROOT=/srv/chgrid
PUBLISH_DIR=/var/www/html/chgrid
BASE_PATH=/chgrid/
UNIT_NAME=chat-grid.service
```

Use your own paths for your host.

## 2) Install Server Runtime

```bash
cd "$REPO_ROOT"
./deploy/scripts/install_server.sh "$REPO_ROOT"
```

What this sets up:
- Python venv under `server/.venv`
- `server/config.toml` (if missing)
- `server/.env` with `CHGRID_AUTH_SECRET` (if missing)
- `server/run_server.sh` (loads `.env` and starts server)
- first-run admin bootstrap prompt (if no admin exists)

## 3) Publish Client

```bash
cd "$REPO_ROOT"
./deploy/scripts/deploy_client.sh "$REPO_ROOT" "$PUBLISH_DIR" "$BASE_PATH"
```

## 4) Install/Reload Service Unit

```bash
cd "$REPO_ROOT"
./deploy/scripts/install_service.sh "$REPO_ROOT" "$UNIT_NAME"
```

Service logs:

```bash
journalctl -u "$UNIT_NAME" -f
tail -f "$REPO_ROOT/server/runtime/server.log"
```

## 5) One-Command Update

```bash
cd "$REPO_ROOT"
./deploy/scripts/up.sh "$REPO_ROOT" "$PUBLISH_DIR" "$BASE_PATH" "$UNIT_NAME"
```

## 6) Apache Websocket Proxy

Install your vhost include from the provided snippet:

```bash
cd "$REPO_ROOT"
./deploy/scripts/install_apache.sh "$REPO_ROOT" /path/to/apache/include/chgrid.conf
```

Expected proxy endpoint:

```apache
ProxyPass        /ws  ws://127.0.0.1:8765
ProxyPassReverse /ws  ws://127.0.0.1:8765
```

After Apache changes, reload Apache using your host's command.

## 7) Optional HTTP Stream Relay

If you need HTTPS relays for plain HTTP streams, add vhost relays such as:

```apache
ProxyPass        /listen/8000/  http://127.0.0.1:8000/
ProxyPassReverse /listen/8000/  http://127.0.0.1:8000/
```

## 8) PHP Media Proxy

`deploy/php/media_proxy.php` is copied into your publish directory by `deploy_client.sh`.

Use:

```text
https://example.com/chgrid/media_proxy.php?url=urlencoded_upstream_url
```

## 9) Git Update Flow

```bash
cd "$REPO_ROOT"
git fetch origin
git switch main
git pull --ff-only origin main
./deploy/scripts/install_server.sh "$REPO_ROOT"
./deploy/scripts/up.sh "$REPO_ROOT" "$PUBLISH_DIR" "$BASE_PATH" "$UNIT_NAME"
```

## 10) HTTPS Git Auth (PAT)

```bash
git config --global credential.helper store
```

Then run one authenticated pull/push and enter:
- Username: your GitHub username
- Password: your GitHub PAT
