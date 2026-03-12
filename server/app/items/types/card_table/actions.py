"""Card table item use actions."""

from __future__ import annotations

import random
from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem


def _build_deck(include_jokers: bool) -> list[str]:
    """Return a sorted list of 52 (or 54) card codes."""
    ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
    suits = ["S", "H", "D", "C"]
    deck = [f"{r}{s}" for s in suits for r in ranks]
    if include_jokers:
        deck += ["JO1", "JO2"]
    return deck


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Return status message; client opens menu from existing state."""
    draw_pile = item.params.get("draw_pile", [])
    discard_pile = item.params.get("discard_pile", [])
    hands = item.params.get("hands", {})
    if not isinstance(draw_pile, list):
        draw_pile = []
    if not isinstance(discard_pile, list):
        discard_pile = []
    if not isinstance(hands, dict):
        hands = {}
    hand = hands.get(nickname, [])
    if not isinstance(hand, list):
        hand = []
    draw_count = len(draw_pile)
    discard_count = len(discard_pile)
    hand_count = len(hand)

    return ItemUseResult(
        self_message=(
            f"{item.title}: {draw_count} in draw pile, "
            f"{discard_count} in discard, {hand_count} in your hand."
        ),
        others_message="",
    )


def secondary_use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Shuffle and reset the card table."""
    include_jokers = bool(item.params.get("include_jokers", False))
    deck = _build_deck(include_jokers)
    random.shuffle(deck)
    total = len(deck)

    return ItemUseResult(
        self_message=f"You reset {item.title}. {total} cards shuffled into draw pile.",
        others_message=f"{nickname} resets {item.title}.",
        updated_params={
            "draw_pile": deck,
            "discard_pile": [],
            "hands": {},
        },
    )
