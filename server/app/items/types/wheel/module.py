"""Wheel item schema metadata and behavior."""

from __future__ import annotations

import random
from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem
from ...helpers import keep_only_known_params

LABEL = "wheel"
TOOLTIP = "Spin to win fabulous prizes."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title", "spaces")
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND = "sounds/spin.ogg"
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 4000
EMIT_RANGE = 15
DIRECTIONAL = False
DEFAULT_TITLE = "wheel"
DEFAULT_PARAMS: dict = {"spaces": "yes, no"}
PARAM_KEYS: tuple[str, ...] = ("spaces",)

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item.", "maxLength": 80},
    "spaces": {
        "valueType": "text",
        "tooltip": "Comma-delimited list of wheel spaces. Example: yes, no, maybe.",
        "maxLength": 4000,
    },
}


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize wheel params."""

    spaces_raw = next_params.get("spaces", "")
    if not isinstance(spaces_raw, str):
        raise ValueError("spaces must be a comma-delimited string.")
    if len(spaces_raw) > 4000:
        raise ValueError("spaces must be 4000 characters or less.")
    spaces = [token.strip() for token in spaces_raw.split(",") if token.strip()]
    if not spaces:
        raise ValueError("spaces must include at least one value, separated by commas.")
    if len(spaces) > 100:
        raise ValueError("spaces supports up to 100 values.")
    if any(len(token) > 80 for token in spaces):
        raise ValueError("each space must be 80 chars or less.")
    next_params["spaces"] = ", ".join(spaces)
    return keep_only_known_params(next_params, PARAM_KEYS)


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Spin wheel and produce delayed landed value."""

    spaces_raw = item.params.get("spaces", "")
    if isinstance(spaces_raw, str):
        spaces = [token.strip() for token in spaces_raw.split(",") if token.strip()]
    elif isinstance(spaces_raw, list):
        spaces = [str(token).strip() for token in spaces_raw if str(token).strip()]
    else:
        spaces = []
    if not spaces:
        raise ValueError("wheel spaces must contain at least one comma-delimited value.")
    landed = str(random.choice(spaces))
    return ItemUseResult(
        self_message=f"You spin {item.title}.",
        others_message=f"{nickname} spins {item.title}.",
        delayed_self_message=landed,
        delayed_others_message=landed,
    )
