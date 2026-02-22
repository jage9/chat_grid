"""Server-side catalog of global item type definitions and defaults."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ItemType = Literal["radio_station", "dice", "wheel", "clock"]
ITEM_TYPE_SEQUENCE: tuple[ItemType, ...] = ("clock", "dice", "radio_station", "wheel")
ITEM_TYPE_LABELS: dict[ItemType, str] = {
    "radio_station": "radio",
    "dice": "dice",
    "wheel": "wheel",
    "clock": "clock",
}
RADIO_EFFECT_OPTIONS: tuple[str, ...] = ("reverb", "echo", "flanger", "high_pass", "low_pass", "off")
RADIO_CHANNEL_OPTIONS: tuple[str, ...] = ("stereo", "mono", "left", "right")
ITEM_TYPE_EDITABLE_PROPERTIES: dict[ItemType, tuple[str, ...]] = {
    "radio_station": ("title", "streamUrl", "enabled", "channel", "volume", "effect", "effectValue", "facing"),
    "dice": ("title", "sides", "number"),
    "wheel": ("title", "spaces"),
    "clock": ("title", "timeZone", "use24Hour"),
}
CLOCK_DEFAULT_TIME_ZONE = "America/Detroit"
CLOCK_TIME_ZONE_OPTIONS: tuple[str, ...] = (
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


@dataclass(frozen=True)
class ItemDefinition:
    """Global behavior and defaults shared by all instances of one item type."""

    default_title: str
    capabilities: tuple[str, ...]
    use_sound: str | None
    emit_sound: str | None
    default_params: dict
    use_cooldown_ms: int = 1000
    emit_range: int = 15
    directional: bool = False


ITEM_DEFINITIONS: dict[ItemType, ItemDefinition] = {
    "radio_station": ItemDefinition(
        default_title="radio",
        capabilities=("editable", "carryable", "deletable", "usable"),
        use_sound=None,
        emit_sound=None,
        default_params={"streamUrl": "", "enabled": True, "channel": "stereo", "volume": 50, "effect": "off", "effectValue": 50, "facing": 0},
        emit_range=20,
        directional=True,
    ),
    "dice": ItemDefinition(
        default_title="Dice",
        capabilities=("editable", "carryable", "deletable", "usable"),
        use_sound="sounds/roll.ogg",
        emit_sound=None,
        default_params={"sides": 6, "number": 2},
    ),
    "wheel": ItemDefinition(
        default_title="wheel",
        capabilities=("editable", "carryable", "deletable", "usable"),
        use_sound="sounds/spin.ogg",
        emit_sound=None,
        default_params={"spaces": "yes, no"},
        use_cooldown_ms=4000,
    ),
    "clock": ItemDefinition(
        default_title="clock",
        capabilities=("editable", "carryable", "deletable", "usable"),
        use_sound=None,
        emit_sound="sounds/clock.ogg",
        default_params={"timeZone": CLOCK_DEFAULT_TIME_ZONE, "use24Hour": False},
        emit_range=10,
    ),
}

ITEM_PROPERTY_OPTIONS: dict[str, tuple[str, ...]] = {
    "effect": RADIO_EFFECT_OPTIONS,
    "channel": RADIO_CHANNEL_OPTIONS,
    "timeZone": CLOCK_TIME_ZONE_OPTIONS,
}


def get_item_definition(item_type: ItemType) -> ItemDefinition:
    """Return catalog definition for a known item type."""

    return ITEM_DEFINITIONS[item_type]


def get_item_use_cooldown_ms(item_type: ItemType) -> int:
    """Return validated global use cooldown in milliseconds for an item type."""

    definition = get_item_definition(item_type)
    cooldown_ms = definition.use_cooldown_ms
    if isinstance(cooldown_ms, int) and cooldown_ms > 0:
        return cooldown_ms
    return 1000


def get_item_global_properties(item_type: ItemType) -> dict[str, str | int | bool]:
    """Return non-editable global properties exposed in UI metadata."""

    definition = get_item_definition(item_type)
    return {
        "useSound": definition.use_sound or "none",
        "emitSound": definition.emit_sound or "none",
        "useCooldownMs": get_item_use_cooldown_ms(item_type),
        "emitRange": definition.emit_range if isinstance(definition.emit_range, int) and definition.emit_range > 0 else 15,
        "directional": bool(definition.directional),
    }
