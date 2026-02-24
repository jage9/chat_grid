# Item Type Template

This page is the practical template for the current plugin-driven item architecture.

## Plain-English Flow

When adding a new item type:

1. Server item package
- Add `server/app/items/types/<item_type>/` with:
  - `definition.py` for metadata/constants
  - `validator.py` for `validate_update(item, next_params)`
  - `actions.py` for `use_item(item, nickname, clock_formatter)`
  - `plugin.py` for registration

2. Server plugin file
- Add `server/app/items/types/<item_type>/plugin.py` exporting:
  - `type`
  - `order`
  - `module`

3. Shared type acceptance
- Item type ids are string-based in protocol/state models.
- For generic new types, no enum/union list updates are required.

4. Client runtime behavior (optional)
- Default: no item-specific client module needed.
- Add `client/src/items/types/<item_type>/behavior.ts` only if this item needs custom client runtime UX/audio logic (for example piano mode).

That is enough for a first working item type.

## Reference Sample Folder

See `docs/examples/item-type-sample/` for a complete copyable folder.

## Minimal `plugin.py` Example

```py
from ..plugin_helpers import build_item_module
from . import actions, definition, validator

ITEM_TYPE_PLUGIN = {
    "type": "counter",
    "order": 25,
    "module": build_item_module(definition, validate_update=validator.validate_update, use_item=actions.use_item),
}
```

## Checklist Before Commit

1. Add/adjust server tests for `use` and `update` validation.
2. Run `cd server && uv run --extra dev pytest`.
3. Run `cd client && npm run lint && npm run build`.
4. Update `docs/item-types.md` and `docs/item-schema.md` if behavior/defaults changed.
