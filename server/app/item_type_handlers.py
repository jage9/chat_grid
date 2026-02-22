"""Per-item-type handler registry."""

from __future__ import annotations

from .item_catalog import ItemType
from .items import clock, dice, radio, wheel
from .item_types import ItemTypeHandler

ITEM_TYPE_HANDLERS: dict[ItemType, ItemTypeHandler] = {
    "radio_station": ItemTypeHandler(validate_update=radio.validate_update, use=radio.use_item),
    "dice": ItemTypeHandler(validate_update=dice.validate_update, use=dice.use_item),
    "wheel": ItemTypeHandler(validate_update=wheel.validate_update, use=wheel.use_item),
    "clock": ItemTypeHandler(validate_update=clock.validate_update, use=clock.use_item),
}


def get_item_type_handler(item_type: ItemType) -> ItemTypeHandler:
    """Resolve item-type handler from registry."""

    return ITEM_TYPE_HANDLERS[item_type]

