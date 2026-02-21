# Item Types

This is behavior-focused documentation for item types and their defaults.

## Shared Item Behavior

- Items are server-authoritative.
- Global per-type fields are injected by the server and are not persisted per-instance:
  - `capabilities`
  - `useSound`
  - `emitSound`
  - `useCooldownMs` (from item catalog)
- Instance fields are persisted in `server/runtime/items.json`.

## `radio_station`

### Defaults
- Title: `radio`
- Params:
  - `streamUrl=""`
  - `enabled=true`
  - `channel="stereo"`
  - `volume=50`
  - `effect="off"`
  - `effectValue=50`
- Global:
  - `useSound=none`
  - `emitSound=none`
  - `useCooldownMs=1000`

### Use
- `use` toggles `enabled` on/off and broadcasts chat status.

### Validation
- `channel`: `stereo | mono | left | right`
- `volume`: integer `0..100`
- `effect`: `reverb | echo | flanger | high_pass | low_pass | off`
- `effectValue`: number `0..100` with `0.1` precision

## `dice`

### Defaults
- Title: `Dice`
- Params:
  - `sides=6`
  - `number=2`
- Global:
  - `useSound=sounds/roll.ogg`
  - `emitSound=none`
  - `useCooldownMs=1000`

### Use
- Rolls `number` dice with `sides` sides and reports values + total.

### Validation
- `sides`: integer `1..100`
- `number`: integer `1..100`

## `wheel`

### Defaults
- Title: `wheel`
- Params:
  - `spaces="yes, no"`
- Global:
  - `useSound=sounds/spin.ogg`
  - `emitSound=none`
  - `useCooldownMs=4000`

### Use
- Announces spin immediately.
- Result is sent after delay.

### Validation
- `spaces`: comma-delimited values
- At least 1 entry
- Max 100 entries
- Max 80 chars per entry

## `clock`

### Defaults
- Title: `clock`
- Params:
  - `timeZone="America/Detroit"`
  - `use24Hour=false`
- Global:
  - `useSound=none`
  - `emitSound=sounds/clock.ogg`
  - `useCooldownMs=1000`

### Use
- Reports current time from item timezone and format.

### Validation
- `timeZone`: one of `CLOCK_TIME_ZONE_OPTIONS` in `server/app/item_catalog.py`
- `use24Hour`: boolean or on/off style input

## Adding A New Item Type (Registry V1)

Item types are currently code-registered on both server and client so new types are additive instead of editing one large branch.

1. Server catalog: add global defaults in `server/app/item_catalog.py` (`ITEM_DEFINITIONS`).
2. Server handlers: add `validate_update` + `use` logic in `server/app/item_type_handlers.py` and register it in `ITEM_TYPE_HANDLERS`.
3. Server models: extend `ItemType` literals in `server/app/models.py` and any packet enums that list item types.
4. Client registry: add type metadata in `client/src/items/itemRegistry.ts` (`ITEM_TYPE_SEQUENCE`, editable properties, and global property hints).
5. Client protocol types: update item-type unions in `client/src/network/protocol.ts` and `client/src/state/gameState.ts`.
6. Tests: add or update server tests under `server/tests/` for use/update validation and cooldown behavior.

### Example Shape

A minimal new item type usually needs:

- Catalog defaults:
  - `default_title`
  - `default_params`
  - `use_sound` / `emit_sound`
  - `use_cooldown_ms`
- Handler behavior:
  - validate params on update
  - build self/others use messages
  - optionally return delayed result text
