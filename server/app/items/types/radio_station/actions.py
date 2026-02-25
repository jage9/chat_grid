"""Radio item use actions."""

from __future__ import annotations

from typing import Callable

from ....item_types import ItemUseResult
from ....models import WorldItem
from ...helpers import toggle_bool_param


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Toggle radio on/off when used."""

    next_enabled = toggle_bool_param(item.params, "enabled", default=True)
    state_text = "on" if next_enabled else "off"
    return ItemUseResult(
        self_message=f"You turn {state_text} {item.title}.",
        others_message=f"{nickname} turns {state_text} {item.title}.",
        updated_params={**item.params, "enabled": next_enabled},
    )


def secondary_use_item(item: WorldItem, _nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Speak now-playing metadata for this radio."""

    if item.params.get("enabled") is False:
        return ItemUseResult(
            self_message=f"{item.title} is off.",
            others_message="",
        )

    station_name = str(item.params.get("stationName", "")).strip()
    now_playing = str(item.params.get("nowPlaying", "")).strip()
    if now_playing and station_name:
        message = f"Playing {now_playing} from {station_name}."
    elif now_playing:
        message = f"Playing {now_playing}."
    elif station_name:
        message = f"Playing from {station_name}."
    else:
        message = "No now playing data."
    return ItemUseResult(self_message=message, others_message="")
