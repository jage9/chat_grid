"""Clock item validation/normalization."""

from __future__ import annotations

from ....models import WorldItem
from ...helpers import keep_only_known_params, parse_bool_like_or_none
from .definition import DEFAULT_TIME_ZONE, PARAM_KEYS, TIME_ZONE_OPTIONS
from .time_format import format_alarm_time_for_mode, parse_alarm_time_flexible


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
    alarm_enabled = parse_bool_like_or_none(next_params.get("alarmEnabled"))
    if alarm_enabled is None:
        raise ValueError("alarmEnabled must be on/off.")
    alarm_time_raw = str(next_params.get("alarmTime", "") or "").strip()
    parsed_alarm = parse_alarm_time_flexible(alarm_time_raw) if alarm_time_raw else None
    if alarm_enabled and parsed_alarm is None:
        raise ValueError("alarmTime must be a valid time (HH:MM or H:MM AM/PM) when alarm is on.")
    if alarm_time_raw and parsed_alarm is None:
        raise ValueError("alarmTime must be a valid time (HH:MM or H:MM AM/PM).")
    next_params["timeZone"] = time_zone
    next_params["use24Hour"] = use_24_hour
    next_params["topOfHourAnnounce"] = top_of_hour_announce
    next_params["alarmEnabled"] = alarm_enabled
    next_params["alarmTime"] = (
        format_alarm_time_for_mode(parsed_alarm[0], parsed_alarm[1], use_24_hour) if parsed_alarm is not None else ""
    )
    return keep_only_known_params(next_params, PARAM_KEYS)
