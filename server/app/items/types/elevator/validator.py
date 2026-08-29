"""Elevator item validation."""

from __future__ import annotations

from ....models import WorldItem
from ...helpers import keep_only_known_params
from ...sound_policy import enforce_max_length, normalize_sound_reference
from .definition import PARAM_KEYS


def validate_update(item: WorldItem, next_params: dict) -> dict:
    """Validate emitted audio while preserving server-managed elevator state."""

    validated = dict(item.params)
    validated["emitSound"] = enforce_max_length(
        normalize_sound_reference(
            next_params.get("emitSound", item.params.get("emitSound", ""))
        ),
        max_length=2048,
        field_name="emitSound",
    )
    return keep_only_known_params(validated, PARAM_KEYS)
