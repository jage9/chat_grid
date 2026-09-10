"""Teleporter item static metadata and defaults."""

from __future__ import annotations

LABEL = "teleporter"
TOOLTIP = "Send yourself to a configured grid destination."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title", "destination")
CAPABILITIES: tuple[str, ...] = ("editable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = "/sounds/whirr.ogg"
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 5
DIRECTIONAL = False
DEFAULT_TITLE = "Teleporter"
DEFAULT_DESTINATION = "0, 0, 0"
MAX_DESTINATION_LENGTH = 100
DEFAULT_PARAMS: dict = {"destination": DEFAULT_DESTINATION}
PARAM_KEYS: tuple[str, ...] = ("destination",)

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {
        "valueType": "text",
        "tooltip": "Display name spoken and shown for this item.",
        "maxLength": 80,
    },
    "destination": {
        "valueType": "text",
        "label": "Destination",
        "tooltip": "Destination coordinates as x, y, z.",
        "maxLength": MAX_DESTINATION_LENGTH,
    },
}
