"""Elevator item validation."""

from __future__ import annotations

from ....models import WorldItem
from ...helpers import keep_only_known_params
from .definition import PARAM_KEYS


def validate_update(item: WorldItem, _next_params: dict) -> dict:
    """Preserve server-managed elevator state during ordinary item edits."""

    return keep_only_known_params(dict(item.params), PARAM_KEYS)
