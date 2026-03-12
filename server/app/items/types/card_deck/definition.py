"""Card deck item static metadata and defaults."""

from __future__ import annotations

LABEL = "card deck"
TOOLTIP = "A standard 52-card deck. Use to draw cards, Shift+Use to shuffle."
EDITABLE_PROPERTIES: tuple[str, ...] = ("title", "draw_count", "include_jokers")
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND = None
EMIT_SOUND: str | None = None
EMIT_RANGE = 15
DIRECTIONAL = False
USE_COOLDOWN_MS = 500
DEFAULT_TITLE = "Card Deck"
PARAM_KEYS: tuple[str, ...] = ("deck", "draw_count", "include_jokers", "useSound")

_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
_SUITS = ["S", "H", "D", "C"]
_FULL_DECK: list[str] = [f"{r}{s}" for s in _SUITS for r in _RANKS]

DEFAULT_PARAMS: dict = {
    "deck": list(_FULL_DECK),
    "draw_count": 1,
    "include_jokers": False,
    "useSound": "sounds/card_draw.ogg",
}

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {
        "valueType": "text",
        "tooltip": "Display name spoken and shown for this item.",
        "maxLength": 80,
    },
    "draw_count": {
        "valueType": "number",
        "tooltip": "How many cards to draw per use.",
        "range": {"min": 1, "max": 10, "step": 1},
    },
    "include_jokers": {
        "valueType": "boolean",
        "tooltip": "Include two Jokers when shuffled.",
    },
}
