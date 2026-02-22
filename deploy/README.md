# Deployment Guide

Target example: AlmaLinux/cPanel host with files under `/home/bestmidi`.

## 1) Place project files
- Repo root: `/home/bestmidi/chgrid`

## 2) Make deploy scripts executable (once)

```bash
cd /home/bestmidi/chgrid
chmod +x deploy/scripts/*.sh
```

## 3) Install server (uv)

Verify server files first:

```bash
ls -l /home/bestmidi/chgrid/server/pyproject.toml
```

Run install scripts from repo root (`/home/bestmidi/chgrid`), not from `server/`.

```bash
cd /home/bestmidi/chgrid
./deploy/scripts/install_server.sh /home/bestmidi/chgrid
```

Notes:
- Script defaults to Python `3.13` (`PYTHON_SPEC=3.13`).
- It reuses existing `.venv` instead of replacing it interactively.
- If you need to force a fresh 3.13 env:
  - `rm -rf /home/bestmidi/chgrid/server/.venv`
  - rerun `./deploy/scripts/install_server.sh /home/bestmidi/chgrid`

This creates:
- `/home/bestmidi/chgrid/server/.venv`
- `/home/bestmidi/chgrid/server/config.toml` (if missing)

Edit `/home/bestmidi/chgrid/server/config.toml`:
- `server.bind_ip = "127.0.0.1"`
- `server.port = 8765`
- `network.allow_insecure_ws = true`
- `tls.cert_file = ""`
- `tls.key_file = ""`
- `storage.state_file = "runtime/items.json"`

## 4) Build and publish client

```bash
cd /home/bestmidi/chgrid
./deploy/scripts/deploy_client.sh /home/bestmidi/chgrid /home/bestmidi/public_html/chgrid /chgrid/
```

Notes:
- Third arg is Vite base path for production assets.
- For `https://bestmidi.com/chgrid/`, use `/chgrid/`.
- For site root deploy (`https://bestmidi.com/`), use `/`.
- Deploy script normalizes publish permissions to avoid shared-host PHP soft exceptions:
  - directories `755`
  - files `644`

Shortcut (client deploy + service restart):

```bash
cd /home/bestmidi/chgrid
./deploy/scripts/up.sh /home/bestmidi/chgrid /home/bestmidi/public_html/chgrid /chgrid/
```

## 5) Install/restart signaling service (systemd)

```bash
cd /home/bestmidi/chgrid
./deploy/scripts/install_service.sh /home/bestmidi/chgrid
```

Logs:

```bash
journalctl -u chat-grid.service -f
tail -f /home/bestmidi/chgrid/server/runtime/server.log
```

If you previously used `chgrid-signaling.service`, migrate once:

```bash
sudo systemctl disable --now chgrid-signaling.service
sudo systemctl daemon-reload
```

## 6) Apache websocket proxy

Install using script:

```bash
cd /home/bestmidi/chgrid
./deploy/scripts/install_apache.sh \
  /home/bestmidi/chgrid \
  /etc/apache2/conf.d/userdata/ssl/2_4/bestmidi/yourdomain.com/chgrid.conf
```

Notes:
- Replace `yourdomain.com` with your real domain.
- Script copies `deploy/apache/chgrid-vhost-snippet.conf`, runs `rebuildhttpdconf`, then restarts Apache via WHM restart command.
- Snippet now includes no-cache headers for `/chgrid/` and `/chgrid/index.html` so client updates are not stuck on stale HTML.

## 7) Optional HTTPS relay for HTTP radio streams

If stream sources are plain HTTP (for example ports `8000`, `8010`, `8020`, `8030`), add relays in:

`/etc/apache2/conf.d/userdata/ssl/2_4/bestmidi/bestmidi.com/chgrid.conf`

Example:

```apache
ProxyPass        /listen/8000/  http://127.0.0.1:8000/
ProxyPassReverse /listen/8000/  http://127.0.0.1:8000/
ProxyPass        /listen/8010/  http://127.0.0.1:8010/
ProxyPassReverse /listen/8010/  http://127.0.0.1:8010/
ProxyPass        /listen/8020/  http://127.0.0.1:8020/
ProxyPassReverse /listen/8020/  http://127.0.0.1:8020/
ProxyPass        /listen/8030/  http://127.0.0.1:8030/
ProxyPassReverse /listen/8030/  http://127.0.0.1:8030/
```

Apply changes:

```bash
sudo /usr/local/cpanel/scripts/rebuildhttpdconf
sudo /usr/local/cpanel/scripts/restartsrv_httpd
```

Usage example in Chat Grid:
- `https://bestmidi.com/listen/8000/stream`

## 8) PHP media proxy (Dropbox + HTTP stream passthrough)

`deploy/php/media_proxy.php` is a lightweight same-origin proxy for stream URLs.

It is auto-copied to your publish dir by `deploy_client.sh` (and `up.sh`), so after deploy it should be available at:

- `https://bestmidi.com/chgrid/media_proxy.php`

Use in Chat Grid `streamUrl`:

```text
https://bestmidi.com/chgrid/media_proxy.php?url=<urlencoded-upstream-url>
```

Examples:

- Dropbox:
  `https://bestmidi.com/chgrid/media_proxy.php?url=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffi%2Fa7s3n15bgj043rr54k3n9%2FMario-Hold-Music.mp3%3Frlkey%3Ddfr3dybr7s7nndudag0k8xflc%26dl%3D1`
- HTTP stream:
  `https://bestmidi.com/chgrid/media_proxy.php?url=http%3A%2F%2Fstream.rpgamers.net%3A8000%2Frpgn`

Troubleshooting checks:

```bash
curl -I "https://bestmidi.com/chgrid/media_proxy.php?url=https%3A%2F%2Fwww.dropbox.com%2Fscl%2Ffi%2Fa7s3n15bgj043rr54k3n9%2FMario-Hold-Music.mp3%3Frlkey%3Ddfr3dybr7s7nndudag0k8xflc%26dl%3D1"
curl -I "https://bestmidi.com/chgrid/media_proxy.php?url=http%3A%2F%2Fstream.rpgamers.net%3A8000%2Frpgn"
```

Optional hardening:

- Set env var `CHGRID_MEDIA_PROXY_ALLOWLIST` (comma-separated hosts/suffixes) in Apache/PHP-FPM.
  - Example: `dropbox.com,dropboxusercontent.com,stream.rpgamers.net`

## 9) GitHub-based update flow (`bestmidi`)

Initial clone (one time):

```bash
cd /home/bestmidi
git clone https://github.com/jage9/chat_grid.git chgrid
```

Update and redeploy:

```bash
cd /home/bestmidi/chgrid
git fetch origin
git switch main
git pull --ff-only origin main

# Rebuild/publish web client
./deploy/scripts/deploy_client.sh /home/bestmidi/chgrid /home/bestmidi/public_html/chgrid /chgrid/

# Reconcile server env/deps (safe to rerun on updates)
./deploy/scripts/install_server.sh /home/bestmidi/chgrid

# Restart signaling service
sudo systemctl restart chat-grid.service
journalctl -u chat-grid.service -n 50 --no-pager
```

Typical quick update:

```bash
cd /home/bestmidi/chgrid
./deploy/scripts/up.sh /home/bestmidi/chgrid /home/bestmidi/public_html/chgrid /chgrid/
```

Notes:
- Run Apache install/reload steps again only if proxy config changed.
- If your checkout has local changes, stash or commit before `git pull`.
- For HTTPS GitHub auth, use your GitHub username plus a Personal Access Token (PAT) as the password.
- SSH key passphrases are only used for `git@github.com:` remotes, not `https://` remotes.

## 10) Save GitHub PAT for HTTPS pulls/pushes

Persistent storage (simple, plaintext in `~/.git-credentials`):

```bash
git config --global credential.helper store
```

Memory cache only (not persisted across reboot):

```bash
git config --global credential.helper "cache --timeout=28800"
```

Then run one authenticated command and enter:
- Username: `jage9`
- Password: your GitHub PAT

```bash
cd /home/bestmidi/chgrid
git pull --ff-only origin main
```

If you saved the wrong token and need to re-enter it:

```bash
printf "protocol=https\nhost=github.com\n" | git credential reject
```
