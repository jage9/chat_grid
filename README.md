# Chat Grid

Realtime spatial chat grid with:
- `client/` TypeScript web app
- `server/` Python websocket signaling server

## Local Run

1) Start server
```bash
cd server
cp config.example.toml config.toml
uv run python main.py --config config.toml
```

2) Start client
```bash
cd client
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

3) Open `http://localhost:5173`

## Production Deploy (quick path)

Use `deploy/README.md`.

Summary:
1. Copy repo to `/home/bestmidi/chgrid`.
2. Build client and publish `client/dist/` to `/home/bestmidi/public_html/chgrid/`.
3. Configure server `config.toml` and run it via `systemd`.
4. Add Apache `/ws` websocket proxy from `deploy/apache/chgrid-vhost-snippet.conf`.

## Key Paths

- Client version: `client/public/version.js`
- Client sounds: `client/public/sounds/`
- Server config template: `server/config.example.toml`
- Server runtime items: `server/runtime/items.json`
