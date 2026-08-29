"""Elevator item action fallback."""

from __future__ import annotations

from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem


def use_item(
    item: WorldItem, _nickname: str, _clock_formatter: Callable[[dict], str]
) -> ItemUseResult:
    """Return the fallback message when server elevator routing is unavailable."""

    return ItemUseResult(
        self_message=f"{item.title} is unavailable.",
        others_message="",
    )


def _floor_name(item: WorldItem, z: int) -> str:
    """Return the simple two-floor name for one configured elevation."""

    floors = sorted(
        int(floor_z)
        for floor_z in item.params.get("floorZs", [0, 40])
        if isinstance(floor_z, int)
    )
    if floors and z == floors[0]:
        return "Ground floor"
    if len(floors) > 1 and z == floors[1]:
        return "Second floor"
    return f"height {z}"


def secondary_use_item(
    item: WorldItem, _nickname: str, _clock_formatter: Callable[[dict], str]
) -> ItemUseResult:
    """Report the elevator car's landing or travel state."""

    current_z = int(item.params.get("currentZ", 0))
    if item.params.get("state") == "moving":
        target_z = int(item.params.get("targetZ", current_z))
        direction = "up" if target_z > current_z else "down"
        message = (
            f"{item.title} is headed to {_floor_name(item, target_z)}, "
            f"traveling {direction}."
        )
    else:
        door = "open" if item.params.get("doorOpen") is True else "closed"
        message = f"{item.title} is on {_floor_name(item, current_z)}, door {door}."
    return ItemUseResult(self_message=message, others_message="")
