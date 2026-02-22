"""Radio item schema metadata and behavior."""

from __future__ import annotations

from typing import Callable

from ..item_types import ItemUseResult
from ..models import WorldItem
from .helpers import toggle_bool_param

LABEL = "radio"
TOOLTIP = "Can play stations from the Internet. Tune multiple to the same station and they will sync up."
EDITABLE_PROPERTIES: tuple[str, ...] = (
    "title",
    "streamUrl",
    "enabled",
    "channel",
    "volume",
    "effect",
    "effectValue",
    "facing",
    "emitRange",
)
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 20
DIRECTIONAL = True
DEFAULT_TITLE = "radio"
DEFAULT_PARAMS: dict = {
    "streamUrl": "",
    "enabled": True,
    "channel": "stereo",
    "volume": 50,
    "effect": "off",
    "effectValue": 50,
    "facing": 0,
    "emitRange": 20,
}

CHANNEL_OPTIONS: tuple[str, ...] = ("stereo", "mono", "left", "right")
EFFECT_OPTIONS: tuple[str, ...] = ("reverb", "echo", "flanger", "high_pass", "low_pass", "off")

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item."},
    "streamUrl": {"valueType": "text", "tooltip": "Audio stream URL used by this radio."},
    "enabled": {"valueType": "boolean", "tooltip": "Turns playback on or off for this radio."},
    "channel": {"valueType": "list", "tooltip": "Select how the station audio channels are rendered."},
    "volume": {
        "valueType": "number",
        "tooltip": "Playback volume percent for this radio.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "effect": {"valueType": "list", "tooltip": "Select the active radio effect."},
    "effectValue": {
        "valueType": "number",
        "tooltip": "Amount for the selected effect.",
        "range": {"min": 0, "max": 100, "step": 0.1},
    },
    "facing": {
        "valueType": "number",
        "tooltip": "Facing direction in degrees used for directional emit.",
        "range": {"min": 0, "max": 360, "step": 0.1},
    },
    "emitRange": {
        "valueType": "number",
        "tooltip": "Maximum distance in squares for this radio's emitted audio.",
        "range": {"min": 5, "max": 20, "step": 1},
    },
}


def validate_update(item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize radio params."""

    stream_url = str(next_params.get("streamUrl", "")).strip()
    previous_stream_url = str(item.params.get("streamUrl", "")).strip()
    next_params["streamUrl"] = stream_url

    enabled_value = next_params.get("enabled", True)
    if isinstance(enabled_value, bool):
        enabled = enabled_value
    elif isinstance(enabled_value, (int, float)):
        enabled = bool(enabled_value)
    elif isinstance(enabled_value, str):
        token = enabled_value.strip().lower()
        if token in {"on", "true", "1", "yes"}:
            enabled = True
        elif token in {"off", "false", "0", "no"}:
            enabled = False
        else:
            raise ValueError("enabled must be true/false or on/off.")
    else:
        raise ValueError("enabled must be true/false or on/off.")
    if stream_url and stream_url != previous_stream_url:
        enabled = True
    if not stream_url:
        enabled = False
    next_params["enabled"] = enabled

    try:
        volume = int(next_params.get("volume", 50))
    except (TypeError, ValueError) as exc:
        raise ValueError("volume must be a number.") from exc
    if not (0 <= volume <= 100):
        raise ValueError("volume must be between 0 and 100.")
    next_params["volume"] = volume

    effect = str(next_params.get("effect", "off")).strip().lower()
    if effect not in EFFECT_OPTIONS:
        raise ValueError("effect must be one of reverb, echo, flanger, high_pass, low_pass, off.")
    next_params["effect"] = effect

    channel = str(next_params.get("channel", "stereo")).strip().lower()
    if channel not in CHANNEL_OPTIONS:
        raise ValueError("channel must be one of stereo, mono, left, right.")
    next_params["channel"] = channel

    try:
        effect_value = float(next_params.get("effectValue", 50))
    except (TypeError, ValueError) as exc:
        raise ValueError("effectValue must be a number.") from exc
    if not (0 <= effect_value <= 100):
        raise ValueError("effectValue must be between 0 and 100.")
    next_params["effectValue"] = round(effect_value, 1)

    try:
        facing = float(next_params.get("facing", item.params.get("facing", 0)))
    except (TypeError, ValueError) as exc:
        raise ValueError("facing must be a number between 0 and 360.") from exc
    if not (0 <= facing <= 360):
        raise ValueError("facing must be between 0 and 360.")
    next_params["facing"] = round(facing, 1)

    try:
        emit_range = int(next_params.get("emitRange", item.params.get("emitRange", 20)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitRange must be an integer between 5 and 20.") from exc
    if not (5 <= emit_range <= 20):
        raise ValueError("emitRange must be between 5 and 20.")
    next_params["emitRange"] = emit_range
    return next_params


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Toggle radio on/off when used."""

    next_enabled = toggle_bool_param(item.params, "enabled", default=True)
    state_text = "on" if next_enabled else "off"
    return ItemUseResult(
        self_message=f"You turn {state_text} {item.title}.",
        others_message=f"{nickname} turns {state_text} {item.title}.",
        updated_params={**item.params, "enabled": next_enabled},
    )

