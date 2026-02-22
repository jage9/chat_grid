# Item Schema

## World Item (server-authoritative)

```json
{
  "id": "string",
  "type": "radio_station | dice | wheel | clock | widget",
  "title": "string",
  "x": 0,
  "y": 0,
  "createdBy": "user-id",
  "createdAt": 1735689600000,
  "updatedAt": 1735689600000,
  "version": 1,
  "capabilities": ["editable", "carryable", "deletable", "usable"],
  "useSound": "sounds/roll.ogg",
  "emitSound": "sounds/clock.ogg",
  "params": {},
  "carrierId": null
}
```

- `useSound`: optional client-played one-shot sound when item `use` succeeds; global item field and not user-editable in V1.
- `emitSound`: optional continuously-looping spatial sound emitted from the item on the grid; global item field and not user-editable in V1.
- `capabilities`, `useSound`, and `emitSound` are derived from global item-type definitions at runtime (not stored per-instance in persisted state).
- `useCooldownMs`: global per item type (`radio_station=1000`, `dice=1000`, `wheel=4000`, `clock=1000`, `widget=1000`), not per-instance editable.
- `emitRange`: global spatial range default per item type (`radio_station=20`, `dice=15`, `wheel=15`, `clock=10`, `widget=15`).
  - `radio_station` can override this per instance via `params.emitRange` (`5..20`).
- `directional`: global directional attenuation flag per item type (`radio_station=true`, others `false`); `widget` can override per instance via `params.directional`.

## Persisted Item State (`server/runtime/items.json`)

```json
{
  "id": "string",
  "type": "radio_station | dice | wheel | clock | widget",
  "title": "string",
  "x": 0,
  "y": 0,
  "createdBy": "user-id",
  "createdAt": 1735689600000,
  "updatedAt": 1735689600000,
  "version": 1,
  "params": {},
  "carrierId": null
}
```

- Persisted state stores only instance data.
- Global/type-level properties are loaded from server registry in `server/app/item_catalog.py`.
- Per-type use/update validation and message behavior are implemented in per-item modules under `server/app/items/` and wired in `server/app/items/registry.py`.
- Client-side add/edit metadata is handled in `client/src/items/itemRegistry.ts`.
- End-to-end add-item template: `docs/item-type-template.md`.

## Type Params

### `radio_station`

```json
{
  "streamUrl": "",
  "enabled": true,
  "mediaChannel": "stereo",
  "mediaVolume": 50,
  "mediaEffect": "off",
  "mediaEffectValue": 50,
  "facing": 0,
  "emitRange": 20
}
```

- `streamUrl`: string, empty allowed until configured.
- `enabled`: boolean on/off flag.
  - UI behavior: in property menu, `Enter` toggles on/off directly.
- `mediaVolume`: integer, range `0-100`, default `50`.
- `mediaChannel`: one of `stereo | mono | left | right`, default `stereo`.
- `mediaEffect`: one of `reverb | echo | flanger | high_pass | low_pass | off`, default `off`.
- `mediaEffectValue`: number, range `0-100`, precision `0.1`.
- `facing`: number, range `0-360`, precision `0.1` (used when `directional=true`).
- `emitRange`: integer, range `5-20`, default `20`.

### `dice`

```json
{
  "sides": 6,
  "number": 2
}
```

- `sides`: integer, range `1-100`.
- `number`: integer, range `1-100`.

### `wheel`

```json
{
  "spaces": "yes, no"
}
```

- `spaces`: comma-delimited string of values.
- Server validation:
  - must include at least 1 value
  - max 100 values
  - each value max 80 chars

### `clock`

```json
{
  "timeZone": "America/Detroit",
  "use24Hour": false
}
```

- `timeZone`: one representative IANA zone per world UTC offset. Includes:
  `America/Anchorage`, `America/Argentina/Buenos_Aires`, `America/Chicago`, `America/Detroit`,
  `America/Halifax`, `America/Indiana/Indianapolis`, `America/Kentucky/Louisville`,
  `America/Los_Angeles`, `America/St_Johns`, `Asia/Bangkok`, `Asia/Dhaka`, `Asia/Dubai`,
  `Asia/Hong_Kong`, `Asia/Kabul`, `Asia/Karachi`, `Asia/Kathmandu`, `Asia/Kolkata`,
  `Asia/Seoul`, `Asia/Singapore`, `Asia/Tehran`, `Asia/Tokyo`, `Asia/Yangon`,
  `Atlantic/Azores`, `Atlantic/South_Georgia`, `Australia/Brisbane`, `Australia/Darwin`,
  `Australia/Eucla`, `Australia/Lord_Howe`, `Europe/Berlin`, `Europe/Helsinki`,
  `Europe/London`, `Europe/Moscow`, `Pacific/Apia`, `Pacific/Auckland`, `Pacific/Chatham`,
  `Pacific/Honolulu`, `Pacific/Kiritimati`, `Pacific/Noumea`, `Pacific/Pago_Pago`, `UTC`.
- `use24Hour`: boolean (or `on/off` in updates), default `false`.
- Global defaults: `useSound=none`, `emitSound=sounds/clock.ogg`.

### `widget`

```json
{
  "enabled": true,
  "directional": false,
  "facing": 0,
  "emitRange": 15,
  "emitVolume": 100,
  "emitSoundSpeed": 50,
  "emitSoundTempo": 50,
  "emitEffect": "off",
  "emitEffectValue": 50,
  "useSound": "",
  "emitSound": ""
}
```

- `enabled`: boolean (or `on/off` in updates), default `true`.
- `directional`: boolean (or `on/off` in updates), default `false`.
- `facing`: number, range `0-360`, precision `0.1`.
- `emitRange`: integer, range `1-20`, default `15`.
- `emitVolume`: integer, range `0-100`, default `100`.
- `emitSoundSpeed`: integer, range `0-100`, default `50`; controls emitted sound speed/pitch (`0=0.5x`, `50=1.0x`, `100=2.0x`).
- `emitSoundTempo`: integer, range `0-100`, default `50`; controls emitted sound tempo (`0=0.5x`, `50=1.0x`, `100=2.0x`).
- `emitEffect`: one of `reverb | echo | flanger | high_pass | low_pass | off`, default `off`.
- `emitEffectValue`: number, range `0-100`, precision `0.1`, default `50`.
- `useSound`: empty, filename (assumed under `sounds/`), or full URL.
- `emitSound`: empty, filename (assumed under `sounds/`), or full URL.

## Packet Shapes

- `item_upsert`:

```json
{
  "type": "item_upsert",
  "item": { "..." : "World Item" }
}
```

- `item_remove`:

```json
{
  "type": "item_remove",
  "itemId": "item-id"
}
```

- `item_action_result`:

```json
{
  "type": "item_action_result",
  "ok": true,
  "action": "add | pickup | drop | delete | use | update",
  "message": "human-readable status",
  "itemId": "optional-item-id"
}
```

- `item_use_sound`:

```json
{
  "type": "item_use_sound",
  "itemId": "item-id",
  "sound": "sounds/roll.ogg",
  "x": 12,
  "y": 8
}
```
