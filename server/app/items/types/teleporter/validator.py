"""Teleporter item validation and normalization."""

from __future__ import annotations

import re

from ....models import WorldItem
from ...helpers import keep_only_known_params
from .definition import DEFAULT_DESTINATION, MAX_DESTINATION_LENGTH, PARAM_KEYS

_DESTINATION_PATTERN = re.compile(
    r"\s*([+-]?[0-9]+)\s*,\s*([+-]?[0-9]+)\s*,\s*([+-]?[0-9]+)\s*"
)


def parse_destination(value: object) -> tuple[int, int, int]:
    """Parse one destination string containing exactly three integer coordinates."""

    if not isinstance(value, str):
        raise ValueError("destination must contain exactly three integers: x, y, z.")
    if len(value) > MAX_DESTINATION_LENGTH:
        raise ValueError(
            f"destination must be {MAX_DESTINATION_LENGTH} characters or less."
        )
    match = _DESTINATION_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError("destination must contain exactly three integers: x, y, z.")
    x, y, z = (int(coordinate) for coordinate in match.groups())
    return x, y, z


def format_destination(destination: tuple[int, int, int]) -> str:
    """Format destination coordinates in the canonical editable form."""

    return ", ".join(str(coordinate) for coordinate in destination)


def validate_update(item: WorldItem, next_params: dict) -> dict:
    """Validate teleporter destination syntax without applying world bounds."""

    raw_destination = next_params.get(
        "destination", item.params.get("destination", DEFAULT_DESTINATION)
    )
    destination = parse_destination(raw_destination)
    next_params["destination"] = format_destination(destination)
    return keep_only_known_params(next_params, PARAM_KEYS)
