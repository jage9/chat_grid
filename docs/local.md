# Local Development

## Start Server

```bash
cd /home/jjm/code/chgrid/server
.venv/bin/python main.py --allow-insecure-ws
```

## Start Client

```bash
cd /home/jjm/code/chgrid/client
npm run dev
```

Open: `http://localhost:5173`

Defaults:
- Server reads `config.toml` automatically when present.
- Server default bind/port is `127.0.0.1:8765`.
- Server defaults to TLS-required unless you set `network.allow_insecure_ws=true` or pass `--allow-insecure-ws` for local/dev.
- In local/dev insecure mode (`allow_insecure_ws=true`), websocket Origin allowlist defaults to `http://localhost:5173` and `http://127.0.0.1:5173` when `network.allowed_origins` is empty.
- Client dev default is `localhost:5173`.
- Auth requires `CHGRID_AUTH_SECRET` in environment.
- Saved login uses server-managed `HttpOnly` cookie (`chgrid_session_token`) via `GET /auth/session/set` and `GET /auth/session/clear` (both require `X-Chgrid-Auth-Client: 1`).

## Quick Restarts

Server:
```bash
lsof -tiTCP:8765 -sTCP:LISTEN | xargs -r kill
cd /home/jjm/code/chgrid/server
nohup .venv/bin/python main.py --allow-insecure-ws > /tmp/chgrid-server.log 2>&1 &
```

Client:
```bash
lsof -tiTCP:5173 -sTCP:LISTEN | xargs -r kill
cd /home/jjm/code/chgrid/client
nohup npm run dev > /tmp/chgrid-client.log 2>&1 &
```
