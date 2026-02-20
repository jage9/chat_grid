from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ItemType = Literal["radio_station", "dice"]


@dataclass(frozen=True)
class ItemDefinition:
    default_title: str
    capabilities: tuple[str, ...]
    use_sound: str | None
    default_params: dict


ITEM_DEFINITIONS: dict[ItemType, ItemDefinition] = {
    "radio_station": ItemDefinition(
        default_title="radio",
        capabilities=("editable", "carryable", "deletable"),
        use_sound=None,
        default_params={"streamUrl": "", "enabled": True, "volume": 50, "effect": "off", "effectValue": 50},
    ),
    "dice": ItemDefinition(
        default_title="Dice",
        capabilities=("editable", "carryable", "deletable", "usable"),
        use_sound="sounds/roll.ogg",
        default_params={"sides": 6, "number": 2},
    ),
}


def get_item_definition(item_type: ItemType) -> ItemDefinition:
    return ITEM_DEFINITIONS[item_type]
