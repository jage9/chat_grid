"""Plugin registration for wheel item type."""

from __future__ import annotations

from . import module

ITEM_TYPE_PLUGIN = {
    "type": "wheel",
    "order": 50,
    "module": module,
}
