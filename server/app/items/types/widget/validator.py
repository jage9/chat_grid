"""Widget item validation/normalization."""

from __future__ import annotations

from ....models import WorldItem
from ...emit_validation import validate_emit_direction, validate_emit_properties
from ...helpers import keep_only_known_params, parse_bool_like
from ...sound_policy import enforce_max_length, normalize_sound_reference
from .definition import PARAM_KEYS


def validate_update(item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize widget params."""

    enabled = parse_bool_like(
        next_params.get("enabled", item.params.get("enabled", True)), default=True
    )
    next_params["enabled"] = enabled

    next_params.update(validate_emit_direction(item.params, next_params))
    next_params.update(validate_emit_properties(item.params, next_params))

    next_params["useSound"] = enforce_max_length(
        normalize_sound_reference(
            next_params.get("useSound", item.params.get("useSound", ""))
        ),
        max_length=2048,
        field_name="useSound",
    )
    return keep_only_known_params(next_params, PARAM_KEYS)
