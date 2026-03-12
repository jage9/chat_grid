"""Whiteboard item use actions."""

from __future__ import annotations

from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Report whiteboard contents to the user who used it."""

    lines = item.params.get("lines", [])
    if not isinstance(lines, list):
        lines = []
    n = len(lines)
    line_text = f"{n} line{'s' if n != 1 else ''}"

    return ItemUseResult(
        self_message=f"You open {item.title}. {line_text}.",
        others_message=f"{nickname} opens {item.title}.",
    )
