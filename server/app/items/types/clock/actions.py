"""Clock item use actions."""

from __future__ import annotations

from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem


def use_item(item: WorldItem, nickname: str, clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Read current clock time based on item configuration."""

    _display_time = clock_formatter(item.params)
    return ItemUseResult(
        self_message="",
        others_message="",
    )
