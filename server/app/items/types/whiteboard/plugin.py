"""Plugin registration for whiteboard item type."""

from __future__ import annotations

from ..plugin_helpers import build_item_module
from . import actions, definition, validator

ITEM_TYPE_PLUGIN = {
    "type": "whiteboard",
    "order": 70,
    "module": build_item_module(
        definition,
        validate_update=validator.validate_update,
        use_item=actions.use_item,
    ),
}
