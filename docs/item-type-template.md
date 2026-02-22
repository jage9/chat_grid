# Item Type Template

This page is a practical template for adding a new item type with the current per-item module + single registry system.

## Plain-English Flow

When a new item type is added, wire it in these places:

1. Server item module (`server/app/items/<name>.py`)
- Define item metadata constants:
  - label/tooltip
  - editable properties
  - defaults/capabilities/sounds/cooldown/range/directional
  - property metadata
- Implement behavior:
  - `validate_update(item, next_params)`
  - `use_item(item, nickname, clock_formatter)`

2. Server registry (`server/app/items/registry.py`)
- Add one module entry in `ITEM_MODULES`.
- Update `ITEM_TYPE_ORDER` if needed.

3. Shared item type unions
- Add the type in:
  - `server/app/models.py`
  - `client/src/network/protocol.ts`
  - `client/src/state/gameState.ts`

4. Client fallback metadata
- Add defaults in `client/src/items/itemRegistry.ts`:
  - `DEFAULT_ITEM_TYPE_SEQUENCE`
  - `DEFAULT_ITEM_TYPE_EDITABLE_PROPERTIES`
  - `DEFAULT_ITEM_TYPE_GLOBAL_PROPERTIES`

That is enough for a first working item type.

## Minimal Server Module Example: `counter`

`server/app/items/counter.py`:

```py
from __future__ import annotations

from typing import Callable

from ..item_types import ItemUseResult
from ..models import WorldItem

LABEL = "counter"
TOOLTIP = "Counts up each time you use it."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title", "value")
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 15
DIRECTIONAL = False
DEFAULT_TITLE = "counter"
DEFAULT_PARAMS: dict = {"value": 0}

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item."},
    "value": {"valueType": "number", "tooltip": "Current counter value.", "range": {"min": 0, "max": 9999, "step": 1}},
}


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    try:
        value = int(next_params.get("value", 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("value must be a number.") from exc
    if value < 0:
        raise ValueError("value must be 0 or greater.")
    next_params["value"] = value
    return next_params


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    next_value = int(item.params.get("value", 0)) + 1
    return ItemUseResult(
        self_message=f"{item.title}: {next_value}",
        others_message=f"{nickname} uses {item.title}: {next_value}",
        updated_params={**item.params, "value": next_value},
    )
```

Then register it in `server/app/items/registry.py`:

```py
from . import clock, counter, dice, radio, wheel

ITEM_TYPE_ORDER: tuple[str, ...] = ("clock", "counter", "dice", "radio_station", "wheel")

ITEM_MODULES: dict[str, ItemModule] = {
    "clock": clock,
    "counter": counter,
    "dice": dice,
    "radio_station": radio,
    "wheel": wheel,
}
```

## Checklist Before Commit

1. Add/adjust server tests for `use` and `update` validation.
2. Run `cd server && uv run --extra dev pytest`.
3. Run `cd client && npm run lint && npm run build`.
4. Update `docs/item-types.md` and `docs/item-schema.md` if behavior/defaults changed.
