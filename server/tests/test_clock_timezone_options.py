"""Clock timezone option coverage tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.items.types.clock.definition import TIME_ZONE_OPTIONS


EXPECTED_MODERN_STANDARD_OFFSETS = {
    timedelta(hours=hours)
    for hours in (
        -12,
        -11,
        -10,
        -9.5,
        -9,
        -8,
        -7,
        -6,
        -5,
        -4,
        -3.5,
        -3,
        -2,
        -1,
        0,
        1,
        2,
        3,
        3.5,
        4,
        4.5,
        5,
        5.5,
        5.75,
        6,
        6.5,
        7,
        8,
        8.75,
        9,
        9.5,
        10,
        10.5,
        11,
        12,
        12.75,
        13,
        14,
    )
}

REGIONAL_REPRESENTATIVES: dict[str, dict[float, str]] = {
    "Africa": {
        -1: "Atlantic/Cape_Verde",
        0: "Africa/Abidjan",
        1: "Africa/Lagos",
        2: "Africa/Johannesburg",
        3: "Africa/Nairobi",
        4: "Indian/Mauritius",
        5: "Indian/Kerguelen",
        6: "Indian/Chagos",
    },
    "Asia": {
        2: "Asia/Jerusalem",
        3: "Asia/Baghdad",
        3.5: "Asia/Tehran",
        4: "Asia/Dubai",
        4.5: "Asia/Kabul",
        5: "Asia/Karachi",
        5.5: "Asia/Kolkata",
        5.75: "Asia/Kathmandu",
        6: "Asia/Dhaka",
        6.5: "Asia/Yangon",
        7: "Asia/Bangkok",
        8: "Asia/Hong_Kong",
        9: "Asia/Tokyo",
        10: "Asia/Vladivostok",
        11: "Asia/Magadan",
        12: "Asia/Kamchatka",
    },
    "Europe": {
        0: "Europe/London",
        1: "Europe/Berlin",
        2: "Europe/Helsinki",
        3: "Europe/Moscow",
        4: "Europe/Astrakhan",
    },
    "North America": {
        -10: "Pacific/Honolulu",
        -9: "America/Anchorage",
        -8: "America/Los_Angeles",
        -7: "America/Denver",
        -6: "America/Chicago",
        -5: "America/Detroit",
        -4: "America/Halifax",
        -3.5: "America/St_Johns",
        -3: "America/Miquelon",
        -2: "America/Nuuk",
        0: "America/Danmarkshavn",
    },
    "South America": {
        -6: "Pacific/Galapagos",
        -5: "America/Lima",
        -4: "America/La_Paz",
        -3: "America/Argentina/Buenos_Aires",
        -2: "America/Noronha",
    },
    "Australia/Oceania": {
        -11: "Pacific/Pago_Pago",
        -10: "Pacific/Tahiti",
        -9.5: "Pacific/Marquesas",
        -9: "Pacific/Gambier",
        -8: "Pacific/Pitcairn",
        6.5: "Indian/Cocos",
        7: "Indian/Christmas",
        8: "Australia/Perth",
        8.75: "Australia/Eucla",
        9: "Pacific/Palau",
        9.5: "Australia/Darwin",
        10: "Australia/Brisbane",
        10.5: "Australia/Lord_Howe",
        11: "Pacific/Noumea",
        12: "Pacific/Auckland",
        12.75: "Pacific/Chatham",
        13: "Pacific/Apia",
        14: "Pacific/Kiritimati",
    },
    "Antarctica": {
        -3: "Antarctica/Palmer",
        0: "Antarctica/Troll",
        3: "Antarctica/Syowa",
        5: "Antarctica/Mawson",
        7: "Antarctica/Davis",
        8: "Antarctica/Casey",
        10: "Antarctica/DumontDUrville",
        12: "Antarctica/McMurdo",
    },
}


def _standard_offset(zone_name: str, reference_date: datetime) -> timedelta:
    local = reference_date.astimezone(ZoneInfo(zone_name))
    utc_offset = local.utcoffset()
    dst_offset = local.dst()
    assert utc_offset is not None
    assert dst_offset is not None
    return utc_offset - dst_offset


def test_clock_options_cover_every_modern_standard_utc_offset() -> None:
    """The concise clock menu should retain one zone for every modern offset."""

    reference_dates = (
        datetime(2026, 1, 15, tzinfo=timezone.utc),
        datetime(2026, 7, 15, tzinfo=timezone.utc),
    )
    covered_offsets: set[timedelta] = set()
    for zone_name in TIME_ZONE_OPTIONS:
        zone = ZoneInfo(zone_name)
        for reference_date in reference_dates:
            local = reference_date.astimezone(zone)
            utc_offset = local.utcoffset()
            dst_offset = local.dst()
            assert utc_offset is not None
            assert dst_offset is not None
            covered_offsets.add(utc_offset - dst_offset)

    assert covered_offsets == EXPECTED_MODERN_STANDARD_OFFSETS


def test_clock_options_cover_each_continents_modern_standard_offsets() -> None:
    """Each regional offset should have a representative selectable location."""

    reference_date = datetime(2026, 1, 15, tzinfo=timezone.utc)
    for representatives in REGIONAL_REPRESENTATIVES.values():
        for expected_hours, zone_name in representatives.items():
            assert zone_name in TIME_ZONE_OPTIONS
            assert _standard_offset(zone_name, reference_date) == timedelta(
                hours=expected_hours
            )
