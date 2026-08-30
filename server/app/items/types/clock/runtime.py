"""Authoritative clock formatting and announcement runtime."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Protocol
from zoneinfo import ZoneInfo

from websockets.asyncio.server import ServerConnection

from ....item_catalog import CLOCK_DEFAULT_TIME_ZONE, CLOCK_TIME_ZONE_OPTIONS
from ....items.types.clock.time_format import parse_alarm_time_flexible
from ....models import ItemClockAnnouncePacket, WorldItem

CLOCK_ANNOUNCE_POLL_INTERVAL_S = 1.0


class ClockRuntimeHost(Protocol):
    """Server operations required by clock announcements."""

    @property
    def items(self) -> dict[str, WorldItem]: ...

    def _get_item_sound_source_position(
        self, item: WorldItem
    ) -> tuple[int, int, int]: ...

    def _get_item_emit_range(self, item: WorldItem) -> int: ...

    async def _broadcast(
        self, packet: object, exclude: ServerConnection | None = None
    ) -> None: ...


class ClockRuntime:
    """Own clock display formatting and scheduled speech announcements."""

    def __init__(self, host: ClockRuntimeHost) -> None:
        """Create an idle clock runtime bound to authoritative item state."""

        self.host = host
        self._task: asyncio.Task[None] | None = None
        self._top_of_hour_markers: dict[str, str] = {}
        self._alarm_markers: dict[str, str] = {}

    @property
    def items(self) -> dict[str, WorldItem]:
        """Return the current authoritative item mapping."""

        return self.host.items

    def start(self) -> None:
        """Start scheduled clock announcement polling."""

        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run_clock_top_of_hour_loop())

    async def shutdown(self) -> None:
        """Cancel and await scheduled clock announcement polling."""

        if self._task is None:
            return
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        self._task = None

    @classmethod
    def _build_clock_time_sounds(cls, params: dict) -> list[str]:
        """Build ordered EL640 sample URLs for just the clock time phrase."""

        tz_name = cls._normalize_clock_timezone(params.get("timeZone"))
        use_24_hour = cls._parse_clock_use_24_hour(params.get("use24Hour")) is True
        now = datetime.now(ZoneInfo(tz_name))
        hour24 = now.hour
        minute = now.minute
        ampm = "AM" if hour24 < 12 else "PM"
        hour12 = hour24 % 12 or 12

        sounds: list[str] = ["/sounds/clock/el640/its.ogg"]

        if use_24_hour:
            if hour24 < 20:
                sounds.append(f"/sounds/clock/el640/{hour24}.ogg")
            else:
                tens = (hour24 // 10) * 10
                ones = hour24 % 10
                sounds.append(f"/sounds/clock/el640/{tens}.ogg")
                if ones != 0:
                    sounds.append(f"/sounds/clock/el640/{ones}.ogg")
        else:
            sounds.append(f"/sounds/clock/el640/{hour12}.ogg")

        if minute > 0:
            if minute < 10:
                sounds.append("/sounds/clock/el640/o.ogg")
            if minute < 20:
                sounds.append(f"/sounds/clock/el640/{minute}.ogg")
            else:
                tens = (minute // 10) * 10
                ones = minute % 10
                sounds.append(f"/sounds/clock/el640/{tens}.ogg")
                if ones != 0:
                    sounds.append(f"/sounds/clock/el640/{ones}.ogg")

        if not use_24_hour:
            sounds.append(f"/sounds/clock/el640/{ampm}.ogg")
        return sounds

    @classmethod
    def _build_clock_announcement_sounds(
        cls, params: dict, *, top_of_hour: bool, alarm: bool
    ) -> list[str]:
        """Build ordered EL640 sample URLs for one clock announcement variant."""

        sounds: list[str] = []
        if alarm:
            sounds.append("/sounds/clock/el640/announcement.ogg")
        elif top_of_hour:
            sounds.append("/sounds/clock/el640/hour1.ogg")
        sounds.extend(cls._build_clock_time_sounds(params))
        if alarm:
            sounds.append("/sounds/clock/el640/alarm.ogg")
        elif top_of_hour:
            sounds.append("/sounds/clock/el640/hour2.ogg")
        return sounds

    async def broadcast_announcement(
        self, item: WorldItem, *, top_of_hour: bool, alarm: bool
    ) -> None:
        """Broadcast one server-authoritative clock speech sequence from item position."""

        sound_x, sound_y, sound_z = self.host._get_item_sound_source_position(item)
        sound_range = self.host._get_item_emit_range(item)
        sounds = self._build_clock_announcement_sounds(
            item.params, top_of_hour=top_of_hour, alarm=alarm
        )
        if not sounds:
            return
        await self.host._broadcast(
            ItemClockAnnouncePacket(
                type="item_clock_announce",
                itemId=item.id,
                sounds=sounds,
                x=sound_x,
                y=sound_y,
                z=sound_z,
                range=sound_range,
            )
        )

    async def _run_clock_top_of_hour_loop(self) -> None:
        """Background polling loop that triggers top-of-hour speech for clock items."""

        try:
            while True:
                valid_clock_ids = {
                    item.id for item in self.items.values() if item.type == "clock"
                }
                for stale_id in list(self._top_of_hour_markers.keys()):
                    if stale_id not in valid_clock_ids:
                        self._top_of_hour_markers.pop(stale_id, None)
                for stale_id in list(self._alarm_markers.keys()):
                    if stale_id not in valid_clock_ids:
                        self._alarm_markers.pop(stale_id, None)
                for item in self.items.values():
                    if item.type != "clock":
                        continue
                    tz_name = self._normalize_clock_timezone(
                        item.params.get("timeZone")
                    )
                    now = datetime.now(ZoneInfo(tz_name))
                    top_of_hour_enabled = (
                        item.params.get("topOfHourAnnounce", True) is True
                    )
                    if top_of_hour_enabled and now.minute == 0 and now.second <= 1:
                        marker = now.strftime("%Y-%m-%d-%H")
                        if self._top_of_hour_markers.get(item.id) != marker:
                            self._top_of_hour_markers[item.id] = marker
                            await self.broadcast_announcement(
                                item, top_of_hour=True, alarm=False
                            )

                    alarm_enabled = item.params.get("alarmEnabled", False) is True
                    alarm_time = parse_alarm_time_flexible(
                        item.params.get("alarmTime", "")
                    )
                    if alarm_enabled and alarm_time is not None:
                        alarm_hour, alarm_minute = alarm_time
                        if (
                            now.hour == alarm_hour
                            and now.minute == alarm_minute
                            and now.second <= 1
                        ):
                            marker = now.strftime("%Y-%m-%d-%H-%M")
                            if self._alarm_markers.get(item.id) != marker:
                                self._alarm_markers[item.id] = marker
                                await self.broadcast_announcement(
                                    item, top_of_hour=False, alarm=True
                                )
                await asyncio.sleep(CLOCK_ANNOUNCE_POLL_INTERVAL_S)
        except asyncio.CancelledError:
            return

    @staticmethod
    def _normalize_clock_timezone(value: object) -> str:
        """Normalize timezone input to one of supported clock zones."""

        token = str(value or "").strip()
        if token in CLOCK_TIME_ZONE_OPTIONS:
            return token
        return CLOCK_DEFAULT_TIME_ZONE

    @staticmethod
    def _parse_clock_use_24_hour(value: object) -> bool | None:
        """Parse bool-like clock format values (`on/off`, `true/false`, etc.)."""

        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            token = value.strip().lower()
            if token in {"on", "true", "1", "yes"}:
                return True
            if token in {"off", "false", "0", "no"}:
                return False
        return None

    @classmethod
    def format_display_time(cls, params: dict) -> str:
        """Render current clock text based on item timezone/format params."""

        tz_name = cls._normalize_clock_timezone(params.get("timeZone"))
        use_24_hour = cls._parse_clock_use_24_hour(params.get("use24Hour"))
        if use_24_hour is None:
            use_24_hour = False
        now = datetime.now(ZoneInfo(tz_name))
        if use_24_hour:
            return now.strftime("%H:%M")
        hour_12 = now.hour % 12 or 12
        return f"{hour_12}:{now.minute:02d} {'AM' if now.hour < 12 else 'PM'}"
