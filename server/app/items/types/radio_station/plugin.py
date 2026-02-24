"""Plugin registration for radio_station item type."""

from __future__ import annotations

from . import module

ITEM_TYPE_PLUGIN = {
    "type": "radio_station",
    "order": 40,
    "module": module,
}
