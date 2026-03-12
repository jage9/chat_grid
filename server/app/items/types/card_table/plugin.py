"""Plugin registration for card table item type."""

from __future__ import annotations

from ..plugin_helpers import build_item_module
from . import actions, definition, validator

ITEM_TYPE_PLUGIN = {
    "type": "card_table",
    "order": 26,
    "module": build_item_module(
        definition,
        validate_update=validator.validate_update,
        use_item=actions.use_item,
        secondary_use_item=actions.secondary_use_item,
    ),
}
