# Chat Grid Item System Plan

## Goals
- Add world items without hard-coding every new feature.
- Start with `radio_station` as the first real item type.
- Keep design compatible with future carry/use/object mechanics.

## Commands (V1)
- `A`: Add-item mode.
  - Opens list of available item types.
  - `Enter` places selected type on current square.
- `O`: Edit item properties on current square.
  - If one item on square: open property edit mode for that item.
  - If multiple items: open selector first, then property edit.
- `U`: Use item on current square (or held item if carrying one).
  - If multiple usable items are available, open selector first.
  - V1 behavior: implemented for `dice`; `radio_station` is configurable but not "used" yet.
- `Shift+U`: List connected users (moves old `U` users-list behavior here).
- `I`: Locate nearest item (name/type, distance, direction, coordinates).
- `Shift+I`: List items mode (nearest-first; arrows navigate; `Enter` focuses/moves, same pattern as user list).
- `D`: Carry/drop toggle.
  - If not carrying: pick up one item from current square.
  - If carrying: drop held item on current square.
  - If multiple items exist on square, open short selector first.
- `Shift+D`: Delete item on current square.
  - If multiple items, open selector first, then delete selected item.

## Add Flow Options
- Option 1: Add with required properties immediately.
  - Pros: item is valid at creation time.
  - Cons: slower flow due to prompts.
- Option 2: Add placeholder first, then edit with `O`. (Recommended for V1)
  - Pros: faster placement, cleaner keyboard flow, scales to many item types.
  - Cons: requires incomplete-item handling.

### Recommended V1 behavior
- `A` places item immediately with defaults.
- `radio_station` defaults:
  - `title`: `New station`
  - `params.streamUrl`: empty string (no default URL)
  - `params.enabled`: `true`
  - `params.volume`: `50`
- Incomplete rule:
  - Item exists in world, but does not activate until required params are set.
  - `O` is the standard command to complete/update params.

## Property Editor (`O`) Behavior
- `O` opens a property list for the selected item.
- Arrow keys move between properties.
- Focused property announces: property name + current value.
- `Enter` on a property starts edit mode for that value.
- For switch properties (V1: `radio_station.enabled`), `Enter` toggles directly between `on` and `off`.
- `Enter` saves value after validation.
- `Escape` exits edit mode or closes the property menu.
- Validation failures are announced and also pushed to message buffer.

## Data Model

### Global fields (all item types)
- `id`: unique item id.
- `type`: item type key (ex: `radio_station`, `dice`).
- `title`: spoken/display label.
- `x`, `y`: world position.
- `createdBy`, `createdAt`, `updatedAt`.
- `version`: schema version for migration.
- `capabilities`: list of supported actions (examples: `editable`, `carryable`, `usable`, `deletable`).
- `useSound`: optional sound path played on successful `U` use (global field, not editable in V1).
- `params`: per-type payload object.

### Per-item fields (inside `params`)
- `radio_station` (V1):
  - `streamUrl` (required for playback; may be empty until configured)
  - `enabled` (boolean on/off flag)
  - `volume` (number `0-100`, default `50`)
  - future: `filter`.
- `dice` (V1):
  - `sides` (number, default `6`, range `1-100`)
  - `number` (number of dice, default `2`, range `1-100`)
- `dice` (future example):
  - optional future: `lastRoll`, `rollMode`, `modifier`.

## Networking and Authority
- Server-authoritative item state.
- Client sends intent packets (`add`, `pickup`, `drop`, `delete`, later `use`).
- Server validates and returns:
  - success result + broadcast item state update, or
  - reject result with reason (also added to message buffer).

## Why this structure
- Stable global schema with extensible `params`.
- New item types can be added without changing core item pipeline.
- Supports shared multiplayer consistency and future inventory/carry rules.
