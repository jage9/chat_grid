"""Server-side catalog of global item type definitions and defaults."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

from .items import clock, radio
from .items.registry import ITEM_MODULES, ITEM_TYPE_ORDER

ItemType = Literal["radio_station", "dice", "wheel", "clock", "widget"]
ITEM_TYPE_SEQUENCE: tuple[ItemType, ...] = cast(tuple[ItemType, ...], ITEM_TYPE_ORDER)
ITEM_TYPE_LABELS: dict[ItemType, str] = {item_type: ITEM_MODULES[item_type].LABEL for item_type in ITEM_TYPE_SEQUENCE}
ITEM_TYPE_EDITABLE_PROPERTIES: dict[ItemType, tuple[str, ...]] = {
    item_type: ITEM_MODULES[item_type].EDITABLE_PROPERTIES for item_type in ITEM_TYPE_SEQUENCE
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
    item_type: _build_definition(
        default_title=ITEM_MODULES[item_type].DEFAULT_TITLE,
        capabilities=ITEM_MODULES[item_type].CAPABILITIES,
        use_sound=ITEM_MODULES[item_type].USE_SOUND,
        emit_sound=ITEM_MODULES[item_type].EMIT_SOUND,
        default_params=ITEM_MODULES[item_type].DEFAULT_PARAMS,
        use_cooldown_ms=ITEM_MODULES[item_type].USE_COOLDOWN_MS,
        emit_range=ITEM_MODULES[item_type].EMIT_RANGE,
        directional=ITEM_MODULES[item_type].DIRECTIONAL,
    )
    for item_type in ITEM_TYPE_SEQUENCE
}

ITEM_PROPERTY_OPTIONS: dict[str, tuple[str, ...]] = {
    "mediaEffect": RADIO_EFFECT_OPTIONS,
    "emitEffect": RADIO_EFFECT_OPTIONS,
    "mediaChannel": RADIO_CHANNEL_OPTIONS,
    "timeZone": CLOCK_TIME_ZONE_OPTIONS,
}

ITEM_TYPE_TOOLTIPS: dict[ItemType, str] = {
    item_type: ITEM_MODULES[item_type].TOOLTIP for item_type in ITEM_TYPE_SEQUENCE
}

GLOBAL_ITEM_PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "useSound": {"valueType": "sound", "tooltip": "One-shot sound played when this item is used successfully."},
    "emitSound": {"valueType": "sound", "tooltip": "Looping sound emitted from this item on the grid."},
    "useCooldownMs": {"valueType": "number", "tooltip": "Global cooldown in milliseconds between uses for this item type."},
    "emitRange": {"valueType": "number", "tooltip": "Maximum distance in squares where emitted audio can be heard."},
    "directional": {"valueType": "boolean", "tooltip": "Whether emitted audio favors the item's facing direction."},
    "emitSoundSpeed": {
        "valueType": "number",
        "tooltip": "Global emitted sound speed/pitch percent. 50 is normal.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "emitSoundTempo": {
        "valueType": "number",
        "tooltip": "Global emitted sound tempo percent. 50 is normal.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
}

ITEM_TYPE_PROPERTY_METADATA: dict[ItemType, dict[str, dict[str, object]]] = {
    item_type: {**GLOBAL_ITEM_PROPERTY_METADATA, **ITEM_MODULES[item_type].PROPERTY_METADATA} for item_type in ITEM_TYPE_SEQUENCE
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
        "emitSoundSpeed": 50,
        "emitSoundTempo": 50,
    }
