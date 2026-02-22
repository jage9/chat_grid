"""Dice item schema metadata and behavior."""

from __future__ import annotations

import random
from typing import Callable

from ..item_types import ItemUseResult
from ..models import WorldItem

LABEL = "dice"
TOOLTIP = "Great for drinking games or boredom."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title", "sides", "number")
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND = "sounds/roll.ogg"
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 15
DIRECTIONAL = False
DEFAULT_TITLE = "Dice"
DEFAULT_PARAMS: dict = {"sides": 6, "number": 2}

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item.", "maxLength": 80},
    "sides": {
        "valueType": "number",
        "tooltip": "Number of sides on each die.",
        "range": {"min": 1, "max": 100, "step": 1},
    },
    "number": {
        "valueType": "number",
        "tooltip": "How many dice to roll per use.",
        "range": {"min": 1, "max": 100, "step": 1},
    },
}


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize dice params."""

    try:
        sides = int(next_params.get("sides", 6))
        number = int(next_params.get("number", 2))
    except (TypeError, ValueError) as exc:
        raise ValueError("Dice values must be numbers.") from exc
    if not (1 <= sides <= 100 and 1 <= number <= 100):
        raise ValueError("Dice sides and number must be between 1 and 100.")
    next_params["sides"] = sides
    next_params["number"] = number
    return next_params


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Roll dice and report result."""

    try:
        sides = max(1, min(100, int(item.params.get("sides", 6))))
        number = max(1, min(100, int(item.params.get("number", 2))))
    except (TypeError, ValueError):
        sides = 6
        number = 2
    rolls = [random.randint(1, sides) for _ in range(number)]
    total = sum(rolls)
    rolls_text = ", ".join(str(value) for value in rolls)
    if number == 1:
        return ItemUseResult(
            self_message=f"You rolled {item.title}: {rolls_text}.",
            others_message=f"{nickname} rolled {item.title}: {rolls_text}.",
        )
    return ItemUseResult(
        self_message=f"You rolled {item.title}: {rolls_text} (total {total}).",
        others_message=f"{nickname} rolled {item.title}: {rolls_text} (total {total}).",
    )
