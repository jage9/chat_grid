"""Elevator item validation."""

from __future__ import annotations

from ....models import WorldItem
from ...emit_validation import validate_emit_direction, validate_emit_properties
from ...helpers import keep_only_known_params
from .definition import PARAM_KEYS


def validate_update(item: WorldItem, next_params: dict) -> dict:
    """Validate emitted audio while preserving server-managed elevator state."""

    validated = dict(item.params)
    validated.update(validate_emit_direction(item.params, next_params))
    validated.update(validate_emit_properties(item.params, next_params))
    return keep_only_known_params(validated, PARAM_KEYS)
