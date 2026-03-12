"""Whiteboard item static metadata and defaults."""

from __future__ import annotations

LABEL = "whiteboard"
TOOLTIP = "A shared text board. Use to read and edit lines."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title",)
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 500
EMIT_RANGE = 15
DIRECTIONAL = False
DEFAULT_TITLE = "whiteboard"
DEFAULT_PARAMS: dict = {"lines": []}
PARAM_KEYS: tuple[str, ...] = ("lines",)
PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name.", "maxLength": 80},
}
