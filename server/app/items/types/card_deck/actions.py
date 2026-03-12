"""Card deck item use actions."""

from __future__ import annotations

import random
from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem

RANK_NAMES: dict[str, str] = {
    "A": "Ace",
    "2": "Two",
    "3": "Three",
    "4": "Four",
    "5": "Five",
    "6": "Six",
    "7": "Seven",
    "8": "Eight",
    "9": "Nine",
    "10": "Ten",
    "J": "Jack",
    "Q": "Queen",
    "K": "King",
}
SUIT_NAMES: dict[str, str] = {
    "S": "Spades",
    "H": "Hearts",
    "D": "Diamonds",
    "C": "Clubs",
}


def _card_name(code: str) -> str:
    """Return the display name for a card code, e.g. '10H' → 'Ten of Hearts'."""
    if code in ("JO1", "JO2"):
        return "Joker"
    suit = code[-1]
    rank = code[:-1]
    return f"{RANK_NAMES[rank]} of {SUIT_NAMES[suit]}"


def _build_deck(include_jokers: bool) -> list[str]:
    """Return a sorted list of 52 (or 54) card codes."""
    ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
    suits = ["S", "H", "D", "C"]
    deck = [f"{r}{s}" for s in suits for r in ranks]
    if include_jokers:
        deck += ["JO1", "JO2"]
    return deck


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Draw one or more cards from the deck."""
    try:
        draw_count = max(1, min(10, int(item.params.get("draw_count", 1))))
    except (TypeError, ValueError):
        draw_count = 1

    deck = item.params.get("deck", [])
    if not isinstance(deck, list):
        deck = []

    if not deck:
        return ItemUseResult(
            self_message=f"{item.title} is empty. Shift+Use to shuffle.",
            others_message="",
        )

    count = min(draw_count, len(deck))
    drawn = deck[:count]
    remaining = deck[count:]

    card_names = ", ".join(_card_name(c) for c in drawn)
    cards_left = len(remaining)
    left_text = f"{cards_left} card{'s' if cards_left != 1 else ''} left"

    return ItemUseResult(
        self_message=f"You draw from {item.title}: {card_names}. ({left_text})",
        others_message=f"{nickname} draws {count} card{'s' if count != 1 else ''} from {item.title}. ({left_text})",
        updated_params={"deck": remaining, "useSound": "sounds/card_draw.ogg"},
    )


def secondary_use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Shuffle the deck."""
    include_jokers = bool(item.params.get("include_jokers", False))
    deck = _build_deck(include_jokers)
    random.shuffle(deck)
    total = len(deck)

    return ItemUseResult(
        self_message=f"You shuffle {item.title}. {total} cards ready.",
        others_message=f"{nickname} shuffles {item.title}.",
        updated_params={"deck": deck, "useSound": "sounds/card_shuffle.ogg"},
    )
