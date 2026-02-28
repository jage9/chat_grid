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
- Read-only inspect fields include `createdBy` and `updatedBy` for ownership/change tracking.

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
  - `stationName=""` (server-managed, read-only)
  - `nowPlaying=""` (server-managed, read-only)
  - `facing=0`
  - `emitRange=10`
- Global:
  - `useSound=none`
  - `emitSound=none`
  - `useCooldownMs=1000`
  - `emitRange=10`
  - `directional=true`

### Use
- `use` toggles `enabled` on/off and broadcasts chat status.
- `secondary use` reports now-playing metadata (`Playing <song> from <station>`), or `<title> is off` when disabled.

### Validation
- `mediaChannel`: `stereo | mono | left | right`
- `mediaVolume`: integer `0..100`
- `mediaEffect`: `reverb | echo | flanger | high_pass | low_pass | off`
- `mediaEffectValue`: number `0..100` with `0.1` precision
  - Visible only when `mediaEffect != off` (`visibleWhen: {"mediaEffect": "!off"}`)
- `facing`: number `0..360` with step `1`
- `emitRange`: integer `5..20`
- `stationName` / `nowPlaying`: server-fetched metadata fields; not editable by clients.

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
  - `topOfHourAnnounce=true`
  - `alarmEnabled=false`
  - `alarmTime="12:00 AM"`
- Global:
  - `useSound=none`
  - `emitSound=sounds/clock.ogg`
  - `useCooldownMs=1000`
  - `emitRange=10`
  - `directional=false`

### Use
- Broadcasts a spoken EL640-style time announcement as spatial audio from the clock position.
- No text chat line is emitted for clock `use`.

### Validation
- `timeZone`: one of `CLOCK_TIME_ZONE_OPTIONS` in `server/app/item_catalog.py`
- `use24Hour`: boolean or on/off style input
- `topOfHourAnnounce`: boolean or on/off style input
- `alarmEnabled`: boolean or on/off style input
- `alarmTime`: `HH:MM` when `use24Hour=true`, otherwise `H:MM AM/PM`
  - Visible only when `alarmEnabled=true` (`visibleWhen: {"alarmEnabled": true}`)

### Audio
- Spoken clock assets live under `client/public/sounds/clock/el640/`.
- Top-of-hour routine (when enabled) uses `hour1.ogg` + time phrase + `hour2.ogg`.
- Alarm routine (when enabled and time matches) uses `announcement.ogg` + time phrase + `alarm.ogg`.

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
  - `emitInitialDelay=0`
  - `emitLoopDelay=0`
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
  - `emitInitialDelay=0`
  - `emitLoopDelay=0`

### Use
- `use` toggles `enabled` on/off and plays `useSound` when configured.

### Validation
- `enabled`: boolean or on/off style input
- `directional`: boolean or on/off style input
- `facing`: number `0..360` with step `1`
- `emitRange`: integer `1..20`
- `emitVolume`: integer `0..100`
- `emitSoundSpeed`: integer `0..100` (`0=0.5x`, `50=1.0x`, `100=2.0x`) for speed/pitch
- `emitSoundTempo`: integer `0..100` (`0=0.5x`, `50=1.0x`, `100=2.0x`) for tempo
- `emitInitialDelay`: number `0..300` with `0.1` step/precision; delay in seconds before emitted audio starts after enable
- `emitLoopDelay`: number `0..300` with `0.1` step/precision; delay in seconds between each emitted loop playback
- `emitEffect`: `reverb | echo | flanger | high_pass | low_pass | off`
- `emitEffectValue`: number `0..100` with `0.1` precision
- `useSound`: empty, filename (assumed under `sounds/`), or full URL
- `emitSound`: empty, filename (assumed under `sounds/`), or full URL

## `piano`

### Defaults
- Title: `piano`
- Params:
  - `instrument="piano"`
  - `voiceMode="poly"`
  - `octave=0`
  - `attack=15`
  - `decay=45`
  - `release=35`
  - `brightness=55`
  - `emitRange=15`
- Global:
  - `useSound=none`
  - `emitSound=none`
  - `useCooldownMs=1000`
  - `emitRange=15`
  - `directional=false`

### Use
- Announces that the user begins playing the piano (client enters piano key mode).
- Piano mode controls include `,` to start/stop recording (max 30s) and `.` to play saved recording.
- Recordings are stored on the item (server-authoritative), so nearby users hear playback.

### Validation
- `instrument`: `piano | electric_piano | guitar | organ | bass | violin | synth_lead | brass | nintendo | drum_kit`
- `voiceMode`: `poly | mono`
- `octave`: integer `-2..2`
- `attack`: integer `0..100`
- `decay`: integer `0..100`
- `release`: integer `0..100`
- `brightness`: integer `0..100`
- `emitRange`: integer `5..20`
- Instrument changes reset `voiceMode`/`octave`/`attack`/`decay`/`release`/`brightness` to instrument defaults.

## Adding A New Item Type (Plugin Discovery)

Server is the source of truth for item type definitions and metadata. The client consumes server `welcome.uiDefinitions` and only provides UX/runtime behavior.

For a full copy/paste example with plain-English explanation, see `docs/item-type-template.md`.

1. Server item package: add a new folder under `server/app/items/types/<item_type>/` with:
   - `definition.py` (defaults/capabilities/metadata/options)
   - `validator.py` (`validate_update`)
   - `actions.py` (`use_item`)
2. Server plugin: add `server/app/items/types/<item_type>/plugin.py` exporting `ITEM_TYPE_PLUGIN` with:
   - `type`
   - `order`
   - `module`
   The server auto-discovers plugins at boot, so no central registry edit is needed.
3. Server/client protocol/state models are now string-based for item type ids; for generic types no enum/union list updates are required.
5. Client runtime behavior: add `client/src/items/types/<item_type>/behavior.ts` only if custom client runtime is needed (for example piano mode).
6. Tests: add or update server tests under `server/tests/` for use/update validation, unknown-key stripping, and `uiDefinitions` completeness.

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
