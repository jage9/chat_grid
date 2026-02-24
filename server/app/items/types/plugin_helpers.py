"""Helpers for composing item plugin module surfaces."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any


def build_item_module(definition: Any, *, validate_update: Any, use_item: Any) -> Any:
    """Compose a plugin module-like object from split definition/validator/actions files."""

    exports: dict[str, Any] = {
        name: getattr(definition, name)
        for name in dir(definition)
        if name.isupper()
    }
    exports["validate_update"] = validate_update
    exports["use_item"] = use_item
    return SimpleNamespace(**exports)
