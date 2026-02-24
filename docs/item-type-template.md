# Item Type Template

This page is the practical template for the current plugin-driven item architecture.

## Plain-English Flow

When adding a new item type:

1. Server item module
- Add `server/app/items/types/<item_type>/module.py`.
- Define metadata/constants:
  - `LABEL`, `TOOLTIP`
  - `EDITABLE_PROPERTIES`
  - `CAPABILITIES`
  - `USE_SOUND`, `EMIT_SOUND`
  - `USE_COOLDOWN_MS`, `EMIT_RANGE`, `DIRECTIONAL`
  - `DEFAULT_TITLE`, `DEFAULT_PARAMS`
  - `PROPERTY_METADATA`
- Implement behavior:
  - `validate_update(item, next_params)`
  - `use_item(item, nickname, clock_formatter)`

2. Server plugin file
- Add `server/app/items/types/<item_type>/plugin.py` exporting:
  - `type`
  - `order`
  - `module`

3. Shared item-type unions
- Add the type in:
  - `server/app/models.py`
  - `client/src/network/protocol.ts`
  - `client/src/state/gameState.ts`

4. Client runtime behavior (optional)
- Default: no item-specific client module needed.
- Add `client/src/items/types/<item_type>/behavior.ts` only if this item needs custom client runtime UX/audio logic (for example piano mode).

That is enough for a first working item type.

## Minimal Server Module Example: `counter`

`server/app/items/types/counter/module.py`:

```py
from __future__ import annotations

from typing import Callable

from ...item_types import ItemUseResult
from ...models import WorldItem

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

Then add plugin registration in `server/app/items/types/counter/plugin.py`:

```py
from . import module

ITEM_TYPE_PLUGIN = {
    "type": "counter",
    "order": 25,
    "module": module,
}
```

## Checklist Before Commit

1. Add/adjust server tests for `use` and `update` validation.
2. Run `cd server && uv run --extra dev pytest`.
3. Run `cd client && npm run lint && npm run build`.
4. Update `docs/item-types.md` and `docs/item-schema.md` if behavior/defaults changed.
