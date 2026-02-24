"""Plugin registration for clock item type."""

from __future__ import annotations

from . import module

ITEM_TYPE_PLUGIN = {
    "type": "clock",
    "order": 10,
    "module": module,
}
