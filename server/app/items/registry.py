"""Single source of truth for item-type module registration."""

from __future__ import annotations

from typing import Callable, Protocol

from ..item_types import ItemUseResult
from ..models import WorldItem

from . import clock, dice, piano, radio, wheel, widget


class ItemModule(Protocol):
    """Shape required by item modules consumed by catalog/handlers."""

    LABEL: str
    TOOLTIP: str
    EDITABLE_PROPERTIES: tuple[str, ...]
    CAPABILITIES: tuple[str, ...]
    USE_SOUND: str | None
    EMIT_SOUND: str | None
    USE_COOLDOWN_MS: int
    EMIT_RANGE: int
    DIRECTIONAL: bool
    DEFAULT_TITLE: str
    DEFAULT_PARAMS: dict
    PROPERTY_METADATA: dict[str, dict[str, object]]
    validate_update: Callable[[WorldItem, dict], dict]
    use_item: Callable[[WorldItem, str, Callable[[dict], str]], ItemUseResult]


ITEM_TYPE_ORDER: tuple[str, ...] = ("clock", "dice", "piano", "radio_station", "wheel", "widget")

ITEM_MODULES: dict[str, ItemModule] = {
    "clock": clock,
    "dice": dice,
    "piano": piano,
    "radio_station": radio,
    "wheel": wheel,
    "widget": widget,
}
