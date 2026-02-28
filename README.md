#Chat Grid
##A Mostly Vibed, Audio-first Interactive Playground

Chat Grid is one of those projects that started with a random idea, and then grew to be many things, but most with spacial audio as its core. Briefly put, Chat Grid allows users to move around a grid and interact with each other, or with items placed on the grid. Your voice, as well as items are shared as positional audio. Item types currently range from dice and a wheel to a fully-playable toy piano and media players with directional audio. New item types can be added as plugins.

Chat Grid is designed to be run on a secure server with users connecting via a web client. The client works best currently with Windows browsers, with minimal testing on mobile/Mac. Ideally, client apps would be better in the long-run, especially for mobile.

## Local Run

1) Start server
```bash
cd server
cp config.example.toml config.toml
uv run python main.py --allow-insecure-ws
```

2) Start client
```bash
cd client
npm install
npm run dev
```

3) Open `http://localhost:5173`

Notes:
- Server defaults to `config.toml` when present.
- Server bind/port defaults are `127.0.0.1:8765` unless changed in config or CLI flags.
- Client dev defaults to Vite local host/port (`localhost:5173`) unless flags override.
- Auth requires `CHGRID_AUTH_SECRET` in server environment; `deploy/scripts/install_server.sh` creates `server/.env` with this value automatically if missing.

Common server overrides:
- `uv run python main.py --config /path/to/config.toml`
- `uv run python main.py --host 0.0.0.0 --port 9000`
- `uv run python main.py --allow-insecure-ws` (local/dev without TLS)
- `uv run python main.py --ssl-cert /path/fullchain.pem --ssl-key /path/privkey.pem`
- `uv run python main.py --bootstrap-admin` (one-time admin creation)

## Production Deploy (quick path)

Use `deploy/README.md`.

Summary:
1. Copy repo to your server.
2. Build client and publish `client/dist/` to your web root/subdirectory.
3. Configure server `config.toml` and run it via `systemd`.
4. Add Apache `/ws` websocket proxy from `deploy/apache/chgrid-vhost-snippet.conf`.

## Key Paths

- Client version: `client/public/version.js`
- Client sounds: `client/public/sounds/`
- Server config template: `server/config.example.toml`
- Server runtime items: `server/runtime/items.json`

## Documentation

- Controls/keymap: `docs/controls.md`
- Audio architecture and layers: `docs/audio-architecture.md`
- Item behavior by type: `docs/item-types.md`
- Runtime lifecycle flow: `docs/runtime-flow.md`
- Protocol behavior notes: `docs/protocol-notes.md`
- Item schema reference: `docs/item-schema.md`
- Local dev commands: `docs/local.md`

##Contributing
Contributions and ideas are welcome. The grid is already home to several rather absurd ideas, and yours may fit right in. Please look over the docs and other files for guidance, or ask for help.

##Notes on AI Coding
This project has been largely coded using AI tools, with a lot of human prompting and hand-holding to enforce best practices. All ideas for improving the project or its design are welcome.

## License
- MIT
This project is licensed under the MIT License. See `LICENSE`.
