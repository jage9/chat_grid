"""Shared helper utilities for per-item behavior modules."""

from __future__ import annotations


def parse_bool_like(value: object, *, default: bool = True) -> bool:
    """Parse permissive bool-like values used by item params."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        token = value.strip().lower()
        if token in {"on", "true", "1", "yes"}:
            return True
        if token in {"off", "false", "0", "no"}:
            return False
    return default


def parse_bool_like_or_none(value: object) -> bool | None:
    """Parse permissive bool-like values, returning None when invalid."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        token = value.strip().lower()
        if token in {"on", "true", "1", "yes"}:
            return True
        if token in {"off", "false", "0", "no"}:
            return False
    return None


def toggle_bool_param(params: dict, key: str, *, default: bool = True) -> bool:
    """Toggle a bool-like item param key and return the next value."""

    current = parse_bool_like(params.get(key), default=default)
    return not current

