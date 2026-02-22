"""Clock item schema metadata and behavior."""

from __future__ import annotations

from typing import Callable

from ..item_types import ItemUseResult
from ..models import WorldItem
from .helpers import parse_bool_like_or_none

LABEL = "clock"
TOOLTIP = "It tells the time. What did you think it did?"
EDITABLE_PROPERTIES: tuple[str, ...] = ("title", "timeZone", "use24Hour")
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND = "sounds/clock.ogg"
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 10
DIRECTIONAL = False
DEFAULT_TITLE = "clock"
DEFAULT_TIME_ZONE = "America/Detroit"
TIME_ZONE_OPTIONS: tuple[str, ...] = (
    "America/Anchorage",
    "America/Argentina/Buenos_Aires",
    "America/Chicago",
    "America/Detroit",
    "America/Halifax",
    "America/Indiana/Indianapolis",
    "America/Kentucky/Louisville",
    "America/Los_Angeles",
    "America/St_Johns",
    "Asia/Bangkok",
    "Asia/Dhaka",
    "Asia/Dubai",
    "Asia/Hong_Kong",
    "Asia/Kabul",
    "Asia/Karachi",
    "Asia/Kathmandu",
    "Asia/Kolkata",
    "Asia/Seoul",
    "Asia/Singapore",
    "Asia/Tehran",
    "Asia/Tokyo",
    "Asia/Yangon",
    "Atlantic/Azores",
    "Atlantic/South_Georgia",
    "Australia/Brisbane",
    "Australia/Darwin",
    "Australia/Eucla",
    "Australia/Lord_Howe",
    "Europe/Berlin",
    "Europe/Helsinki",
    "Europe/London",
    "Europe/Moscow",
    "Pacific/Apia",
    "Pacific/Auckland",
    "Pacific/Chatham",
    "Pacific/Honolulu",
    "Pacific/Kiritimati",
    "Pacific/Noumea",
    "Pacific/Pago_Pago",
    "UTC",
)
DEFAULT_PARAMS: dict = {"timeZone": DEFAULT_TIME_ZONE, "use24Hour": False}

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item.", "maxLength": 80},
    "timeZone": {"valueType": "list", "tooltip": "Timezone used when the clock speaks time."},
    "use24Hour": {"valueType": "boolean", "tooltip": "Use 24 hour format instead of AM/PM."},
}


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize clock params."""

    time_zone = str(next_params.get("timeZone", DEFAULT_TIME_ZONE)).strip()
    if time_zone not in TIME_ZONE_OPTIONS:
        raise ValueError(f"timeZone must be one of {', '.join(TIME_ZONE_OPTIONS)}.")
    use_24_hour = parse_bool_like_or_none(next_params.get("use24Hour"))
    if use_24_hour is None:
        raise ValueError("use24Hour must be on/off.")
    next_params["timeZone"] = time_zone
    next_params["use24Hour"] = use_24_hour
    return next_params


def use_item(item: WorldItem, nickname: str, clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Read current clock time based on item configuration."""

    display_time = clock_formatter(item.params)
    return ItemUseResult(
        self_message=f"{item.title} says {display_time}.",
        others_message=f"{nickname} checks {item.title}. {item.title} says {display_time}.",
    )
