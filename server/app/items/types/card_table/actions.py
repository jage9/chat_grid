"""Card table item use actions."""

from __future__ import annotations

import random
from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem

_VALID_RANKS = {"A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"}
_VALID_SUITS = {"S", "H", "D", "C"}
_RANK_NAMES = {
    "A": "Ace", "2": "Two", "3": "Three", "4": "Four", "5": "Five",
    "6": "Six", "7": "Seven", "8": "Eight", "9": "Nine", "10": "Ten",
    "J": "Jack", "Q": "Queen", "K": "King",
}
_SUIT_NAMES = {"S": "Spades", "H": "Hearts", "D": "Diamonds", "C": "Clubs"}

_CARD_TABLE_ACTIONS = frozenset(["draw", "draw_from_discard", "discard", "return_to_pile"])


def _card_name(code: str) -> str:
    """Human-readable card name."""
    if code in ("JO1", "JO2"):
        return "Joker"
    suit = code[-1]
    rank = code[:-1]
    return f"{_RANK_NAMES.get(rank, rank)} of {_SUIT_NAMES.get(suit, suit)}"


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


def interact_item(
    item: WorldItem,
    action: str,
    params: dict | None,
    nickname: str,
) -> ItemUseResult:
    """Handle a card table interact action on behalf of any user."""
    if action not in _CARD_TABLE_ACTIONS:
        raise ValueError(f"Unknown card table action: {action!r}")

    draw_pile = list(item.params.get("draw_pile", []))
    discard_pile = list(item.params.get("discard_pile", []))
    hands_raw = item.params.get("hands", {})
    hands: dict[str, list[str]] = dict(hands_raw) if isinstance(hands_raw, dict) else {}

    if action == "draw":
        if not draw_pile:
            raise ValueError("Draw pile is empty.")
        card = draw_pile.pop(0)
        hand = list(hands.get(nickname, []))
        hand.append(card)
        hands[nickname] = hand
        return ItemUseResult(
            self_message=f"You drew {_card_name(card)}. {len(draw_pile)} remaining in draw pile.",
            others_message=f"{nickname} draws a card.",
            updated_params={"draw_pile": draw_pile, "hands": hands},
        )

    if action == "draw_from_discard":
        if not discard_pile:
            raise ValueError("Discard pile is empty.")
        if not params or "card_index" not in params:
            raise ValueError("draw_from_discard requires params.card_index.")
        card_index = params["card_index"]
        if not isinstance(card_index, int) or card_index < 0 or card_index >= len(discard_pile):
            raise ValueError("Invalid card_index.")
        card = discard_pile.pop(card_index)
        hand = list(hands.get(nickname, []))
        hand.append(card)
        hands[nickname] = hand
        return ItemUseResult(
            self_message=f"You took {_card_name(card)} from the discard pile.",
            others_message=f"{nickname} takes a card from the discard pile.",
            updated_params={"discard_pile": discard_pile, "hands": hands},
        )

    if action == "discard":
        if not params or "card_index" not in params:
            raise ValueError("discard requires params.card_index.")
        hand = list(hands.get(nickname, []))
        card_index = params["card_index"]
        if not isinstance(card_index, int) or card_index < 0 or card_index >= len(hand):
            raise ValueError("Invalid card_index.")
        card = hand.pop(card_index)
        discard_pile.insert(0, card)
        hands[nickname] = hand
        return ItemUseResult(
            self_message=f"You discarded {_card_name(card)}.",
            others_message=f"{nickname} discards a card.",
            updated_params={"discard_pile": discard_pile, "hands": hands},
        )

    if action == "return_to_pile":
        if not params or "card_index" not in params:
            raise ValueError("return_to_pile requires params.card_index.")
        hand = list(hands.get(nickname, []))
        card_index = params["card_index"]
        if not isinstance(card_index, int) or card_index < 0 or card_index >= len(hand):
            raise ValueError("Invalid card_index.")
        card = hand.pop(card_index)
        draw_pile.append(card)
        hands[nickname] = hand
        return ItemUseResult(
            self_message=f"You returned {_card_name(card)} to the draw pile.",
            others_message=f"{nickname} returns a card to the draw pile.",
            updated_params={"draw_pile": draw_pile, "hands": hands},
        )

    raise ValueError(f"Unhandled action: {action!r}")  # unreachable guard
