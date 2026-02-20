# Item Schema

## World Item (server-authoritative)

```json
{
  "id": "string",
  "type": "radio_station | dice",
  "title": "string",
  "x": 0,
  "y": 0,
  "createdBy": "user-id",
  "createdAt": 1735689600000,
  "updatedAt": 1735689600000,
  "version": 1,
  "capabilities": ["editable", "carryable", "deletable", "usable"],
  "useSound": "sounds/roll.ogg",
  "params": {},
  "carrierId": null
}
```

- `useSound`: optional client-played sound path when item `use` succeeds; global item field and not user-editable in V1.
- `capabilities` and `useSound` are derived from global item-type definitions at runtime (not stored per-instance in persisted state).

## Persisted Item State (`server/runtime/items.json`)

```json
{
  "id": "string",
  "type": "radio_station | dice",
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

## Type Params

### `radio_station`

```json
{
  "streamUrl": "",
  "enabled": true,
  "volume": 50
}
```

- `streamUrl`: string, empty allowed until configured.
- `enabled`: boolean on/off flag.
  - UI behavior: in property menu, `Enter` toggles on/off directly.
- `volume`: integer, range `0-100`, default `50`.

### `dice`

```json
{
  "sides": 6,
  "number": 2
}
```

- `sides`: integer, range `1-100`.
- `number`: integer, range `1-100`.

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
