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

Before starting the service, set `CHGRID_HOST_ORIGIN` in `server/.env` to the exact browser origin that will host Chat Grid, for example:

```bash
CHGRID_HOST_ORIGIN=https://example.com
```

The expected env shape is also shown in [server/.env.sample](/home/jjm/code/chgrid/server/.env.sample).

## 3) Publish Client

```bash
cd "$REPO_ROOT"
./deploy/scripts/deploy_client.sh "$REPO_ROOT" "$PUBLISH_DIR" "$BASE_PATH"
```

Optional 4th arg:
- server config path used when generating `media_proxy.config.php`
- use this for secondary grids that do not use `server/config.toml`
- the same config is also used to generate `client_branding.json` for pre-login client branding

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

Optional 5th arg:
- server config path used when generating the media proxy session-check URL

## 6) Apache Websocket Proxy

Install your vhost include from the provided snippet:

```bash
cd "$REPO_ROOT"
./deploy/scripts/install_apache.sh "$REPO_ROOT" /path/to/apache/include/chgrid.conf
```

Expected proxy endpoints:

```apache
ProxyPass        /chgrid/ws  ws://127.0.0.1:8765/chgrid/ws
ProxyPassReverse /chgrid/ws  ws://127.0.0.1:8765/chgrid/ws
ProxyPass        /chgrid/auth/session/  http://127.0.0.1:8765/chgrid/auth/session/
ProxyPassReverse /chgrid/auth/session/  http://127.0.0.1:8765/chgrid/auth/session/
```

The websocket server enforces browser origin matching against `CHGRID_HOST_ORIGIN`, so the public site origin must match that env var exactly.
The `server.base_path` value in `config.toml` must match the published client path and the proxy paths above.

What each route does:
- `<base_path>ws`: websocket signaling (presence, movement, item actions, chat, voice signaling).
- `<base_path>auth/session/set`: called by client after successful login to set the instance-scoped `HttpOnly` session cookie.
- `<base_path>auth/session/clear`: called by client on logout/session-reset to clear the instance-scoped `HttpOnly` session cookie.

After Apache changes, reload Apache using your host's command.

## 7) Optional HTTP Stream Relay

If you need HTTPS relays for plain HTTP streams, add vhost relays such as:

```apache
ProxyPass        /listen/8000/  http://127.0.0.1:8000/
ProxyPassReverse /listen/8000/  http://127.0.0.1:8000/
```

## 8) PHP Media Proxy

`deploy/php/media_proxy.php` is copied into your publish directory by `deploy_client.sh`.

When `server/.env` contains `CHGRID_HOST_ORIGIN`, `deploy_client.sh` also generates `media_proxy.config.php` in the publish directory so the proxy can enforce the same origin and validate authenticated sessions without extra Apache-specific config. The generated file derives the local auth-check URL from the selected server config file (default `server/config.toml`), so custom signaling ports and secondary grid configs continue to work, and the proxy reuses `CHGRID_HOST_ORIGIN` for its internal auth check.

If you deploy the PHP proxy some other way, you can still provide `CHGRID_HOST_ORIGIN` directly through your PHP/web-server environment.

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
