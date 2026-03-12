"""Card deck item validation/normalization."""

from __future__ import annotations

from ....models import WorldItem
from ...helpers import keep_only_known_params, parse_bool_like
from .definition import PARAM_KEYS

_VALID_RANKS = frozenset(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"])
_VALID_SUITS = frozenset(["S", "H", "D", "C"])
_VALID_JOKERS = frozenset(["JO1", "JO2"])
_ALLOWED_SOUNDS = frozenset(["sounds/card_draw.ogg", "sounds/card_shuffle.ogg", ""])


def _is_valid_card(code: object) -> bool:
    if not isinstance(code, str):
        return False
    if code in _VALID_JOKERS:
        return True
    if len(code) < 2:
        return False
    suit = code[-1]
    rank = code[:-1]
    return rank in _VALID_RANKS and suit in _VALID_SUITS


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize card deck params."""

    try:
        draw_count = int(next_params.get("draw_count", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("draw_count must be a number.") from exc
    if not (1 <= draw_count <= 10):
        raise ValueError("draw_count must be between 1 and 10.")
    next_params["draw_count"] = draw_count

    deck = next_params.get("deck", [])
    if not isinstance(deck, list):
        raise ValueError("deck must be a list.")
    for card in deck:
        if not _is_valid_card(card):
            raise ValueError(f"Invalid card code: {card!r}")
    next_params["deck"] = deck

    next_params["include_jokers"] = parse_bool_like(next_params.get("include_jokers", False), default=False)

    use_sound = str(next_params.get("useSound", "")).strip()
    if use_sound not in _ALLOWED_SOUNDS:
        use_sound = "sounds/card_draw.ogg"
    next_params["useSound"] = use_sound

    return keep_only_known_params(next_params, PARAM_KEYS)
