"""Shared item behavior types used by per-item modules and registry."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .models import WorldItem


@dataclass(frozen=True)
class ItemUseResult:
    """Result payload for a successful item use action."""

    self_message: str
    others_message: str
    updated_params: dict | None = None
    delayed_self_message: str | None = None
    delayed_others_message: str | None = None


@dataclass(frozen=True)
class ItemTypeHandler:
    """Validation and use handlers for one item type."""

    validate_update: Callable[[WorldItem, dict], dict]
    use: Callable[[WorldItem, str, Callable[[dict], str]], ItemUseResult]
