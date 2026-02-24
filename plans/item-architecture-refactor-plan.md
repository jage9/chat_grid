# Server-First Item Architecture Refactor Plan

## Goal
Make the **server the only source of truth** for item definitions, schema, defaults, options, validation rules, and editable behavior. The client should consume server definitions and provide UX/rendering/audio only.

This plan removes client fallback definitions and introduces a repeatable, consistent item authoring structure so adding new item types is low-risk and uniform.

## Target End State

### 1) Source of truth
- Server owns, for each item type:
  - Type id, label, tooltip
  - Full property schema (value type, required/optional, min/max/step, maxLength, enum options)
  - Defaults (global + per-item initial params)
  - Editability and read-only behavior
  - Validation, normalization, migration policy (if any)
  - Runtime actions (`use`, optional custom actions)
  - Capability list
- Server sends this as canonical `uiDefinitions` + schema metadata on `welcome` (or equivalent bootstrap).

### 2) Client model
- Client has no static fallback item definitions.
- If schema payload is missing/invalid, item features are unavailable (explicit error/status), not silently guessed.
- Client property editor and item menus are metadata-driven.
- Client runtime behavior modules remain for UX/audio only (e.g., piano local mode), keyed by server type ids.

### 3) Repeatable item authoring
Adding an item type uses one standard server folder/template and a short checklist, with **auto-discovery** on server boot (no manual registry edits).

---

## Proposed Architecture

## A) Server: Item Type Package Contract (Auto-Discovered)
Create/standardize per-item server packages under something like:
- `server/app/items/types/<item_type>/`

Each item type package exports the same contract:
- `definition.py`
  - `type_id`, `label`, `tooltip`
  - `schema` (properties + metadata)
  - `defaults`
  - `editable_properties`
  - `capabilities`
- `validator.py`
  - `validate_create(params) -> normalized_params`
  - `validate_update(existing, patch) -> normalized_params`
  - Must drop unknown keys by default.
- `actions.py`
  - `use(context, item, client, payload?) -> result`
  - optional `custom_actions` handlers
- `ui.py` (optional if definition is enough)
  - transforms schema -> `uiDefinitions` payload fragments

A central loader in server scans `server/app/items/types/*` at boot and imports one plugin entrypoint per folder (for example `plugin.py` with `ITEM_TYPE_PLUGIN` export).

The discovered plugins are then assembled into an in-memory registry object exposing:
- validation hooks
- defaults
- ui definitions
- capabilities
- action dispatch

This means:
- adding a new item folder + plugin file is sufficient for server registration
- no hand-edited master list is required

## B) Server: Strict Params Hygiene
In update flow:
- Build next params by applying patch into current params.
- Run through type validator that:
  - strips unknown keys
  - normalizes known keys
  - enforces types/ranges/options
- Persist only validated output.

No raw client params should persist.

## C) Server: Save Strategy
Replace synchronous `save_state()` every mutation with coalesced writes:
- mark dirty on mutation
- debounce write (e.g., 100-300ms)
- cap max delay (e.g., 1-2s)
- flush on shutdown/signal

This preserves durability while reducing event-loop blocking.

## D) Client: Schema-Driven UI Runtime
Refactor client item registry/editor to consume server schema only.

Client keeps:
- Presentation helpers
- Generic item behavior path driven only by schema/metadata
- Optional per-item UX runtime modules only where needed (example: piano key mode)

Client removes:
- static defaults/options/editability lists as authority
- fallback-driven assumptions
- requirement for per-item client modules when behavior is generic

Property editor logic becomes generic:
- `valueType: boolean` -> toggle
- `valueType: list` + `options` -> list select
- `valueType: number` + `range` -> numeric editor/stepper
- `valueType: text/sound` + `maxLength` -> text editor
- `readonly` -> blocked edit with status

Special-case handlers only for UX extras (e.g., live preview for certain fields).

### D.1) Dependent Property Rules
Add dependency metadata to server schema so client can hide dependent fields generically.

Recommended metadata fields per property:
- `visibleWhen`: simple predicate (for example `{ directional: true }`)

Example:
- `facing` has `visibleWhen: { directional: true }`
- when `directional` is `false`, `facing` is hidden
- when a controlling property changes, the property menu is recomputed immediately so visibility updates live

## E) Protocol Shape (Recommended)
Ensure `welcome.uiDefinitions` includes enough to be complete:
- `itemTypes[]`
  - `type`, `label`, `tooltip`
  - `editableProperties[]`
  - `propertyMetadata{ key -> { valueType, tooltip, range, maxLength, options?, readonly?, visibleWhen? } }`
  - `globalProperties`
  - `capabilities`
- `itemTypeOrder[]`

Optional future:
- `schemaVersion` for compatibility checks.

---

## Phased Implementation Plan

## Phase 0: Preconditions and guardrails
1. Document canonical schema contract in `docs/item-schema.md`.
2. Add tests asserting unknown keys are rejected/stripped per type.
3. Add tests asserting `uiDefinitions` completeness for all registered types.

Deliverable:
- Locked schema contract and tests before heavy refactor.

## Phase 1: Server type package standardization + auto-discovery
1. Standardize all existing item types to same package contract.
2. Move any remaining type-specific logic out of generic server paths into per-type packages.
3. Add auto-discovery loader APIs:
- `get_type_definition(type_id)`
- `validate_update(type_id, existing, patch)`
- `build_ui_definitions()`
4. Loader scans item folders at startup and registers plugins automatically.

Deliverable:
- Uniform server-side item modules for all current item types.

## Phase 2: Strict validation and unknown-key stripping
1. Enforce strict allowed-key filtering in per-type validators.
2. Fail/strip behavior decision:
- recommended: strip unknown keys on load/update, optionally log at debug level.
3. Backfill tests for each type.

Deliverable:
- No unsupported params can persist.

## Phase 3: Client removes authority/fallback definitions
1. Remove client hardcoded item defaults/options as authoritative data.
2. Keep only bootstrap guards:
- if schema missing/invalid, fail item UX with explicit status (no fallback behavior).
3. Refactor `itemRegistry` to be a runtime cache of server definitions.

Deliverable:
- Client item UI driven entirely by server payload.

## Phase 4: Metadata-driven property editor + visibility dependencies
1. Replace key-specific submit/toggle/list branches with generic metadata-based handlers.
2. Keep a small optional hook map:
- `onPropertyPreviewChange(type,key,value)` for UX preview.
3. Implement `visibleWhen` semantics with live menu recompute when controlling values change.
4. Verify all current item properties work with generic editor.

Deliverable:
- Adding a new field usually requires server changes only.

## Phase 5: Behavior registry completion (optional modules)
1. Keep one generic behavior path that works for items with no special runtime.
2. Keep per-item behavior modules only when UX/audio runtime is truly custom.
3. Ensure all runtime hooks are accessed via registry interfaces.
4. Remove any remaining type checks in `main.ts` and shared handlers.

Deliverable:
- `main.ts` stays orchestration-only.

## Phase 6: Coalesced persistence
1. Implement debounced save queue in server item service.
2. Add durability tests (flush on shutdown).
3. Add config knobs (debounce ms, max delay).

Deliverable:
- lower save overhead under bursty updates.

---

## Repeatable New Item Template

When adding a new item type:

1. Server
- Create `server/app/items/types/<new_type>/`
- Implement:
  - `definition.py`
  - `validator.py`
  - `actions.py`
  - `plugin.py` (entrypoint export for auto-discovery)
- Add tests:
  - create defaults
  - update validation (valid + invalid + unknown keys)
  - `use` behavior
  - `uiDefinitions` fields present

2. Client
- Add `client/src/items/types/<newType>/behavior.ts` only if custom UX runtime exists.
- Prefer zero client type-specific code for generic items.
- If behavior module is needed, register via behavior loader pattern.
- No hardcoded property logic in editor.

3. Docs
- Update `docs/item-types.md`
- Update `docs/item-schema.md`
- Update controls docs if keybindings changed.

---

## Risks and Mitigations

1. Risk: temporary client breakage when fallback removed.
- Mitigation: explicit schema-required startup check and clear status error.

2. Risk: inconsistent schema during deploy rollover.
- Mitigation: include `schemaVersion` and reject incompatible client/server combinations with clear reconnect message.

3. Risk: over-generalized editor misses edge-case UX.
- Mitigation: keep small per-item preview hooks while generic editor handles core commit logic.

4. Risk: debounced persistence data loss on crash.
- Mitigation: short debounce + max-delay + flush on shutdown.

---

## Suggested Execution Order for Your Repo (Practical)
1. Implement strict unknown-key stripping on server (highest impact, lowest UX risk).
2. Implement server plugin auto-discovery for item type folders.
3. Convert client item registry to require server schema payload (remove fallback authority).
4. Make item property editor fully metadata-driven with dependency rules.
5. Finalize optional client behavior modules (only for custom UX items like piano).
6. Add coalesced persistence.

---

## Definition of Done
- Server item validators fully define accepted params and drop unknowns.
- Server item types are boot-loaded from folder plugins (no manual master registry edits).
- `uiDefinitions` is complete and authoritative for all item UI config.
- Client contains no authoritative item defaults/options/editability outside server payload.
- Client has no fallback schema path.
- New item addition follows one template with predictable files/tests.
- `main.ts` has no item-type-specific runtime branches.

---

## Implementation Update (2026-02-24)

### Completed
- Phase 0:
  - Added server-side contract coverage for `uiDefinitions` completeness.
  - Added/kept tests for unknown-key stripping and validation behavior.
- Phase 1:
  - Server item plugins are auto-discovered from `server/app/items/types/*/plugin.py`.
  - Registry now builds type order/modules from discovered plugins.
- Phase 2:
  - Unknown params are stripped by validators and use-path updates are revalidated before persist.
- Phase 3:
  - Client item registry now requires server `uiDefinitions`; no fallback item-definition authority.
  - Missing/invalid schema now disables item menus with explicit status.
- Phase 4:
  - Property editor behavior is metadata-driven by `valueType/range/options/maxLength`.
  - `visibleWhen` is supported and item property rows recompute live after updates.
- Phase 5:
  - Client runtime behavior remains modular per item via behavior registry; `main.ts` orchestration no longer carries item-specific business branches.
- Phase 6:
  - Coalesced/debounced state saving implemented.
  - Flush-on-shutdown implemented.
  - Save timing now configurable via:
    - `storage.state_save_debounce_ms`
    - `storage.state_save_max_delay_ms`

### Notes
- Client item-specific runtime is now reduced to only `piano`; simple items (`dice`, `wheel`, `clock`, `radio_station`, `widget`) run through generic client flows with no custom behavior module.
- Server item implementations now live inside per-type folders (`server/app/items/types/*/module.py`) and plugins point directly to those modules.
- Remaining optional future work:
  - split server type modules into `definition.py`/`validator.py`/`actions.py` files per type if we want finer-grained plugin internals.
