"""Clock alarm time parsing/format helpers shared by validation and runtime checks."""

from __future__ import annotations

import re

_TWELVE_HOUR_RE = re.compile(r"^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AaPp][Mm])$")
_TWENTY_FOUR_HOUR_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def parse_alarm_time_for_mode(value: object, use_24_hour: bool) -> tuple[int, int] | None:
    """Parse alarm time using one explicit mode and return `(hour24, minute)`."""

    raw = str(value or "").strip()
    if not raw:
        return None
    if use_24_hour:
        match = _TWENTY_FOUR_HOUR_RE.fullmatch(raw)
        if not match:
            return None
        return int(match.group(1)), int(match.group(2))
    match = _TWELVE_HOUR_RE.fullmatch(raw)
    if not match:
        return None
    hour = int(match.group(1))
    minute = int(match.group(2))
    meridiem = match.group(3).upper()
    if meridiem == "AM":
        hour24 = 0 if hour == 12 else hour
    else:
        hour24 = 12 if hour == 12 else hour + 12
    return hour24, minute


def parse_alarm_time_flexible(value: object) -> tuple[int, int] | None:
    """Parse alarm time as either 12-hour or 24-hour format and return `(hour24, minute)`."""

    parsed = parse_alarm_time_for_mode(value, use_24_hour=True)
    if parsed is not None:
        return parsed
    return parse_alarm_time_for_mode(value, use_24_hour=False)


def format_alarm_time_for_mode(hour24: int, minute: int, use_24_hour: bool) -> str:
    """Format one parsed alarm time tuple as canonical 12-hour or 24-hour text."""

    if use_24_hour:
        return f"{hour24:02d}:{minute:02d}"
    meridiem = "AM" if hour24 < 12 else "PM"
    hour12 = hour24 % 12 or 12
    return f"{hour12}:{minute:02d} {meridiem}"

