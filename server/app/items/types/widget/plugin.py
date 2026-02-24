"""Plugin registration for widget item type."""

from __future__ import annotations

from . import module

ITEM_TYPE_PLUGIN = {
    "type": "widget",
    "order": 60,
    "module": module,
}
