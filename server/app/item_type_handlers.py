"""Per-item-type use/update handlers for modular item behavior."""

from __future__ import annotations

from dataclasses import dataclass
import random
from typing import Callable

from .item_catalog import CLOCK_DEFAULT_TIME_ZONE, CLOCK_TIME_ZONE_OPTIONS, ItemType
from .models import WorldItem

RADIO_EFFECT_IDS = {"reverb", "echo", "flanger", "high_pass", "low_pass", "off"}
RADIO_CHANNEL_IDS = {"stereo", "mono", "left", "right"}


@dataclass(frozen=True)
class ItemUseResult:
    """Result payload for a successful item use action."""

    self_message: str
    others_message: str
    updated_params: dict | None = None
    delayed_self_message: str | None = None
    delayed_others_message: str | None = None


def _parse_enabled(value: object) -> bool:
    """Parse radio enabled-like values with permissive defaults."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"on", "true", "1", "yes"}
    return True


def _parse_clock_use_24_hour(value: object) -> bool | None:
    """Parse bool-like clock format values (`on/off`, `true/false`, etc.)."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        token = value.strip().lower()
        if token in {"on", "true", "1", "yes"}:
            return True
        if token in {"off", "false", "0", "no"}:
            return False
    return None


def _validate_radio_update(item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize `radio_station` params."""

    stream_url = str(next_params.get("streamUrl", "")).strip()
    previous_stream_url = str(item.params.get("streamUrl", "")).strip()
    next_params["streamUrl"] = stream_url
    enabled_value = next_params.get("enabled", True)
    if isinstance(enabled_value, bool):
        enabled = enabled_value
    elif isinstance(enabled_value, (int, float)):
        enabled = bool(enabled_value)
    elif isinstance(enabled_value, str):
        token = enabled_value.strip().lower()
        if token in {"on", "true", "1", "yes"}:
            enabled = True
        elif token in {"off", "false", "0", "no"}:
            enabled = False
        else:
            raise ValueError("enabled must be true/false or on/off.")
    else:
        raise ValueError("enabled must be true/false or on/off.")
    if stream_url and stream_url != previous_stream_url:
        enabled = True
    if not stream_url:
        enabled = False
    next_params["enabled"] = enabled

    try:
        volume = int(next_params.get("volume", 50))
    except (TypeError, ValueError) as exc:
        raise ValueError("volume must be a number.") from exc
    if not (0 <= volume <= 100):
        raise ValueError("volume must be between 0 and 100.")
    next_params["volume"] = volume

    effect = str(next_params.get("effect", "off")).strip().lower()
    if effect not in RADIO_EFFECT_IDS:
        raise ValueError("effect must be one of reverb, echo, flanger, high_pass, low_pass, off.")
    next_params["effect"] = effect

    channel = str(next_params.get("channel", "stereo")).strip().lower()
    if channel not in RADIO_CHANNEL_IDS:
        raise ValueError("channel must be one of stereo, mono, left, right.")
    next_params["channel"] = channel

    try:
        effect_value = float(next_params.get("effectValue", 50))
    except (TypeError, ValueError) as exc:
        raise ValueError("effectValue must be a number.") from exc
    if not (0 <= effect_value <= 100):
        raise ValueError("effectValue must be between 0 and 100.")
    next_params["effectValue"] = round(effect_value, 1)
    return next_params


def _validate_dice_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize `dice` params."""

    try:
        sides = int(next_params.get("sides", 6))
        number = int(next_params.get("number", 2))
    except (TypeError, ValueError) as exc:
        raise ValueError("Dice values must be numbers.") from exc
    if not (1 <= sides <= 100 and 1 <= number <= 100):
        raise ValueError("Dice sides and number must be between 1 and 100.")
    next_params["sides"] = sides
    next_params["number"] = number
    return next_params


def _validate_wheel_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize `wheel` params."""

    spaces_raw = next_params.get("spaces", "")
    if not isinstance(spaces_raw, str):
        raise ValueError("spaces must be a comma-delimited string.")
    spaces = [token.strip() for token in spaces_raw.split(",") if token.strip()]
    if not spaces:
        raise ValueError("spaces must include at least one value, separated by commas.")
    if len(spaces) > 100:
        raise ValueError("spaces supports up to 100 values.")
    if any(len(token) > 80 for token in spaces):
        raise ValueError("each space must be 80 chars or less.")
    next_params["spaces"] = ", ".join(spaces)
    return next_params


def _validate_clock_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize `clock` params."""

    time_zone = str(next_params.get("timeZone", CLOCK_DEFAULT_TIME_ZONE)).strip()
    if time_zone not in CLOCK_TIME_ZONE_OPTIONS:
        raise ValueError(f"timeZone must be one of {', '.join(CLOCK_TIME_ZONE_OPTIONS)}.")
    use_24_hour = _parse_clock_use_24_hour(next_params.get("use24Hour"))
    if use_24_hour is None:
        raise ValueError("use24Hour must be on/off.")
    next_params["timeZone"] = time_zone
    next_params["use24Hour"] = use_24_hour
    return next_params


def _use_radio(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Compute `radio_station` use result and next params."""

    currently_enabled = _parse_enabled(item.params.get("enabled", True))
    next_enabled = not currently_enabled
    state_text = "on" if next_enabled else "off"
    return ItemUseResult(
        self_message=f"You turn {state_text} {item.title}.",
        others_message=f"{nickname} turns {state_text} {item.title}.",
        updated_params={**item.params, "enabled": next_enabled},
    )


def _use_dice(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Compute `dice` use result."""

    try:
        sides = max(1, min(100, int(item.params.get("sides", 6))))
        number = max(1, min(100, int(item.params.get("number", 2))))
    except (TypeError, ValueError):
        sides = 6
        number = 2
    rolls = [random.randint(1, sides) for _ in range(number)]
    total = sum(rolls)
    rolls_text = ", ".join(str(value) for value in rolls)
    return ItemUseResult(
        self_message=f"You rolled {item.title}: {rolls_text} (total {total}).",
        others_message=f"{nickname} rolled {item.title}: {rolls_text} (total {total}).",
    )


def _use_wheel(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Compute `wheel` use result and delayed result text."""

    spaces_raw = item.params.get("spaces", "")
    if isinstance(spaces_raw, str):
        spaces = [token.strip() for token in spaces_raw.split(",") if token.strip()]
    elif isinstance(spaces_raw, list):
        spaces = [str(token).strip() for token in spaces_raw if str(token).strip()]
    else:
        spaces = []
    if not spaces:
        raise ValueError("wheel spaces must contain at least one comma-delimited value.")
    landed = str(random.choice(spaces))
    return ItemUseResult(
        self_message=f"You spin {item.title}.",
        others_message=f"{nickname} spins {item.title}.",
        delayed_self_message=landed,
        delayed_others_message=landed,
    )


def _use_clock(item: WorldItem, nickname: str, clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Compute `clock` use result."""

    display_time = clock_formatter(item.params)
    return ItemUseResult(
        self_message=f"{item.title} says {display_time}.",
        others_message=f"{nickname} checks {item.title}. {item.title} says {display_time}.",
    )


@dataclass(frozen=True)
class ItemTypeHandler:
    """Validation and use handlers for one item type."""

    validate_update: Callable[[WorldItem, dict], dict]
    use: Callable[[WorldItem, str, Callable[[dict], str]], ItemUseResult]


ITEM_TYPE_HANDLERS: dict[ItemType, ItemTypeHandler] = {
    "radio_station": ItemTypeHandler(validate_update=_validate_radio_update, use=_use_radio),
    "dice": ItemTypeHandler(validate_update=_validate_dice_update, use=_use_dice),
    "wheel": ItemTypeHandler(validate_update=_validate_wheel_update, use=_use_wheel),
    "clock": ItemTypeHandler(validate_update=_validate_clock_update, use=_use_clock),
}


def get_item_type_handler(item_type: ItemType) -> ItemTypeHandler:
    """Resolve item-type handler from registry."""

    return ITEM_TYPE_HANDLERS[item_type]
