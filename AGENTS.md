# Repository Guidelines

## Project Structure & Module Organization
- `client/`: Vite + TypeScript web app.
  - `src/main.ts`: connect flow, key commands, status/audio cues.
  - `src/audio`, `src/network`, `src/state`, `src/render`, `src/webrtc`, `src/input`: feature modules.
  - `public/version.js`: single source of truth for web version.
  - `public/sounds/`: all client sound assets.
- `server/`: Python signaling service.
  - `app/server.py`: websocket lifecycle + packet routing.
  - `app/client.py`: client connection model.
  - `app/item_service.py`: item persistence + hydration.
  - `app/item_catalog.py`: global item-type properties.
  - `app/models.py`: packet/data schemas.
- `deploy/`: Apache snippet + systemd unit examples.

## Build, Test, and Development Commands
- Client dev: `cd client && npm install && npm run dev -- --host 0.0.0.0 --port 5173`
- Client build: `cd client && npm run build`
- Server run: `cd server && cp config.example.toml config.toml && uv run python main.py --config config.toml`
- Server tests: `cd server && uv run --extra dev pytest`

## Coding Style & Naming Conventions
- TypeScript: strict typing, `camelCase`, small focused modules.
- Python: PEP 8, 4 spaces, `snake_case`, typed Pydantic models.
- Keep protocol changes synced in `client/src/network/protocol.ts` and `server/app/models.py`.

## Versioning & Configuration
- Bump `client/public/version.js` on every user-visible change using `YYYY.MM.DD Rn`.
- Do not duplicate version constants elsewhere in client code.
- `server/config.toml` is deployment-local and must not be committed.
- Production should use TLS (`network.allow_insecure_ws = false`).

## Audio Asset Rules
- Keep all runtime sounds in `client/public/sounds/`.
- Reference sounds as absolute web paths (example: `/sounds/roll.ogg`).
