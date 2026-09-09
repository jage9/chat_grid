"""Teleporter item use actions."""

from __future__ import annotations

from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem
from .definition import DEFAULT_DESTINATION
from .validator import format_destination, parse_destination


def use_item(
    item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]
) -> ItemUseResult:
    """Request a teleport to the item's configured destination."""

    destination = parse_destination(item.params.get("destination", DEFAULT_DESTINATION))
    destination_text = format_destination(destination)
    return ItemUseResult(
        self_message=f"You teleport to {destination_text}.",
        others_message=f"{nickname} teleports to {destination_text}.",
        teleport_destination=destination,
    )
