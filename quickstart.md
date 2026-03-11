# Quick Start: Docker

This guide gets Chat Grid running with Docker Compose and optionally behind a Caddy reverse proxy for HTTPS.

## Architecture

```
Browser → Caddy (TLS) → nginx:80 → static files
                               └→ /ws → Python server:4474
       → LiveKit server:7880 (signaling WebSocket)
       → LiveKit server:7881/tcp, 7882/udp (media transport)
```

nginx handles the built client files and the WebSocket proxy to the Python server. Caddy (or any reverse proxy) sits in front for TLS termination.

Voice audio flows through a **LiveKit SFU** (Selective Forwarding Unit) rather than direct peer-to-peer connections. The browser connects to LiveKit directly for audio, and to the Python server (via nginx) for everything else (chat, position, items, auth).

---

## 1. Prerequisites

- Docker with Compose plugin (`docker compose version`)
- Git

---

## 2. Clone and Configure

```bash
git clone <repo-url> chat_grid
cd chat_grid

cp .env.example .env
```

Edit `.env`:

```env
# Generate a secret: openssl rand -hex 32
CHGRID_AUTH_SECRET=your-long-random-secret-here

# The URL your browser uses to reach the app (no trailing slash)
# Use http://localhost for local-only access
CHGRID_HOST_ORIGIN=https://your-domain.com

# LiveKit SFU settings — keys must match livekit.yaml
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=a]3jK$2pL9mN#vQ8wR5tY7uI0oP4sD6fG

# LiveKit URL as seen by the browser (not Docker-internal).
# Local: ws://localhost:7880
# Production behind Caddy: wss://livekit.your-domain.com
LIVEKIT_URL=ws://localhost:7880
```

### LiveKit credentials

The default `livekit.yaml` ships with a dev key pair (`devkey` / `a]3jK$2pL9mN#vQ8wR5tY7uI0oP4sD6fG`). For production, generate your own:

```bash
# Pick any key name and a long random secret
echo "mykey: $(openssl rand -base64 32)"
```

Put the key/secret in both `livekit.yaml` (under `keys:`) and `.env` (`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`).

---

## 3. Build and Start

```bash
docker compose up --build -d
```

This builds the server and client images, pulls the LiveKit image, and starts all three containers:

| Container | Purpose | Ports |
|---|---|---|
| `client` (nginx) | Static files + WebSocket proxy | `127.0.0.1:4474 → 80` |
| `server` (Python) | Game logic, auth, token generation | Internal only |
| `livekit` | Audio SFU | `7880`, `7881/tcp`, `7882/udp` |

---

## 4. Bootstrap the First Admin

This only needs to be run once on first startup:

```bash
docker compose exec server python main.py --bootstrap-admin
```

Follow the prompts to create the initial admin account.

---

## 5. Open the App

- **Local:** http://localhost:4474
- **With Caddy:** https://your-domain.com (after step 6)

Log in with the admin credentials you just created.

---

## 6. Production: Caddy Reverse Proxy (HTTPS)

For production you need Caddy (or another reverse proxy) in front of both nginx and LiveKit. You need **two domains** (or a domain + subdomain):

- One for the app (e.g. `your-domain.com`)
- One for LiveKit (e.g. `livekit.your-domain.com`)

### Caddyfile

```caddyfile
your-domain.com {
    reverse_proxy localhost:4474
}

livekit.your-domain.com {
    reverse_proxy localhost:7880
}
```

Caddy automatically:
- Provisions TLS certificates via Let's Encrypt
- Forwards WebSocket upgrade headers (no extra config needed)
- Passes app traffic (static files + `/ws`) to nginx on port 4474
- Passes LiveKit signaling to port 7880

After editing your Caddyfile:

```bash
caddy reload --config /etc/caddy/Caddyfile
```

### Update `.env` for production

```env
CHGRID_HOST_ORIGIN=https://your-domain.com
LIVEKIT_URL=wss://livekit.your-domain.com
```

Then restart the server to pick up the new LiveKit URL:

```bash
docker compose up -d server
```

### Firewall / port forwarding

The following ports must be reachable from the internet:

| Port | Protocol | Purpose |
|---|---|---|
| 443 | TCP | Caddy HTTPS (app + LiveKit signaling) |
| 7881 | TCP | LiveKit media (TCP fallback) |
| 7882 | UDP | LiveKit media (primary, WebRTC) |

If you are **not** using Caddy in front of LiveKit (i.e. clients connect to LiveKit directly without TLS), also open port **7880** (TCP).

> **Note:** The old peer-to-peer WebRTC setup required users to have a direct network path to each other. With LiveKit, all media goes through the server, so users behind NAT connect without issue as long as they can reach the ports above.

---

## 7. Persistence

User data (SQLite DB, `items.json`) is stored in a named Docker volume called `server-runtime`. It survives container restarts and rebuilds:

```bash
docker compose restart   # data is preserved
docker compose up --build -d   # rebuild images, data is preserved
```

To inspect or back up the volume:

```bash
docker volume inspect chat_grid_server-runtime
```

---

## Common Commands

```bash
# View logs
docker compose logs -f

# View server logs only
docker compose logs -f server

# View LiveKit logs only
docker compose logs -f livekit

# Stop everything
docker compose down

# Stop and delete the data volume (destructive)
docker compose down -v

# Rebuild after code changes
docker compose up --build -d
```

---

## Troubleshooting

**WebSocket won't connect / "Disconnected" status**
- Check that `CHGRID_HOST_ORIGIN` in `.env` exactly matches the URL in your browser (including `http`/`https` and no trailing slash).
- Check server logs: `docker compose logs server`

**No audio / "LiveKit disconnected"**
- Verify `LIVEKIT_URL` in `.env` is reachable from the browser (not a Docker-internal hostname like `livekit:7880`).
- Check LiveKit logs: `docker compose logs livekit`
- For production, make sure ports 7881/tcp and 7882/udp are open and forwarded.
- If behind Caddy, make sure the LiveKit subdomain is configured and `LIVEKIT_URL` uses `wss://`.

**LiveKit secret mismatch**
- The key/secret in `.env` (`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`) must exactly match what is in `livekit.yaml` under `keys:`.

**Changing the host port**
- The client binds to `127.0.0.1:4474` by default. To use a different port, change `"127.0.0.1:4474:80"` in `docker-compose.yml` and update your Caddy `reverse_proxy` target to match.

**Admin bootstrap fails**
- Make sure the server container is healthy first: `docker compose ps`
