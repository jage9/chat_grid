from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ItemType = Literal["radio_station", "dice", "wheel"]


@dataclass(frozen=True)
class ItemDefinition:
    default_title: str
    capabilities: tuple[str, ...]
    use_sound: str | None
    default_params: dict
    use_cooldown_ms: int = 1000


ITEM_DEFINITIONS: dict[ItemType, ItemDefinition] = {
    "radio_station": ItemDefinition(
        default_title="radio",
        capabilities=("editable", "carryable", "deletable", "usable"),
        use_sound=None,
        default_params={"streamUrl": "", "enabled": True, "channel": "stereo", "volume": 50, "effect": "off", "effectValue": 50},
    ),
    "dice": ItemDefinition(
        default_title="Dice",
        capabilities=("editable", "carryable", "deletable", "usable"),
        use_sound="sounds/roll.ogg",
        default_params={"sides": 6, "number": 2},
    ),
    "wheel": ItemDefinition(
        default_title="wheel",
        capabilities=("editable", "carryable", "deletable", "usable"),
        use_sound="sounds/spin.ogg",
        default_params={"spaces": "yes, no"},
        use_cooldown_ms=4000,
    ),
}


def get_item_definition(item_type: ItemType) -> ItemDefinition:
    return ITEM_DEFINITIONS[item_type]


def get_item_use_cooldown_ms(item_type: ItemType) -> int:
    definition = get_item_definition(item_type)
    cooldown_ms = definition.use_cooldown_ms
    if isinstance(cooldown_ms, int) and cooldown_ms > 0:
        return cooldown_ms
    return 1000
