"""Whiteboard item validation/normalization."""

from __future__ import annotations

from ....models import WorldItem
from ...helpers import keep_only_known_params
from .definition import PARAM_KEYS

_MAX_LINES = 20
_MAX_LINE_LENGTH = 200


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize whiteboard params."""

    lines = next_params.get("lines", [])
    if not isinstance(lines, list):
        raise ValueError("lines must be a list.")
    if len(lines) > _MAX_LINES:
        raise ValueError(f"A whiteboard can have at most {_MAX_LINES} lines.")

    cleaned: list[str] = []
    for line in lines:
        if not isinstance(line, str):
            raise ValueError("Each line must be a string.")
        stripped = line.strip()
        if len(stripped) > _MAX_LINE_LENGTH:
            raise ValueError(f"Each line must be at most {_MAX_LINE_LENGTH} characters.")
        cleaned.append(stripped)

    next_params["lines"] = cleaned
    return keep_only_known_params(next_params, PARAM_KEYS)
