"""Elevator item static metadata and defaults."""

from __future__ import annotations

LABEL = "elevator"
TOOLTIP = "A two-floor elevator with a shared shaft and timed doors."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title",)
CAPABILITIES: tuple[str, ...] = ("editable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 500
EMIT_RANGE = 15
DIRECTIONAL = False
OCCUPIED_OFFSETS: tuple[tuple[int, int], ...] = ((0, 0),)
DEFAULT_TITLE = "Elevator"
DEFAULT_PARAMS: dict = {
    "floorZs": [0, 40],
    "currentZ": 0,
    "targetZ": None,
    "queuedZ": None,
    "departOnCloseZ": None,
    "state": "idle",
    "doorOpen": False,
}
PARAM_KEYS: tuple[str, ...] = (
    "floorZs",
    "currentZ",
    "targetZ",
    "queuedZ",
    "departOnCloseZ",
    "state",
    "doorOpen",
)

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {
        "valueType": "text",
        "tooltip": "Display name spoken and shown for this elevator.",
        "maxLength": 80,
    },
    "currentZ": {
        "valueType": "number",
        "label": "Current Z",
        "tooltip": "Current elevator car elevation.",
    },
    "floorZs": {
        "valueType": "text",
        "label": "Floors",
        "tooltip": "Floor elevations served by this elevator.",
    },
    "targetZ": {
        "valueType": "text",
        "label": "Target Z",
        "tooltip": "Destination elevation while the elevator is moving.",
    },
    "queuedZ": {
        "valueType": "text",
        "label": "Queued Z",
        "tooltip": "Landing elevation waiting for the current trip to finish.",
    },
    "departOnCloseZ": {
        "valueType": "text",
        "label": "Departure Z",
        "tooltip": "Destination elevation selected when the open door closes.",
    },
    "state": {
        "valueType": "text",
        "label": "State",
        "tooltip": "Current elevator movement or door state.",
    },
    "doorOpen": {
        "valueType": "boolean",
        "label": "Door open",
        "tooltip": "Whether the elevator door is open.",
    },
}
