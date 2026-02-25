# Audio Architecture Update Proposal

Date: 2026-02-25

## Goals

1. Fix correctness issues first (sound origin for carried items).
2. Improve runtime stability without increasing server/upstream load.
3. Reduce duplicate work in audio runtime (shared streams, cached effects).
4. Keep server-first boundaries clear and avoid client/server drift.

## Proposed Implementation Sequence

### Phase 1: Correctness + low-risk fixes

1. Carried-item `useSound` source position (server)
- Problem: `item_use_sound` currently uses `item.x/y`, which can be stale while carried.
- Change: resolve source position via carrier when `carrierId` is set, same pattern as piano.
- Files:
  - `server/app/server.py`
- Acceptance:
  - Using a carried item emits sound from carrier’s current square for all listeners.

2. Stream retry policy hardening (client)
- Status: partially done (throttled retry + cap + cooldown).
- Follow-up:
  - Add small inline debug counters in runtime (non-user-facing unless debug enabled).
  - Ensure cooldown reset after successful play and cleanup path reset are covered by tests.
- Files:
  - `client/src/audio/radioStationRuntime.ts`
  - `client/src/audio/itemEmitRuntime.ts`
- Acceptance:
  - No retry spam under repeated failures.
  - Retry state recovers automatically when playback succeeds.

### Phase 2: Performance and scaling improvements

3. Emit source strategy 
removed

4. Reverb impulse cache (client)
- Problem: effect chain rebuilds can recreate impulse buffers frequently.
- Change: cache impulse responses by `(sampleRate, effectValueBucket)` in `effects.ts`.
- Files:
  - `client/src/audio/effects.ts`
- Acceptance:
  - Effect toggling no longer repeatedly regenerates same impulse buffers.
  - No audible regressions in reverb behavior.

### Phase 3: Consistency and maintainability

5. Centralize sound URL normalization policy
- Problem: normalization logic exists in multiple places (server validator + client resolver + proxy behavior).
- Change:
  - Define one policy doc and align implementation points:
    - server validation/normalization
    - client runtime resolution
    - proxy Dropbox/http normalization behavior
  - Move server normalization logic to shared item-sound helper(s), not tied to a specific item type module.
- Files:
  - `server/app/items/...` shared validator/normalizer helper module
  - per-item validators (`widget`, `radio_station`, and future sound-accepting items) call shared helper
  - `client/src/main.ts` (`resolveIncomingSoundUrl`)
  - `deploy/php/media_proxy.php`
  - `docs/protocol-notes.md` or new dedicated audio policy section
- Acceptance:
  - Same input URL/path yields predictable behavior across use/emit/radio.
  - Fewer edge mismatches (`none/off`, `sounds/`, full URLs, Dropbox links).

### Phase 4: Output routing + observability (defer)

6. Output-device routing behavior
- Problem: `setSinkId` on muted element may not map to all WebAudio-rendered domains.
- Change options:
  - A: Explicitly document browser limitation + current behavior.
  - B: Investigate alternate routing architecture and apply if robust in target browsers.
- Recommendation:
  - Ship A first (fast, clear UX), then evaluate B separately.
- Files:
  - `docs/controls.md` and/or `docs/runtime-flow.md`
  - optional runtime status text in settings UI
- Acceptance:
  - Users get accurate expectation of output-device behavior.

7. Audio runtime debug observability
- Change:
  - Add optional debug object/report for:
    - active radio shared sources
    - active emit outputs/shared sources
    - retry failures and cooldown state
  - Keep disabled by default.
- Files:
  - `client/src/audio/radioStationRuntime.ts`
  - `client/src/audio/itemEmitRuntime.ts`
  - optional small hook in `main.ts` for debug dump command
- Acceptance:
  - Runtime state can be inspected quickly during field troubleshooting.

## Risks and Mitigation

1. Shared emit pooling could accidentally couple per-item controls.
- Mitigation: maintain per-item gain/effect nodes after shared source split.

2. Output routing changes can be browser-fragile.
- Mitigation: document-first rollout, then narrow-scope prototype for alternate routing.

3. Normalization centralization can break legacy links.
- Mitigation: add targeted tests for representative URL/path cases before refactor.

## Suggested PR/Commit Breakdown

1. Carried-item sound origin fix (server).
2. Emit shared source pooling.
3. Reverb impulse cache.
4. Sound normalization alignment (server/client/proxy + docs).
5. Output routing docs/UX clarification.
6. Optional debug observability layer.

## Definition of Done

1. Carried item sounds always originate from current carrier position.
2. No unbounded retry loops for stream failures.
3. Emit runtime reuses identical stream URLs.
4. Reverb buffer creation is cached and stable under effect churn.
5. Sound URL/path behavior is documented and consistent across server/client/proxy.
6. Audio runtime state is inspectable when debugging is enabled.
