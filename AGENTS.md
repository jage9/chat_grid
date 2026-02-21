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
- Python docstrings: for `server/app` changes, include module docstring, class docstring, and docstrings for public functions/methods where behavior/contracts matter.
- Keep protocol changes synced in `client/src/network/protocol.ts` and `server/app/models.py`.

## Documentation Maintenance
- Keep behavior docs in sync in the same change when features change.
- Controls/keybindings changes: update `docs/controls.md`.
- Item behavior/defaults/validation changes: update `docs/item-types.md` and `docs/item-schema.md`.
- Runtime/protocol behavior changes: update `docs/runtime-flow.md` and/or `docs/protocol-notes.md`.

## Versioning & Configuration
- Bump `client/public/version.js` on every user-visible change using `YYYY.MM.DD Rn`.
- Commit each completed logical change; include the version bump in that same commit when client behavior changes.
- Docs-only changes do not require a version bump unless explicitly requested.
- Do not duplicate version constants elsewhere in client code.
- `server/config.toml` is deployment-local and must not be committed.
- Production should use TLS (`network.allow_insecure_ws = false`).

## Audio Asset Rules
- Keep all runtime sounds in `client/public/sounds/`.
- Reference sounds as absolute web paths (example: `/sounds/roll.ogg`).

## Changelog Policy
- Footer changelog content is sourced from `client/public/changelog.json`.
- Do not add or edit changelog lines unless the user explicitly instructs to do so.
