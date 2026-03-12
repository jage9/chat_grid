"""Card table item validation/normalization."""

from __future__ import annotations

from ....models import WorldItem
from ...helpers import keep_only_known_params, parse_bool_like
from .definition import PARAM_KEYS

_VALID_RANKS = frozenset(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"])
_VALID_SUITS = frozenset(["S", "H", "D", "C"])
_VALID_JOKERS = frozenset(["JO1", "JO2"])


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
    """Validate and normalize card table params."""

    draw_pile = next_params.get("draw_pile", [])
    if not isinstance(draw_pile, list):
        raise ValueError("draw_pile must be a list.")
    for card in draw_pile:
        if not _is_valid_card(card):
            raise ValueError(f"Invalid card code in draw_pile: {card!r}")
    next_params["draw_pile"] = draw_pile

    discard_pile = next_params.get("discard_pile", [])
    if not isinstance(discard_pile, list):
        raise ValueError("discard_pile must be a list.")
    for card in discard_pile:
        if not _is_valid_card(card):
            raise ValueError(f"Invalid card code in discard_pile: {card!r}")
    next_params["discard_pile"] = discard_pile

    hands = next_params.get("hands", {})
    if not isinstance(hands, dict):
        raise ValueError("hands must be a dict.")
    if len(hands) > 20:
        raise ValueError("Too many hands (max 20).")
    for player, hand in hands.items():
        if not isinstance(player, str):
            raise ValueError("Hand keys must be strings.")
        if not isinstance(hand, list):
            raise ValueError(f"Hand for {player!r} must be a list.")
        if len(hand) > 60:
            raise ValueError(f"Too many cards in hand for {player!r} (max 60).")
        for card in hand:
            if not _is_valid_card(card):
                raise ValueError(f"Invalid card code in hand for {player!r}: {card!r}")
    next_params["hands"] = hands

    next_params["include_jokers"] = parse_bool_like(next_params.get("include_jokers", False), default=False)

    return keep_only_known_params(next_params, PARAM_KEYS)
