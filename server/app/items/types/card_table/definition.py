"""Card table item static metadata and defaults."""

from __future__ import annotations

TYPE = "card_table"
LABEL = "Card Table"
TOOLTIP = "A shared card table with draw pile, discard pile, and per-player hands."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title", "include_jokers")
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND = None
EMIT_SOUND: str | None = None
EMIT_RANGE = 15
DIRECTIONAL = False
USE_COOLDOWN_MS = 500
DEFAULT_TITLE = "Card Table"
PARAM_KEYS: tuple[str, ...] = ("draw_pile", "discard_pile", "hands", "include_jokers")

_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
_SUITS = ["S", "H", "D", "C"]
_FULL_DECK: list[str] = [f"{r}{s}" for s in _SUITS for r in _RANKS]

DEFAULT_PARAMS: dict = {
    "draw_pile": list(_FULL_DECK),
    "discard_pile": [],
    "hands": {},
    "include_jokers": False,
}

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {
        "valueType": "text",
        "tooltip": "Display name spoken and shown for this item.",
        "maxLength": 80,
    },
    "include_jokers": {
        "valueType": "boolean",
        "tooltip": "Include two Jokers when shuffled and reset.",
    },
}
