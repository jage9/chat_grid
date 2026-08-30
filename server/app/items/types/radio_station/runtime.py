"""Authoritative radio metadata polling runtime."""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Protocol
from urllib.parse import urlsplit

from ....item_service import ItemService
from ....models import WorldItem
from ....network_security import open_validated_public_url

LOGGER = logging.getLogger("chgrid.server")
RADIO_METADATA_POLL_INTERVAL_S = 10.0
RADIO_METADATA_TIMEOUT_S = 6.0
RADIO_METADATA_MAX_CONCURRENCY = 4


class RadioRuntimeHost(Protocol):
    """Server operations required by radio metadata polling."""

    item_service: ItemService

    @property
    def items(self) -> dict[str, WorldItem]: ...

    def _has_listener_in_range(self, item: WorldItem) -> bool: ...

    def _request_state_save(self) -> None: ...

    async def _broadcast_item(self, item: WorldItem) -> None: ...


class RadioRuntime:
    """Own radio metadata fetching, polling, and item updates."""

    def __init__(self, host: RadioRuntimeHost) -> None:
        """Create an idle radio runtime bound to authoritative item state."""

        self.host = host
        self._task: asyncio.Task[None] | None = None
        self._metadata_semaphore = asyncio.Semaphore(RADIO_METADATA_MAX_CONCURRENCY)

    @property
    def items(self) -> dict[str, WorldItem]:
        """Return the current authoritative item mapping."""

        return self.host.items

    @property
    def item_service(self) -> ItemService:
        """Return item persistence used for metadata updates."""

        return self.host.item_service

    def start(self) -> None:
        """Start background metadata polling."""

        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run_radio_metadata_loop())

    async def shutdown(self) -> None:
        """Cancel and await background metadata polling."""

        if self._task is None:
            return
        self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)
        self._task = None

    @staticmethod
    def _fetch_stream_metadata(stream_url: str) -> tuple[str, str]:
        """Read ICY headers/metadata from a stream URL and return station/title."""

        if not stream_url:
            return "", ""
        with open_validated_public_url(
            stream_url,
            headers={"Icy-MetaData": "1", "User-Agent": "ChatGrid"},
            timeout=RADIO_METADATA_TIMEOUT_S,
        ) as response:
            station = str(
                response.headers.get("icy-name")
                or response.headers.get("ice-name")
                or ""
            ).strip()
            title = ""
            metaint_raw = response.headers.get("icy-metaint")
            if metaint_raw:
                metaint = int(metaint_raw)
                if metaint > 0:
                    response.read(metaint)
                    meta_len_byte = response.read(1)
                    if meta_len_byte:
                        meta_length = meta_len_byte[0] * 16
                        if meta_length > 0:
                            meta = response.read(meta_length).decode(errors="ignore")
                            match = re.search(r"StreamTitle='(.*?)';", meta)
                            if match:
                                title = match.group(1).strip()
            return station[:160], title[:200]

    async def fetch_metadata_safely(self, stream_url: str) -> tuple[str, str] | None:
        """Fetch one stream without allowing upstream failure to escape."""

        try:
            async with self._metadata_semaphore:
                return await asyncio.to_thread(self._fetch_stream_metadata, stream_url)
        except Exception:
            hostname = urlsplit(stream_url).hostname or "invalid"
            LOGGER.warning(
                "radio metadata fetch failed host=%s", hostname, exc_info=True
            )
            return None

    async def apply_metadata(
        self,
        radios: list[WorldItem],
        metadata: tuple[str, str] | None,
    ) -> None:
        """Apply one successful metadata result to matching radio items."""

        if metadata is None:
            return
        station_name, now_playing = metadata
        for item in radios:
            current_station = str(item.params.get("stationName", "")).strip()
            current_playing = str(item.params.get("nowPlaying", "")).strip()
            if station_name == current_station and now_playing == current_playing:
                continue
            item.params["stationName"] = station_name
            item.params["nowPlaying"] = now_playing
            item.updatedAt = self.item_service.now_ms()
            item.updatedBy = "system"
            item.updatedByName = "system"
            item.version += 1
            self.host._request_state_save()
            await self.host._broadcast_item(item)

    async def refresh_once(self) -> None:
        """Refresh metadata once per stream for radios near an active listener."""

        radios_by_stream: dict[str, list[WorldItem]] = {}
        for item in self.items.values():
            if (
                item.type != "radio_station"
                or not bool(item.params.get("enabled", True))
                or not isinstance(item.params.get("streamUrl"), str)
                or not self.host._has_listener_in_range(item)
            ):
                continue
            stream_url = str(item.params.get("streamUrl", "")).strip()
            if stream_url:
                radios_by_stream.setdefault(stream_url, []).append(item)

        stream_urls = list(radios_by_stream)
        results = await asyncio.gather(
            *(self.fetch_metadata_safely(url) for url in stream_urls)
        )
        for stream_url, metadata in zip(stream_urls, results, strict=True):
            await self.apply_metadata(radios_by_stream[stream_url], metadata)

    async def _run_radio_metadata_loop(self) -> None:
        """Background polling loop that refreshes radio now-playing metadata."""

        try:
            while True:
                try:
                    await self.refresh_once()
                except Exception:
                    LOGGER.exception("radio metadata polling cycle failed")
                await asyncio.sleep(RADIO_METADATA_POLL_INTERVAL_S)
        except asyncio.CancelledError:
            return
