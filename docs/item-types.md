# Item Types

This is behavior-focused documentation for item types and their defaults.

## Shared Item Behavior

- Items are server-authoritative.
- Global per-type fields are injected by the server and are not persisted per-instance:
  - `capabilities`
  - `useSound`
  - `emitSound`
  - `useCooldownMs` (from item catalog)
  - `emitRange` (spatial range in squares)
  - `directional` (directional attenuation enabled)
- Instance fields are persisted in `server/runtime/items.json`.

## `radio_station`

### Defaults
- Title: `radio`
- Params:
  - `streamUrl=""`
  - `enabled=true`
  - `mediaChannel="stereo"`
  - `mediaVolume=50`
  - `mediaEffect="off"`
  - `mediaEffectValue=50`
  - `facing=0`
  - `emitRange=20`
- Global:
  - `useSound=none`
  - `emitSound=none`
  - `useCooldownMs=1000`
  - `emitRange=20`
  - `directional=true`

### Use
- `use` toggles `enabled` on/off and broadcasts chat status.

### Validation
- `mediaChannel`: `stereo | mono | left | right`
- `mediaVolume`: integer `0..100`
- `mediaEffect`: `reverb | echo | flanger | high_pass | low_pass | off`
- `mediaEffectValue`: number `0..100` with `0.1` precision
- `facing`: number `0..360` with `0.1` precision
- `emitRange`: integer `5..20`

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
  - `emitRange=15`
  - `directional=false`

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
  - `emitRange=15`
  - `directional=false`

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
  - `emitRange=10`
  - `directional=false`

### Use
- Reports current time from item timezone and format.

### Validation
- `timeZone`: one of `CLOCK_TIME_ZONE_OPTIONS` in `server/app/item_catalog.py`
- `use24Hour`: boolean or on/off style input

## `widget`

### Defaults
- Title: `widget`
- Params:
  - `enabled=true`
  - `directional=false`
  - `facing=0`
  - `emitRange=15`
  - `emitVolume=100`
  - `emitSoundSpeed=50`
  - `emitSoundTempo=50`
  - `emitEffect="off"`
  - `emitEffectValue=50`
  - `useSound=""`
  - `emitSound=""`
- Global:
  - `useSound=none`
  - `emitSound=none`
  - `useCooldownMs=1000`
  - `emitRange=15`
  - `directional=false`
  - `emitSoundSpeed=50`
  - `emitSoundTempo=50`

### Use
- `use` toggles `enabled` on/off and plays `useSound` when configured.

### Validation
- `enabled`: boolean or on/off style input
- `directional`: boolean or on/off style input
- `facing`: number `0..360` with `0.1` precision
- `emitRange`: integer `1..20`
- `emitVolume`: integer `0..100`
- `emitSoundSpeed`: integer `0..100` (`0=0.5x`, `50=1.0x`, `100=2.0x`) for speed/pitch
- `emitSoundTempo`: integer `0..100` (`0=0.5x`, `50=1.0x`, `100=2.0x`) for tempo
- `emitEffect`: `reverb | echo | flanger | high_pass | low_pass | off`
- `emitEffectValue`: number `0..100` with `0.1` precision
- `useSound`: empty, filename (assumed under `sounds/`), or full URL
- `emitSound`: empty, filename (assumed under `sounds/`), or full URL

## Adding A New Item Type (Registry V1)

Item types are currently code-registered on both server and client. Server item logic is split per item module and wired through one registry.

For a full copy/paste example with plain-English explanation, see `docs/item-type-template.md`.

1. Server item module: add a new file under `server/app/items/` with:
   - defaults/capabilities
   - property metadata/options
   - `validate_update` and `use_item`
2. Server registry: add one entry in `server/app/items/registry.py`:
   - `ITEM_MODULES`
   - `ITEM_TYPE_ORDER` (if ordering changes)
3. Server models: extend `ItemType` literals in `server/app/models.py` and any packet enums that list item types.
4. Client fallback registry: add type defaults in `client/src/items/itemRegistry.ts` (`DEFAULT_ITEM_TYPE_SEQUENCE`, editable/global fallback metadata).
5. Client protocol/state types: update item-type unions in `client/src/network/protocol.ts` and `client/src/state/gameState.ts`.
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
