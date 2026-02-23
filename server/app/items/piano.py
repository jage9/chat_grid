"""Piano item schema metadata and behavior."""

from __future__ import annotations

from typing import Callable

from ..item_types import ItemUseResult
from ..models import WorldItem

LABEL = "piano"
TOOLTIP = "Playable keyboard instrument with multiple synth voices."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title", "instrument", "attack", "decay", "emitRange")
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 15
DIRECTIONAL = False
DEFAULT_TITLE = "piano"
DEFAULT_PARAMS: dict = {
    "instrument": "piano",
    "attack": 15,
    "decay": 45,
    "emitRange": 15,
}

INSTRUMENT_OPTIONS: tuple[str, ...] = (
    "piano",
    "electric_piano",
    "guitar",
    "organ",
    "bass",
    "violin",
    "synth_lead",
    "drum_kit",
)

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item.", "maxLength": 80},
    "instrument": {"valueType": "list", "tooltip": "Instrument voice used when playing this piano."},
    "attack": {
        "valueType": "number",
        "tooltip": "How quickly notes ramp in. Lower is sharper; higher is softer.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "decay": {
        "valueType": "number",
        "tooltip": "How long notes ring out after the initial hit.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "emitRange": {
        "valueType": "number",
        "tooltip": "Maximum distance in squares where this piano can be heard.",
        "range": {"min": 5, "max": 20, "step": 1},
    },
}


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize piano params."""

    instrument = str(next_params.get("instrument", "piano")).strip().lower()
    if instrument not in INSTRUMENT_OPTIONS:
        raise ValueError(f"instrument must be one of: {', '.join(INSTRUMENT_OPTIONS)}.")
    next_params["instrument"] = instrument

    try:
        attack = int(next_params.get("attack", 15))
    except (TypeError, ValueError) as exc:
        raise ValueError("attack must be an integer between 0 and 100.") from exc
    if not (0 <= attack <= 100):
        raise ValueError("attack must be between 0 and 100.")
    next_params["attack"] = attack

    try:
        decay = int(next_params.get("decay", 45))
    except (TypeError, ValueError) as exc:
        raise ValueError("decay must be an integer between 0 and 100.") from exc
    if not (0 <= decay <= 100):
        raise ValueError("decay must be between 0 and 100.")
    next_params["decay"] = decay

    try:
        emit_range = int(next_params.get("emitRange", 15))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitRange must be an integer between 5 and 20.") from exc
    if not (5 <= emit_range <= 20):
        raise ValueError("emitRange must be between 5 and 20.")
    next_params["emitRange"] = emit_range

    return next_params


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Enter piano play mode for the user who used the item."""

    return ItemUseResult(
        self_message=f"You begin playing {item.title}.",
        others_message=f"{nickname} begins playing {item.title}.",
    )
