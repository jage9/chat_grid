"""Widget item validation/normalization."""

from __future__ import annotations

from ....models import WorldItem
from ...sound_policy import enforce_max_length, normalize_sound_reference
from ...helpers import keep_only_known_params, parse_bool_like
from .definition import EFFECT_OPTIONS, PARAM_KEYS


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
    next_params["facing"] = int(round(facing))

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
        emit_speed = float(next_params.get("emitSoundSpeed", item.params.get("emitSoundSpeed", 50)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitSoundSpeed must be a number between 0 and 100.") from exc
    if not (0 <= emit_speed <= 100):
        raise ValueError("emitSoundSpeed must be between 0 and 100.")
    next_params["emitSoundSpeed"] = round(emit_speed, 1)

    try:
        emit_tempo = float(next_params.get("emitSoundTempo", item.params.get("emitSoundTempo", 50)))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitSoundTempo must be a number between 0 and 100.") from exc
    if not (0 <= emit_tempo <= 100):
        raise ValueError("emitSoundTempo must be between 0 and 100.")
    next_params["emitSoundTempo"] = round(emit_tempo, 1)

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

    next_params["useSound"] = enforce_max_length(
        normalize_sound_reference(next_params.get("useSound", item.params.get("useSound", ""))),
        max_length=2048,
        field_name="useSound",
    )
    next_params["emitSound"] = enforce_max_length(
        normalize_sound_reference(next_params.get("emitSound", item.params.get("emitSound", ""))),
        max_length=2048,
        field_name="emitSound",
    )
    return keep_only_known_params(next_params, PARAM_KEYS)
