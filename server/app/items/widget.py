"""Widget item schema metadata and behavior."""

from __future__ import annotations

from typing import Callable

from ..item_types import ItemUseResult
from ..models import WorldItem
from .helpers import parse_bool_like, toggle_bool_param

LABEL = "widget"
TOOLTIP = "A basic item. Make it a beacon or whatever you want."
EDITABLE_PROPERTIES: tuple[str, ...] = (
    "title",
    "enabled",
    "directional",
    "facing",
    "emitRange",
    "emitVolume",
    "emitSoundSpeed",
    "emitSoundTempo",
    "emitEffect",
    "emitEffectValue",
    "useSound",
    "emitSound",
)
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 15
DIRECTIONAL = False
DEFAULT_TITLE = "widget"
DEFAULT_PARAMS: dict = {
    "enabled": True,
    "directional": False,
    "facing": 0,
    "emitRange": 15,
    "emitVolume": 100,
    "emitSoundSpeed": 50,
    "emitSoundTempo": 50,
    "emitEffect": "off",
    "emitEffectValue": 50,
    "useSound": "",
    "emitSound": "",
}
EFFECT_OPTIONS: tuple[str, ...] = ("reverb", "echo", "flanger", "high_pass", "low_pass", "off")

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item."},
    "enabled": {"valueType": "boolean", "tooltip": "Turns this widget on or off."},
    "directional": {"valueType": "boolean", "tooltip": "If on, emitted sound favors the facing direction."},
    "facing": {
        "valueType": "number",
        "tooltip": "Facing direction in degrees used when directional is on.",
        "range": {"min": 0, "max": 360, "step": 0.1},
    },
    "emitRange": {
        "valueType": "number",
        "tooltip": "Maximum distance in squares for emitted sound.",
        "range": {"min": 1, "max": 20, "step": 1},
    },
    "emitVolume": {
        "valueType": "number",
        "tooltip": "Emitted sound volume percent.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "emitSoundSpeed": {
        "valueType": "number",
        "tooltip": "Playback speed/pitch percent for emitted sound. 50 is normal, 0 is half, 100 is double. Using speed and tempo together may sound weird.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "emitSoundTempo": {
        "valueType": "number",
        "tooltip": "Playback tempo percent for emitted sound. 50 is normal, 0 is half, 100 is double. Using speed and tempo together may sound weird.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "emitEffect": {"valueType": "list", "tooltip": "Effect applied to emitted sound."},
    "emitEffectValue": {
        "valueType": "number",
        "tooltip": "Amount for emit effect.",
        "range": {"min": 0, "max": 100, "step": 0.1},
    },
    "useSound": {"valueType": "sound", "tooltip": "Sound played on use. Filename assumes sounds folder, or use full URL."},
    "emitSound": {"valueType": "sound", "tooltip": "Looping emitted sound. Filename assumes sounds folder, or use full URL."},
}


def _normalize_sound_value(raw: object) -> str:
    """Normalize sound value to empty/URL/or sounds-relative path."""

    token = str(raw or "").strip()
    if not token:
        return ""
    lowered = token.lower()
    if lowered in {"none", "off"}:
        return ""
    if lowered.startswith(("http://", "https://", "data:", "blob:")):
        return token
    if token.startswith("/sounds/"):
        return token[1:]
    if token.startswith("sounds/"):
        return token
    if "/" not in token:
        return f"sounds/{token}"
    return token


def validate_update(item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize widget params."""

    enabled = parse_bool_like(next_params.get("enabled", item.params.get("enabled", True)), default=True)
    directional = parse_bool_like(next_params.get("directional", item.params.get("directional", False)), default=False)
    next_params["enabled"] = enabled
    next_params["directional"] = directional

    try:
        facing = float(next_params.get("facing", item.params.get("facing", 0)))
    except (TypeError, ValueError) as exc:
        raise ValueError("facing must be a number between 0 and 360.") from exc
    if not (0 <= facing <= 360):
        raise ValueError("facing must be between 0 and 360.")
    next_params["facing"] = round(facing, 1)

    try:
        emit_range = int(next_params.get("emitRange", item.params.get("emitRange", 15)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitRange must be an integer between 1 and 20.") from exc
    if not (1 <= emit_range <= 20):
        raise ValueError("emitRange must be between 1 and 20.")
    next_params["emitRange"] = emit_range

    try:
        emit_volume = int(next_params.get("emitVolume", item.params.get("emitVolume", 100)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitVolume must be an integer between 0 and 100.") from exc
    if not (0 <= emit_volume <= 100):
        raise ValueError("emitVolume must be between 0 and 100.")
    next_params["emitVolume"] = emit_volume

    try:
        emit_speed = int(next_params.get("emitSoundSpeed", item.params.get("emitSoundSpeed", 50)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitSoundSpeed must be an integer between 0 and 100.") from exc
    if not (0 <= emit_speed <= 100):
        raise ValueError("emitSoundSpeed must be between 0 and 100.")
    next_params["emitSoundSpeed"] = emit_speed

    try:
        emit_tempo = int(next_params.get("emitSoundTempo", item.params.get("emitSoundTempo", 50)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitSoundTempo must be an integer between 0 and 100.") from exc
    if not (0 <= emit_tempo <= 100):
        raise ValueError("emitSoundTempo must be between 0 and 100.")
    next_params["emitSoundTempo"] = emit_tempo

    emit_effect = str(next_params.get("emitEffect", item.params.get("emitEffect", "off"))).strip().lower()
    if emit_effect not in EFFECT_OPTIONS:
        raise ValueError("emitEffect must be one of reverb, echo, flanger, high_pass, low_pass, off.")
    next_params["emitEffect"] = emit_effect

    try:
        emit_effect_value = float(next_params.get("emitEffectValue", item.params.get("emitEffectValue", 50)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitEffectValue must be a number.") from exc
    if not (0 <= emit_effect_value <= 100):
        raise ValueError("emitEffectValue must be between 0 and 100.")
    next_params["emitEffectValue"] = round(emit_effect_value, 1)

    next_params["useSound"] = _normalize_sound_value(next_params.get("useSound", item.params.get("useSound", "")))
    next_params["emitSound"] = _normalize_sound_value(next_params.get("emitSound", item.params.get("emitSound", "")))
    return next_params


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Toggle enabled state for widget."""

    next_enabled = toggle_bool_param(item.params, "enabled", default=True)
    state_text = "on" if next_enabled else "off"
    return ItemUseResult(
        self_message=f"You turn {state_text} {item.title}.",
        others_message=f"{nickname} turns {state_text} {item.title}.",
        updated_params={**item.params, "enabled": next_enabled},
    )
