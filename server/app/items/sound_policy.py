"""Shared normalization helpers for item sound/media URL parameters."""

from __future__ import annotations


def normalize_sound_reference(raw: object) -> str:
    """Normalize sound value to empty/URL/or `sounds/`-relative path."""

    token = str(raw or "").strip()
    if not token:
        return ""
    lowered = token.lower()
    if lowered in {"none", "off"}:
        return ""
    if lowered.startswith(("http://", "https://", "data:", "blob:")):
        return token
    if token.startswith("/sounds/"):
        return token[1:]
    if token.startswith("sounds/"):
        return token
    if "/" not in token:
        return f"sounds/{token}"
    return token


def normalize_media_reference(raw: object) -> str:
    """Normalize media URL-like value while preserving path/query format."""

    token = str(raw or "").strip()
    if not token:
        return ""
    lowered = token.lower()
    if lowered in {"none", "off"}:
        return ""
    return token


def enforce_max_length(value: str, *, max_length: int, field_name: str) -> str:
    """Enforce max character length for normalized string fields."""

    if len(value) > max_length:
        raise ValueError(f"{field_name} must be {max_length} characters or less.")
    return value

