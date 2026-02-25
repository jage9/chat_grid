"""Radio item validation/normalization."""

from __future__ import annotations

from ....models import WorldItem
from ...sound_policy import enforce_max_length, normalize_media_reference
from ...helpers import keep_only_known_params
from .definition import CHANNEL_OPTIONS, EFFECT_OPTIONS, PARAM_KEYS


def validate_update(item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize radio params."""

    next_params["streamUrl"] = enforce_max_length(
        normalize_media_reference(next_params.get("streamUrl", "")),
        max_length=2048,
        field_name="streamUrl",
    )

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
    next_params["enabled"] = enabled

    try:
        media_volume = int(next_params.get("mediaVolume", 50))
    except (TypeError, ValueError) as exc:
        raise ValueError("mediaVolume must be a number.") from exc
    if not (0 <= media_volume <= 100):
        raise ValueError("mediaVolume must be between 0 and 100.")
    next_params["mediaVolume"] = media_volume

    effect = str(next_params.get("mediaEffect", "off")).strip().lower()
    if effect not in EFFECT_OPTIONS:
        raise ValueError("mediaEffect must be one of reverb, echo, flanger, high_pass, low_pass, off.")
    next_params["mediaEffect"] = effect

    channel = str(next_params.get("mediaChannel", "stereo")).strip().lower()
    if channel not in CHANNEL_OPTIONS:
        raise ValueError("mediaChannel must be one of stereo, mono, left, right.")
    next_params["mediaChannel"] = channel

    try:
        effect_value = float(next_params.get("mediaEffectValue", 50))
    except (TypeError, ValueError) as exc:
        raise ValueError("mediaEffectValue must be a number.") from exc
    if not (0 <= effect_value <= 100):
        raise ValueError("mediaEffectValue must be between 0 and 100.")
    next_params["mediaEffectValue"] = round(effect_value, 1)

    try:
        facing = float(next_params.get("facing", item.params.get("facing", 0)))
    except (TypeError, ValueError) as exc:
        raise ValueError("facing must be a number between 0 and 360.") from exc
    if not (0 <= facing <= 360):
        raise ValueError("facing must be between 0 and 360.")
    next_params["facing"] = int(round(facing))

    try:
        emit_range = int(next_params.get("emitRange", item.params.get("emitRange", 20)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitRange must be an integer between 5 and 20.") from exc
    if not (5 <= emit_range <= 20):
        raise ValueError("emitRange must be between 5 and 20.")
    next_params["emitRange"] = emit_range
    return keep_only_known_params(next_params, PARAM_KEYS)
