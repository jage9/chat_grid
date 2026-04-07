"""Per-item-type handler registry."""

from __future__ import annotations

from .item_catalog import ItemType
from .items.registry import ITEM_MODULES
from .item_types import ItemTypeHandler

ITEM_TYPE_HANDLERS: dict[ItemType, ItemTypeHandler] = {
    item_type: ItemTypeHandler(
        validate_update=module.validate_update,
        use=module.use_item,
        secondary_use=getattr(module, "secondary_use_item", None),
        interact=getattr(module, "interact_item", None),
    )
    for item_type, module in ITEM_MODULES.items()
}


def get_item_type_handler(item_type: ItemType) -> ItemTypeHandler:
    """Resolve item-type handler from registry."""

    return ITEM_TYPE_HANDLERS[item_type]
