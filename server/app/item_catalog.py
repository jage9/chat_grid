"""Server-side catalog of global item type definitions and defaults."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .items import clock, dice, radio, wheel

ItemType = Literal["radio_station", "dice", "wheel", "clock"]
ITEM_TYPE_SEQUENCE: tuple[ItemType, ...] = ("clock", "dice", "radio_station", "wheel")
ITEM_TYPE_LABELS: dict[ItemType, str] = {
    "radio_station": radio.LABEL,
    "dice": dice.LABEL,
    "wheel": wheel.LABEL,
    "clock": clock.LABEL,
}
ITEM_TYPE_EDITABLE_PROPERTIES: dict[ItemType, tuple[str, ...]] = {
    "radio_station": radio.EDITABLE_PROPERTIES,
    "dice": dice.EDITABLE_PROPERTIES,
    "wheel": wheel.EDITABLE_PROPERTIES,
    "clock": clock.EDITABLE_PROPERTIES,
}

CLOCK_DEFAULT_TIME_ZONE = clock.DEFAULT_TIME_ZONE
CLOCK_TIME_ZONE_OPTIONS = clock.TIME_ZONE_OPTIONS
RADIO_EFFECT_OPTIONS = radio.EFFECT_OPTIONS
RADIO_CHANNEL_OPTIONS = radio.CHANNEL_OPTIONS


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


def _build_definition(
    *,
    default_title: str,
    capabilities: tuple[str, ...],
    use_sound: str | None,
    emit_sound: str | None,
    default_params: dict,
    use_cooldown_ms: int,
    emit_range: int,
    directional: bool,
) -> ItemDefinition:
    """Build one immutable catalog definition from an item module."""

    return ItemDefinition(
        default_title=default_title,
        capabilities=capabilities,
        use_sound=use_sound,
        emit_sound=emit_sound,
        default_params=default_params,
        use_cooldown_ms=use_cooldown_ms,
        emit_range=emit_range,
        directional=directional,
    )


ITEM_DEFINITIONS: dict[ItemType, ItemDefinition] = {
    "radio_station": _build_definition(
        default_title=radio.DEFAULT_TITLE,
        capabilities=radio.CAPABILITIES,
        use_sound=radio.USE_SOUND,
        emit_sound=radio.EMIT_SOUND,
        default_params=radio.DEFAULT_PARAMS,
        use_cooldown_ms=radio.USE_COOLDOWN_MS,
        emit_range=radio.EMIT_RANGE,
        directional=radio.DIRECTIONAL,
    ),
    "dice": _build_definition(
        default_title=dice.DEFAULT_TITLE,
        capabilities=dice.CAPABILITIES,
        use_sound=dice.USE_SOUND,
        emit_sound=dice.EMIT_SOUND,
        default_params=dice.DEFAULT_PARAMS,
        use_cooldown_ms=dice.USE_COOLDOWN_MS,
        emit_range=dice.EMIT_RANGE,
        directional=dice.DIRECTIONAL,
    ),
    "wheel": _build_definition(
        default_title=wheel.DEFAULT_TITLE,
        capabilities=wheel.CAPABILITIES,
        use_sound=wheel.USE_SOUND,
        emit_sound=wheel.EMIT_SOUND,
        default_params=wheel.DEFAULT_PARAMS,
        use_cooldown_ms=wheel.USE_COOLDOWN_MS,
        emit_range=wheel.EMIT_RANGE,
        directional=wheel.DIRECTIONAL,
    ),
    "clock": _build_definition(
        default_title=clock.DEFAULT_TITLE,
        capabilities=clock.CAPABILITIES,
        use_sound=clock.USE_SOUND,
        emit_sound=clock.EMIT_SOUND,
        default_params=clock.DEFAULT_PARAMS,
        use_cooldown_ms=clock.USE_COOLDOWN_MS,
        emit_range=clock.EMIT_RANGE,
        directional=clock.DIRECTIONAL,
    ),
}

ITEM_PROPERTY_OPTIONS: dict[str, tuple[str, ...]] = {
    "effect": RADIO_EFFECT_OPTIONS,
    "channel": RADIO_CHANNEL_OPTIONS,
    "timeZone": CLOCK_TIME_ZONE_OPTIONS,
}

ITEM_TYPE_TOOLTIPS: dict[ItemType, str] = {
    "radio_station": radio.TOOLTIP,
    "dice": dice.TOOLTIP,
    "wheel": wheel.TOOLTIP,
    "clock": clock.TOOLTIP,
}

GLOBAL_ITEM_PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "useSound": {"valueType": "sound", "tooltip": "One-shot sound played when this item is used successfully."},
    "emitSound": {"valueType": "sound", "tooltip": "Looping sound emitted from this item on the grid."},
    "useCooldownMs": {"valueType": "number", "tooltip": "Global cooldown in milliseconds between uses for this item type."},
    "emitRange": {"valueType": "number", "tooltip": "Maximum distance in squares where emitted audio can be heard."},
    "directional": {"valueType": "boolean", "tooltip": "Whether emitted audio favors the item's facing direction."},
}

ITEM_TYPE_PROPERTY_METADATA: dict[ItemType, dict[str, dict[str, object]]] = {
    "radio_station": {**GLOBAL_ITEM_PROPERTY_METADATA, **radio.PROPERTY_METADATA},
    "dice": {**GLOBAL_ITEM_PROPERTY_METADATA, **dice.PROPERTY_METADATA},
    "wheel": {**GLOBAL_ITEM_PROPERTY_METADATA, **wheel.PROPERTY_METADATA},
    "clock": {**GLOBAL_ITEM_PROPERTY_METADATA, **clock.PROPERTY_METADATA},
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

