"""Whiteboard item use actions."""

from __future__ import annotations

from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem
_WHITEBOARD_ACTIONS = frozenset(["add_line", "edit_line", "delete_line"])
_MAX_LINES = 20
_MAX_LINE_LENGTH = 200


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


def interact_item(
    item: WorldItem,
    action: str,
    params: dict | None,
    nickname: str,
) -> ItemUseResult:
    """Handle a whiteboard interact action on behalf of any user."""
    if action not in _WHITEBOARD_ACTIONS:
        raise ValueError(f"Unknown whiteboard action: {action!r}")

    lines = list(item.params.get("lines", []))

    if action == "add_line":
        if not params or not isinstance(params.get("text"), str):
            raise ValueError("add_line requires params.text.")
        text = params["text"].strip()
        if not text:
            raise ValueError("Line text cannot be empty.")
        if len(text) > _MAX_LINE_LENGTH:
            raise ValueError(f"Line text is too long (max {_MAX_LINE_LENGTH} characters).")
        if len(lines) >= _MAX_LINES:
            raise ValueError(f"Whiteboard is full (max {_MAX_LINES} lines).")
        lines.append(text)
        return ItemUseResult(
            self_message=f"Line added to {item.title}.",
            others_message=f"{nickname} adds a line to {item.title}.",
            updated_params={"lines": lines},
        )

    if action == "edit_line":
        if not params or "line_index" not in params or not isinstance(params.get("text"), str):
            raise ValueError("edit_line requires params.line_index and params.text.")
        line_index = params["line_index"]
        if not isinstance(line_index, int) or line_index < 0 or line_index >= len(lines):
            raise ValueError("Invalid line_index.")
        text = params["text"].strip()
        if not text:
            raise ValueError("Line text cannot be empty.")
        if len(text) > _MAX_LINE_LENGTH:
            raise ValueError(f"Line text is too long (max {_MAX_LINE_LENGTH} characters).")
        lines[line_index] = text
        return ItemUseResult(
            self_message=f"Line updated on {item.title}.",
            others_message=f"{nickname} updates a line on {item.title}.",
            updated_params={"lines": lines},
        )

    if action == "delete_line":
        if not params or "line_index" not in params:
            raise ValueError("delete_line requires params.line_index.")
        line_index = params["line_index"]
        if not isinstance(line_index, int) or line_index < 0 or line_index >= len(lines):
            raise ValueError("Invalid line_index.")
        lines.pop(line_index)
        return ItemUseResult(
            self_message=f"Line deleted from {item.title}.",
            others_message=f"{nickname} deletes a line from {item.title}.",
            updated_params={"lines": lines},
        )

    raise ValueError(f"Unhandled action: {action!r}")  # unreachable guard
