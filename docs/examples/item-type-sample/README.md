# Sample Item Type Folder

This is a reference layout for adding a new server item type plugin.

## Folder Layout

- `definition.py`: static metadata/defaults/schema constants.
- `validator.py`: `validate_update(item, next_params)` normalization and validation.
- `actions.py`: `use_item(item, nickname, clock_formatter)` runtime behavior.
- `plugin.py`: registration payload consumed by plugin auto-discovery.

Use this folder as a copy template when creating a real item under:
`server/app/items/types/<item_type>/`.
