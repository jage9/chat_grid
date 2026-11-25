# Install Chat Grid with Docker Compose

This installs one grid from a release or a clone of the repository. Docker builds the web client, PHP media proxy, and Python server. Accounts, world state, and checkpoints live in a directory on the host. Voice uses your own LiveKit URL and API credentials.

## First start

On a Linux host with Docker Engine, the Compose v2 plugin, Bash, and OpenSSL, run these commands as the user who owns the checkout.

```bash
git clone https://github.com/jage9/chat_grid.git
cd chat_grid
bash deploy/docker/init.sh
cd grid
```

1. Edit `.env`. Set `LIVEKIT_URL` to the browser-accessible WebSocket URL and enter the matching API key and secret. Set `CHGRID_HOST_ORIGIN` to the exact public origin, for example `https://grid.example.com`. For a local browser test, the default is `http://localhost:8080`. Keep the generated `CHGRID_AUTH_SECRET` across updates.
2. Edit `config.toml` for the grid name and public path. Use `base_path = "/"` for a dedicated hostname or `base_path = "/ttgrid/"` for a subdirectory. The path goes in TOML. The origin in `.env` consists of the scheme, hostname, and optional port.
3. Build the images, create your first administrator interactively, and start the grid.

```bash
docker compose build
docker compose run --rm --no-deps server python main.py --config /grid/config.toml --bootstrap-admin
docker compose up -d --wait
```

Run Compose commands from `grid/`. Its `.env` selects the repository's `compose.yaml`. The setup script can be run again and preserves existing config, credentials, and data. The server runs under the host UID and GID recorded at setup so its database and saved worlds belong to the operator.

## Public access

The web service listens on host loopback port 8080 by default. Point your host's HTTPS reverse proxy at `http://127.0.0.1:8080`. Forward the complete path and WebSocket upgrades. Apache in the web container serves static files and PHP, and forwards signaling and session requests to the private server. Public microphone access requires HTTPS.

For example, inside an existing nginx HTTPS server block serving a grid at `/ttgrid/`:

```nginx
location /ttgrid/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
}
```

Define the nginx variable once in its `http` block:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

For a dedicated hostname use `location /`. To change the loopback port set `CHGRID_HTTP_PORT` in `.env` and update the proxy target. Set a distinct LiveKit room name in `config.toml` when multiple grids share a LiveKit deployment.

## Updates and backups

From `grid/`, pull the source revision you want and rebuild:

```bash
git pull --ff-only
docker compose up -d --build --wait
docker compose ps
```

After changing the mount, port, or branding in the config, use `docker compose up -d --force-recreate --wait` to reload both services. View logs with `docker compose logs --tail=100 web server`.

For a full backup, run `docker compose down`, copy the entire `grid/` directory including `.env`, then run `docker compose up -d --wait`. Restore the directory with the same owner and permissions. All database files and checkpoint generations stay under `grid/data/`.

For an existing non-Docker grid, the [host deployment guide](../README.md) describes the Apache/systemd install and update commands.
