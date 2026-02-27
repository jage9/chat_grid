"""Clock item static metadata and defaults."""

from __future__ import annotations

LABEL = "clock"
TOOLTIP = "It tells the time. What did you think it did?"
EDITABLE_PROPERTIES: tuple[str, ...] = (
    "title",
    "timeZone",
    "use24Hour",
    "topOfHourAnnounce",
    "alarmEnabled",
    "alarmTime",
)
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND = "sounds/clock.ogg"
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 10
DIRECTIONAL = False
DEFAULT_TITLE = "clock"
DEFAULT_TIME_ZONE = "America/Detroit"
TIME_ZONE_OPTIONS: tuple[str, ...] = (
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
DEFAULT_PARAMS: dict = {
    "timeZone": DEFAULT_TIME_ZONE,
    "use24Hour": False,
    "topOfHourAnnounce": True,
    "alarmEnabled": False,
    "alarmTime": "",
}
PARAM_KEYS: tuple[str, ...] = ("timeZone", "use24Hour", "topOfHourAnnounce", "alarmEnabled", "alarmTime")

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item.", "maxLength": 80},
    "timeZone": {"valueType": "list", "tooltip": "Timezone used when the clock speaks time.", "options": list(TIME_ZONE_OPTIONS)},
    "use24Hour": {"valueType": "boolean", "tooltip": "Use 24 hour format instead of AM/PM."},
    "topOfHourAnnounce": {"valueType": "boolean", "tooltip": "Automatically announce time at the top of each hour."},
    "alarmEnabled": {"valueType": "boolean", "tooltip": "Enable one daily alarm announcement at the configured alarm time."},
    "alarmTime": {
        "valueType": "text",
        "tooltip": "Alarm time. Uses 24-hour HH:MM when 24 hour format is on, otherwise H:MM AM/PM.",
        "maxLength": 8,
    },
}
