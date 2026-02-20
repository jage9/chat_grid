# Rewrite Plan: Modern Cross-Browser Spatial Grid

## What This Code Is Today
The current code is a functional prototype: one large HTML file with tightly coupled UI/game/network/audio logic, plus a single Python signaling script. It proves the concept, but it is hard to test, hard to evolve safely, and brittle across browser differences.
At its core, the product is a realtime spatial chat grid with movement and command-driven interaction.

## Rewrite Strategy (No Backward-Compatibility Constraints)
Build a new app in parallel, then cut over once parity + quality gates pass.
V1 explicitly ships without TURN relay infrastructure.
Design the new core so future features (objects, pickups, walls, collisions, and interaction rules) can be added without architectural rework.

## Target Architecture
- `client/`: TypeScript + Vite + Canvas renderer + state store.
- `server/`: Python signaling service using `websockets` (schema-validated).
- `shared/`: Message contracts (JSON schema + generated TS types).
- `tests/`: Unit + Playwright E2E (Chromium, Firefox, WebKit).
- `docs/`: Browser compatibility matrix and ops runbook.
- Core domain model:
  - world map + tile metadata (walkable/blocked/zone)
  - entities (`player`, `object`, future NPC/system entities)
  - actions/commands (move, rename, locate, interact, pickup, use)
  - simulation rules (movement, collision, proximity effects)

## Technology Choices
- Client: TypeScript, Vite, ESLint, Prettier, Vitest.
- Realtime: WebSocket signaling + WebRTC media.
- Server runtime: Python + `websockets`.
- Validation: Zod/JSON Schema for all inbound/outbound messages.
- Deployability: Environment-based config only (no hardcoded cert paths).
- ICE for v1: STUN-only (`stun:stun.l.google.com:19302`) with robust retry and failure handling.

## Phases

### Phase 1: Parity Baseline + Browser Hardening (5-8 days)
- Scaffold monorepo structure.
- Define protocol schemas: `welcome`, `signal`, `update_position`, `update_nickname`, `user_left`.
- Implement strict server validation and structured logging.
- Rebuild current behavior with parity:
  - grid render + movement + presence sync
  - existing commands: `c`, `l`, `shift+l`, `u`, `n`, `m`, `escape`
  - nickname flow and reconnect/disconnect behavior
- Cross-browser hardening for latest Chrome/Edge/Firefox/Safari:
  - keyboard handling via `event.code`
  - capability checks for `setSinkId`, `StereoPannerNode`, autoplay/permissions differences
  - explicit no-TURN recovery UX and bounded retry/backoff
- Keep grid/presence functional even if voice fails on restrictive networks.
- V1 server requirements (Python-focused):
  - Use Python `websockets` for signaling transport.
  - Enforce strict message validation (Pydantic/JSON schema) on receive and send.
  - Add structured logging and websocket behavior tests.

### Phase 2: World + Extensibility Architecture (3-5 days)
- Introduce world + entity foundation:
  - tile map abstraction with collision checks
  - player entity and object entity schema
  - action dispatcher for current commands and future interactions
- Keep simulation pure and testable (state in, state out).

### Phase 3: Advanced Audio + WebRTC Robustness (2-4 days)
- Implement peer connection manager and retry/timeout policy.
- Build browser capability layer:
  - `setSinkId` optional
  - `StereoPannerNode` optional
  - autoplay/promise failure handling
- Graceful degradation: if unsupported, keep grid/presence fully functional and reduce to basic audio.
- Implement explicit no-TURN recovery UX:
  - Detect ICE `failed`/`disconnected` states and auto-retry with bounded backoff.
  - Surface actionable status text (network-restricted, retrying, voice unavailable).
  - Keep text/status + grid presence fully functional when voice cannot connect.

### Phase 4: Quality Gates (2-4 days)
- Unit tests for state, protocol, input, and audio math.
- Playwright multi-user E2E in Chromium/Firefox/WebKit.
- Add CI for lint, typecheck, unit tests, and cross-browser smoke tests.
- Add world-rule tests:
  - wall collision and blocked-tile movement rejection
  - object pickup/use action validation
  - deterministic command outcomes

### Phase 5: Cutover (1-2 days)
- Deploy rewrite behind new route or domain.
- Run soak tests and monitor connection/error metrics.
- Decommission old prototype once stable.

## Definition of Done
- Grid + movement + presence stable in latest Chrome, Edge, Firefox, Safari.
- Audio works where supported and degrades cleanly where not.
- Zero runtime dependence on inline scripts or CDN Tailwind runtime.
- One-command local startup and passing CI.
- Known no-TURN limitation documented: some restrictive NAT/firewall networks may not establish voice.

## Post-v1 TURN Trigger
Add TURN when either condition is met:
- Voice connection failure rate exceeds agreed threshold in production telemetry.
- Target users include enterprise/school/mobile networks where relay need is expected.

## Recommended First PR
Create repo skeleton + protocol schema + server validator + parity client slice that renders grid, syncs positions, and supports current commands.

## Recommended Second PR
Add browser hardening completion (capability fallbacks, reconnect UX) and Playwright parity tests across Chromium/Firefox/WebKit.
