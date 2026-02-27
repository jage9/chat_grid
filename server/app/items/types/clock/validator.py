"""Clock item validation/normalization."""

from __future__ import annotations

from ....models import WorldItem
from ...helpers import keep_only_known_params, parse_bool_like_or_none
from .definition import DEFAULT_TIME_ZONE, PARAM_KEYS, TIME_ZONE_OPTIONS


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize clock params."""

    time_zone = str(next_params.get("timeZone", DEFAULT_TIME_ZONE)).strip()
    if time_zone not in TIME_ZONE_OPTIONS:
        raise ValueError(f"timeZone must be one of {', '.join(TIME_ZONE_OPTIONS)}.")
    use_24_hour = parse_bool_like_or_none(next_params.get("use24Hour"))
    if use_24_hour is None:
        raise ValueError("use24Hour must be on/off.")
    top_of_hour_announce = parse_bool_like_or_none(next_params.get("topOfHourAnnounce"))
    if top_of_hour_announce is None:
        raise ValueError("topOfHourAnnounce must be on/off.")
    next_params["timeZone"] = time_zone
    next_params["use24Hour"] = use_24_hour
    next_params["topOfHourAnnounce"] = top_of_hour_announce
    return keep_only_known_params(next_params, PARAM_KEYS)
