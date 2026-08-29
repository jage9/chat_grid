"""Shared validation for configurable item emitters."""

from __future__ import annotations

from .helpers import parse_bool_like
from .sound_policy import enforce_max_length, normalize_sound_reference

EMIT_EFFECT_OPTIONS: tuple[str, ...] = (
    "reverb",
    "echo",
    "flanger",
    "high_pass",
    "low_pass",
    "off",
)


def _number_in_range(
    current_params: dict,
    next_params: dict,
    key: str,
    *,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    """Return one numeric emitter value after range validation."""

    try:
        value = float(next_params.get(key, current_params.get(key, default)))
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{key} must be a number between {minimum:g} and {maximum:g}."
        ) from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{key} must be between {minimum:g} and {maximum:g}.")
    return value


def _integer_in_range(
    current_params: dict,
    next_params: dict,
    key: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    """Return one integer emitter value after range validation."""

    try:
        value = int(next_params.get(key, current_params.get(key, default)))
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"{key} must be an integer between {minimum} and {maximum}."
        ) from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}.")
    return value


def validate_emit_properties(current_params: dict, next_params: dict) -> dict:
    """Validate and normalize the standard editable emitter properties."""

    emit_range = _integer_in_range(
        current_params,
        next_params,
        "emitRange",
        default=15,
        minimum=1,
        maximum=20,
    )
    emit_volume = _integer_in_range(
        current_params,
        next_params,
        "emitVolume",
        default=100,
        minimum=0,
        maximum=100,
    )
    emit_effect = (
        str(next_params.get("emitEffect", current_params.get("emitEffect", "off")))
        .strip()
        .lower()
    )
    if emit_effect not in EMIT_EFFECT_OPTIONS:
        raise ValueError(
            "emitEffect must be one of reverb, echo, flanger, high_pass, low_pass, off."
        )

    return {
        "emitRange": emit_range,
        "emitVolume": emit_volume,
        "emitSoundSpeed": round(
            _number_in_range(
                current_params,
                next_params,
                "emitSoundSpeed",
                default=50,
                minimum=0,
                maximum=100,
            ),
            1,
        ),
        "emitSoundTempo": round(
            _number_in_range(
                current_params,
                next_params,
                "emitSoundTempo",
                default=50,
                minimum=0,
                maximum=100,
            ),
            1,
        ),
        "emitInitialDelay": round(
            _number_in_range(
                current_params,
                next_params,
                "emitInitialDelay",
                default=0,
                minimum=0,
                maximum=300,
            ),
            1,
        ),
        "emitLoopDelay": round(
            _number_in_range(
                current_params,
                next_params,
                "emitLoopDelay",
                default=0,
                minimum=0,
                maximum=300,
            ),
            1,
        ),
        "emitEffect": emit_effect,
        "emitEffectValue": round(
            _number_in_range(
                current_params,
                next_params,
                "emitEffectValue",
                default=50,
                minimum=0,
                maximum=100,
            ),
            1,
        ),
        "emitSound": enforce_max_length(
            normalize_sound_reference(
                next_params.get("emitSound", current_params.get("emitSound", ""))
            ),
            max_length=2048,
            field_name="emitSound",
        ),
    }


def validate_emit_direction(current_params: dict, next_params: dict) -> dict:
    """Validate and normalize directional emitter controls."""

    directional = parse_bool_like(
        next_params.get("directional", current_params.get("directional", False)),
        default=False,
    )
    facing = _number_in_range(
        current_params,
        next_params,
        "facing",
        default=0,
        minimum=0,
        maximum=360,
    )
    return {"directional": directional, "facing": int(round(facing))}
