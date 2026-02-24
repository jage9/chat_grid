"""Plugin registration for dice item type."""

from __future__ import annotations

from . import module

ITEM_TYPE_PLUGIN = {
    "type": "dice",
    "order": 20,
    "module": module,
}
