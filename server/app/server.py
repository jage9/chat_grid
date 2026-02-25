"""Websocket signaling server for chat, presence, and item interactions."""

from __future__ import annotations

import argparse
import asyncio
from collections import deque
from contextlib import suppress
from datetime import datetime
from getpass import getpass
from importlib.metadata import PackageNotFoundError, version as package_version
import json
import logging
import os
import random
import re
import ssl
import time
import uuid
from pathlib import Path
from typing import Literal
from urllib.error import URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from pydantic import ValidationError, TypeAdapter
from websockets.asyncio.server import ServerConnection, serve

from .auth_service import AuthError, AuthService
from .client import ClientConnection
from .config import load_config
from .item_catalog import (
    CLOCK_DEFAULT_TIME_ZONE,
    CLOCK_TIME_ZONE_OPTIONS,
    ITEM_TYPE_EDITABLE_PROPERTIES,
    ITEM_TYPE_LABELS,
    ITEM_TYPE_PROPERTY_METADATA,
    ITEM_TYPE_SEQUENCE,
    ITEM_TYPE_TOOLTIPS,
    get_item_definition,
    get_item_global_properties,
    get_item_use_cooldown_ms,
    is_known_item_type,
)
from .item_type_handlers import get_item_type_handler
from .item_service import ItemService
from .models import (
    AuthLoginPacket,
    AuthLogoutPacket,
    AuthRegisterPacket,
    AuthRequiredPacket,
    AuthResultPacket,
    AuthResumePacket,
    BroadcastChatMessagePacket,
    BroadcastNicknamePacket,
    BroadcastPositionPacket,
    BroadcastTeleportCompletePacket,
    ChatMessagePacket,
    ClientPacket,
    ForwardSignalPacket,
    ItemActionResultPacket,
    ItemAddPacket,
    ItemDeletePacket,
    ItemDropPacket,
    ItemPianoNoteBroadcastPacket,
    ItemPianoNotePacket,
    ItemPianoRecordingPacket,
    ItemPianoStatusPacket,
    ItemPickupPacket,
    ItemRemovePacket,
    ItemSecondaryUsePacket,
    ItemUpdatePacket,
    ItemUpsertPacket,
    ItemUsePacket,
    ItemUseSoundPacket,
    NicknameResultPacket,
    PingPacket,
    PongPacket,
    RemoteUser,
    TeleportCompletePacket,
    UpdateNicknamePacket,
    UpdatePositionPacket,
    UserLeftPacket,
    WelcomePacket,
    WorldItem,
)

LOGGER = logging.getLogger("chgrid.server")
PACKET_LOGGER = logging.getLogger("chgrid.server.packet")
CLIENT_PACKET_ADAPTER = TypeAdapter(ClientPacket)
MAX_ACTIVE_PIANO_KEYS_PER_CLIENT = 12
PIANO_RECORDING_MAX_MS = 30_000
PIANO_RECORDING_MAX_EVENTS = 4096
MOVEMENT_TICK_MS = 200
MOVEMENT_MAX_STEPS_PER_TICK = 1
POSITION_PERSIST_DEBOUNCE_MS = 5_000
AUTH_HASH_MAX_CONCURRENCY = 8
AUTH_RATE_LIMIT_WINDOW_S = 30.0
AUTH_RATE_LIMIT_PER_IP = 20
AUTH_RATE_LIMIT_PER_IDENTITY = 8
AUTH_FAILURE_JITTER_MIN_MS = 0.02
AUTH_FAILURE_JITTER_MAX_MS = 0.08
RADIO_METADATA_POLL_INTERVAL_S = 10.0
RADIO_METADATA_TIMEOUT_S = 6.0


class SignalingServer:
    """Coordinates websocket clients, signaling, and authoritative item actions."""

    def __init__(
        self,
        host: str,
        port: int,
        ssl_cert: str | None,
        ssl_key: str | None,
        auth_db_path: Path | None = None,
        auth_token_hash_secret: str = "dev-secret",
        password_min_length: int = 8,
        password_max_length: int = 32,
        username_min_length: int = 2,
        username_max_length: int = 32,
        max_message_size: int = 2_000_000,
        state_file: Path | None = None,
        grid_size: int = 41,
        state_save_debounce_ms: int = 200,
        state_save_max_delay_ms: int = 1000,
    ):
        """Initialize runtime state, TLS context, and item service."""

        self.host = host
        self.port = port
        self.max_message_size = max_message_size
        self._ssl_context = self._build_ssl_context(ssl_cert, ssl_key)
        self.clients: dict[ServerConnection, ClientConnection] = {}
        resolved_auth_db_path = auth_db_path or Path.cwd() / "runtime" / "chatgrid.db"
        self.auth_service = AuthService(
            db_path=resolved_auth_db_path,
            token_hash_secret=auth_token_hash_secret,
            password_min_length=password_min_length,
            password_max_length=password_max_length,
            username_min_length=username_min_length,
            username_max_length=username_max_length,
        )
        self.item_service = ItemService(state_file=state_file)
        self.item_last_use_ms: dict[str, int] = {}
        self.active_piano_keys_by_client: dict[str, set[str]] = {}
        self.piano_recording_state_by_item: dict[str, dict] = {}
        self.piano_playback_tasks_by_item: dict[str, asyncio.Task[None]] = {}
        self.grid_size = max(1, grid_size)
        self.movement_tick_ms = MOVEMENT_TICK_MS
        self.movement_max_steps_per_tick = MOVEMENT_MAX_STEPS_PER_TICK
        self.instance_id = str(uuid.uuid4())
        self.server_version = self._resolve_server_version()
        self.state_save_debounce_ms = max(1, int(state_save_debounce_ms))
        self.state_save_max_delay_ms = max(self.state_save_debounce_ms, int(state_save_max_delay_ms))
        self._pending_state_save_handle: asyncio.TimerHandle | None = None
        self._pending_state_save_started_at: float | None = None
        self._last_position_persist_ms_by_user: dict[str, int] = {}
        self._auth_hash_semaphore = asyncio.Semaphore(AUTH_HASH_MAX_CONCURRENCY)
        self._auth_failures_by_ip: dict[str, deque[float]] = {}
        self._auth_failures_by_identity: dict[str, deque[float]] = {}
        self._radio_metadata_task: asyncio.Task[None] | None = None

    @staticmethod
    def _resolve_server_version() -> str:
        """Resolve serverInfo version, preferring synced web version when available."""

        env_override = os.getenv("CHGRID_SERVER_VERSION", "").strip()
        if env_override:
            return env_override

        try:
            version_file = Path(__file__).resolve().parents[2] / "client" / "public" / "version.js"
            text = version_file.read_text(encoding="utf-8")
            match = re.search(r'CHGRID_WEB_VERSION\s*=\s*"([^"]+)"', text)
            if match:
                token = match.group(1).strip()
                if token:
                    return token
        except OSError:
            pass

        try:
            return package_version("chgrid-server")
        except PackageNotFoundError:
            return "unknown"

    @property
    def items(self) -> dict[str, WorldItem]:
        """Expose current item map owned by the item service."""

        return self.item_service.items

    def _nickname_key(self, nickname: str) -> str:
        """Normalize nickname for case-insensitive comparisons."""

        return nickname.casefold()

    def _persist_client_position(self, client: ClientConnection, *, force: bool = False) -> None:
        """Persist one authenticated client's last known position with debounce."""

        if not client.user_id:
            return
        now_ms = self.item_service.now_ms()
        if not force:
            last_saved_ms = self._last_position_persist_ms_by_user.get(client.user_id, 0)
            if now_ms - last_saved_ms < POSITION_PERSIST_DEBOUNCE_MS:
                return
        self.auth_service.set_last_position(client.user_id, client.x, client.y)
        self._last_position_persist_ms_by_user[client.user_id] = now_ms

    def _auth_policy(self) -> dict[str, int]:
        """Return server-auth policy limits advertised to clients."""

        return {
            "usernameMinLength": self.auth_service.username_min_length,
            "usernameMaxLength": self.auth_service.username_max_length,
            "passwordMinLength": self.auth_service.password_min_length,
            "passwordMaxLength": self.auth_service.password_max_length,
        }

    def _flush_state_save(self) -> None:
        """Immediately flush pending state persistence and clear debounce state."""

        if self._pending_state_save_handle is not None:
            self._pending_state_save_handle.cancel()
            self._pending_state_save_handle = None
        self._pending_state_save_started_at = None
        self.item_service.save_state()

    def _request_state_save(self) -> None:
        """Debounce/coalesce item-state persistence to reduce write churn."""

        loop = asyncio.get_running_loop()
        now = loop.time()
        if self._pending_state_save_started_at is None:
            self._pending_state_save_started_at = now
        elapsed_ms = int((now - self._pending_state_save_started_at) * 1000)
        if elapsed_ms >= self.state_save_max_delay_ms:
            self._flush_state_save()
            return
        if self._pending_state_save_handle is not None:
            self._pending_state_save_handle.cancel()
        remaining_ms = max(0, self.state_save_max_delay_ms - elapsed_ms)
        delay_ms = min(self.state_save_debounce_ms, remaining_ms)
        self._pending_state_save_handle = loop.call_later(delay_ms / 1000, self._flush_state_save)

    def _is_nickname_taken(self, nickname: str, exclude_client_id: str | None = None) -> bool:
        """Check whether nickname is already used by another active client."""

        wanted = self._nickname_key(nickname)
        for other in self.clients.values():
            if exclude_client_id is not None and other.id == exclude_client_id:
                continue
            if self._nickname_key(other.nickname) == wanted:
                return True
        return False

    @staticmethod
    def _item_type_label(item: WorldItem) -> str:
        """Return user-facing item type wording for chat/status strings."""

        return "radio" if item.type == "radio_station" else item.type

    @staticmethod
    def _client_ip(client: ClientConnection) -> str:
        """Extract best-effort remote IP string for audit logs and auth throttling."""

        address = getattr(client.websocket, "remote_address", None)
        if isinstance(address, tuple) and address:
            return str(address[0])
        if isinstance(address, str):
            return address
        return "unknown"

    @staticmethod
    def _prune_failure_window(bucket: deque[float], now_s: float) -> None:
        """Drop expired auth-failure timestamps outside the active limit window."""

        threshold = now_s - AUTH_RATE_LIMIT_WINDOW_S
        while bucket and bucket[0] < threshold:
            bucket.popleft()

    def _auth_identity_key(self, client: ClientConnection, packet: ClientPacket) -> str:
        """Build username/IP scoped key used for auth failure throttling."""

        if isinstance(packet, (AuthLoginPacket, AuthRegisterPacket)):
            username = packet.username.strip().lower()
        elif isinstance(packet, AuthResumePacket):
            username = "resume"
        else:
            username = "unknown"
        return f"{self._client_ip(client)}::{username}"

    def _is_auth_rate_limited(self, client: ClientConnection, packet: ClientPacket) -> bool:
        """Return True when recent auth failures exceed IP or identity thresholds."""

        now_s = time.monotonic()
        ip_key = self._client_ip(client)
        identity_key = self._auth_identity_key(client, packet)

        ip_bucket = self._auth_failures_by_ip.setdefault(ip_key, deque())
        identity_bucket = self._auth_failures_by_identity.setdefault(identity_key, deque())
        self._prune_failure_window(ip_bucket, now_s)
        self._prune_failure_window(identity_bucket, now_s)

        return len(ip_bucket) >= AUTH_RATE_LIMIT_PER_IP or len(identity_bucket) >= AUTH_RATE_LIMIT_PER_IDENTITY

    def _record_auth_failure(self, client: ClientConnection, packet: ClientPacket) -> None:
        """Record a failed auth attempt for IP and identity-scoped throttling."""

        now_s = time.monotonic()
        ip_key = self._client_ip(client)
        identity_key = self._auth_identity_key(client, packet)
        self._auth_failures_by_ip.setdefault(ip_key, deque()).append(now_s)
        self._auth_failures_by_identity.setdefault(identity_key, deque()).append(now_s)

    def _clear_auth_failures(self, client: ClientConnection, packet: ClientPacket) -> None:
        """Clear identity-scoped auth failures after a successful authentication."""

        now_s = time.monotonic()
        identity_key = self._auth_identity_key(client, packet)
        bucket = self._auth_failures_by_identity.get(identity_key)
        if not bucket:
            return
        bucket.clear()
        self._prune_failure_window(bucket, now_s)

    async def _sleep_auth_failure_jitter(self) -> None:
        """Apply small randomized delay to reduce high-resolution auth timing probes."""

        await asyncio.sleep(random.uniform(AUTH_FAILURE_JITTER_MIN_MS, AUTH_FAILURE_JITTER_MAX_MS))

    async def _run_auth_hash_task(self, func, /, *args, **kwargs):
        """Run auth service call in a worker thread behind bounded hash concurrency."""

        async with self._auth_hash_semaphore:
            return await asyncio.to_thread(func, *args, **kwargs)

    @staticmethod
    def _resolve_item_use_sound(item: WorldItem) -> str | None:
        """Resolve one-shot use sound, preferring per-item param override."""

        param_sound = item.params.get("useSound")
        if isinstance(param_sound, str):
            token = param_sound.strip()
            if token:
                return token
            return None
        if isinstance(item.useSound, str) and item.useSound.strip():
            return item.useSound.strip()
        return None

    def _get_item_emit_range(self, item: WorldItem) -> int:
        """Return effective emit range for one item with sane bounds."""

        value = item.params.get("emitRange")
        if isinstance(value, (int, float)):
            emit_range = int(value)
            if emit_range > 0:
                return emit_range
        definition = get_item_definition(item.type)
        if isinstance(definition.emit_range, int) and definition.emit_range > 0:
            return definition.emit_range
        return 15

    def _has_listener_in_range(self, item: WorldItem) -> bool:
        """Return whether any connected user is currently inside item hear range."""

        emit_range = self._get_item_emit_range(item)
        for client in self.clients.values():
            if max(abs(client.x - item.x), abs(client.y - item.y)) <= emit_range:
                return True
        return False

    @staticmethod
    def _fetch_stream_metadata(stream_url: str) -> tuple[str, str]:
        """Read ICY headers/metadata from a stream URL and return station/title."""

        if not stream_url:
            return "", ""
        try:
            request = Request(
                stream_url,
                headers={"Icy-MetaData": "1", "User-Agent": "ChatGrid"},
            )
            with urlopen(request, timeout=RADIO_METADATA_TIMEOUT_S) as response:
                station = str(response.headers.get("icy-name") or response.headers.get("ice-name") or "").strip()
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
        except (OSError, URLError, ValueError):
            return "", ""

    async def _refresh_radio_metadata_once(self) -> None:
        """Refresh station/title metadata for active radios near at least one listener."""

        radios = [
            item
            for item in self.items.values()
            if item.type == "radio_station"
            and bool(item.params.get("enabled", True))
            and isinstance(item.params.get("streamUrl"), str)
            and str(item.params.get("streamUrl", "")).strip()
            and self._has_listener_in_range(item)
        ]
        for item in radios:
            stream_url = str(item.params.get("streamUrl", "")).strip()
            station_name, now_playing = await asyncio.to_thread(self._fetch_stream_metadata, stream_url)
            current_station = str(item.params.get("stationName", "")).strip()
            current_playing = str(item.params.get("nowPlaying", "")).strip()
            if station_name == current_station and now_playing == current_playing:
                continue
            item.params["stationName"] = station_name
            item.params["nowPlaying"] = now_playing
            item.updatedAt = self.item_service.now_ms()
            item.version += 1
            self._request_state_save()
            await self._broadcast_item(item)

    async def _run_radio_metadata_loop(self) -> None:
        """Background polling loop that refreshes radio now-playing metadata."""

        try:
            while True:
                await self._refresh_radio_metadata_once()
                await asyncio.sleep(RADIO_METADATA_POLL_INTERVAL_S)
        except asyncio.CancelledError:
            return

    def _get_item_sound_source_position(self, item: WorldItem) -> tuple[int, int]:
        """Resolve source position for item-emitted one-shot sounds."""

        if item.carrierId:
            carrier = self._get_client_by_id(item.carrierId)
            if carrier is not None:
                return carrier.x, carrier.y
        return item.x, item.y

    def _get_client_by_id(self, client_id: str) -> ClientConnection | None:
        """Resolve one connected client by id."""

        for connected in self.clients.values():
            if connected.id == client_id:
                return connected
        return None

    def _get_piano_source_position(self, item: WorldItem) -> tuple[int, int]:
        """Resolve world position used for piano note spatial broadcasts."""

        if item.carrierId:
            carrier = self._get_client_by_id(item.carrierId)
            if carrier is not None:
                return carrier.x, carrier.y
        return item.x, item.y

    async def _broadcast_item_piano_note(
        self,
        item: WorldItem,
        *,
        sender_id: str,
        key_id: str,
        midi: int,
        on: bool,
        instrument_override: str | None = None,
        voice_mode_override: str | None = None,
        attack_override: int | None = None,
        decay_override: int | None = None,
        release_override: int | None = None,
        brightness_override: int | None = None,
        emit_range_override: int | None = None,
        exclude: ServerConnection | None = None,
    ) -> None:
        """Broadcast one piano note event using current item synth settings."""

        instrument = (instrument_override if isinstance(instrument_override, str) else str(item.params.get("instrument", "piano"))).strip().lower()
        voice_mode = (voice_mode_override if isinstance(voice_mode_override, str) else str(item.params.get("voiceMode", "poly"))).strip().lower()
        if voice_mode not in {"poly", "mono"}:
            voice_mode = "poly"
        octave = int(item.params.get("octave", 0)) if isinstance(item.params.get("octave", 0), (int, float)) else 0
        attack = (
            int(attack_override)
            if isinstance(attack_override, int)
            else int(item.params.get("attack", 15))
            if isinstance(item.params.get("attack", 15), (int, float))
            else 15
        )
        decay = (
            int(decay_override)
            if isinstance(decay_override, int)
            else int(item.params.get("decay", 45))
            if isinstance(item.params.get("decay", 45), (int, float))
            else 45
        )
        release = (
            int(release_override)
            if isinstance(release_override, int)
            else int(item.params.get("release", 35))
            if isinstance(item.params.get("release", 35), (int, float))
            else 35
        )
        brightness = (
            int(brightness_override)
            if isinstance(brightness_override, int)
            else int(item.params.get("brightness", 55))
            if isinstance(item.params.get("brightness", 55), (int, float))
            else 55
        )
        emit_range = (
            int(emit_range_override)
            if isinstance(emit_range_override, int)
            else int(item.params.get("emitRange", 15))
            if isinstance(item.params.get("emitRange", 15), (int, float))
            else 15
        )
        source_x, source_y = self._get_piano_source_position(item)
        await self._broadcast(
            ItemPianoNoteBroadcastPacket(
                type="item_piano_note",
                itemId=item.id,
                senderId=sender_id,
                keyId=key_id,
                midi=max(0, min(127, int(midi))),
                on=on,
                instrument=instrument,
                voiceMode=voice_mode,
                octave=max(-2, min(2, octave)),
                attack=max(0, min(100, attack)),
                decay=max(0, min(100, decay)),
                release=max(0, min(100, release)),
                brightness=max(0, min(100, brightness)),
                x=source_x,
                y=source_y,
                emitRange=max(5, min(20, emit_range)),
            ),
            exclude=exclude,
        )

    def _cancel_piano_playback(self, item_id: str) -> None:
        """Cancel active playback task for one piano item, if any."""

        task = self.piano_playback_tasks_by_item.pop(item_id, None)
        if task is not None and not task.done():
            task.cancel()

    @staticmethod
    def _recording_elapsed_ms(session: dict, now_monotonic: float | None = None) -> int:
        """Compute effective recorded duration, including currently active segment."""

        elapsed_ms = int(session.get("elapsedMs", 0)) if isinstance(session.get("elapsedMs"), (int, float)) else 0
        paused = session.get("paused") is True
        if paused:
            return max(0, elapsed_ms)
        last_resume = session.get("lastResumeMonotonic")
        if isinstance(last_resume, (int, float)):
            now_value = now_monotonic if isinstance(now_monotonic, (int, float)) else time.monotonic()
            elapsed_ms += max(0, int((now_value - float(last_resume)) * 1000))
        return max(0, elapsed_ms)

    async def _finalize_piano_recording(self, item_id: str, *, notify_owner: bool = False) -> None:
        """Persist and broadcast one active recording session, then clear runtime state."""

        session = self.piano_recording_state_by_item.pop(item_id, None)
        if not session:
            return
        auto_stop_task = session.get("autoStopTask")
        if isinstance(auto_stop_task, asyncio.Task) and not auto_stop_task.done():
            auto_stop_task.cancel()
        item = self.items.get(item_id)
        if not item or item.type != "piano":
            return
        elapsed_ms = max(0, min(PIANO_RECORDING_MAX_MS, self._recording_elapsed_ms(session)))
        recorded_events = session.get("events")
        events = list(recorded_events) if isinstance(recorded_events, list) else []
        song_id = f"item:{item.id}:recording"
        keys: list[str] = []
        key_to_index: dict[str, int] = {}
        states: list[list[object]] = []
        state_to_index: dict[tuple[object, ...], int] = {}
        compact_events: list[list[int]] = []
        for event in events:
            if not isinstance(event, dict):
                continue
            t = int(event.get("t", 0)) if isinstance(event.get("t"), (int, float)) else 0
            key_id = str(event.get("keyId", "")).strip()
            midi = int(event.get("midi", 0)) if isinstance(event.get("midi"), (int, float)) else 0
            on = 1 if event.get("on") is True else 0
            instrument = str(event.get("instrument", "piano")).strip().lower() or "piano"
            voice_mode = str(event.get("voiceMode", "poly")).strip().lower()
            if voice_mode not in {"mono", "poly"}:
                voice_mode = "poly"
            attack = int(event.get("attack", 15)) if isinstance(event.get("attack"), (int, float)) else 15
            decay = int(event.get("decay", 45)) if isinstance(event.get("decay"), (int, float)) else 45
            release = int(event.get("release", 35)) if isinstance(event.get("release"), (int, float)) else 35
            brightness = int(event.get("brightness", 55)) if isinstance(event.get("brightness"), (int, float)) else 55
            emit_range = int(event.get("emitRange", 15)) if isinstance(event.get("emitRange"), (int, float)) else 15
            state_key = (
                instrument,
                voice_mode,
                max(0, min(100, attack)),
                max(0, min(100, decay)),
                max(0, min(100, release)),
                max(0, min(100, brightness)),
                max(5, min(20, emit_range)),
            )
            if not key_id:
                continue
            index = key_to_index.get(key_id)
            if index is None:
                index = len(keys)
                keys.append(key_id)
                key_to_index[key_id] = index
            state_index = state_to_index.get(state_key)
            if state_index is None:
                state_index = len(states)
                states.append(list(state_key))
                state_to_index[state_key] = state_index
            compact_events.append([max(0, min(PIANO_RECORDING_MAX_MS, t)), index, max(0, min(127, midi)), on, state_index])
        compact_events.sort(key=lambda row: row[0])
        first_state = states[0] if states else ["piano", "poly", 15, 45, 35, 55, 15]
        self.item_service.piano_songs[song_id] = {
            "meta": {
                "instrument": first_state[0],
                "voiceMode": first_state[1],
                "attack": first_state[2],
                "decay": first_state[3],
                "release": first_state[4],
                "brightness": first_state[5],
                "emitRange": first_state[6],
                "recordingLengthMs": elapsed_ms,
            },
            "keys": keys,
            "states": states,
            "events": compact_events,
        }
        self.item_service.save_piano_songs()
        item.params["songId"] = song_id
        item.params.pop("recording", None)
        item.params.pop("recordingLengthMs", None)
        item.updatedAt = self.item_service.now_ms()
        item.version += 1
        self._request_state_save()
        await self._broadcast_item(item)
        owner_id = str(session.get("ownerClientId", ""))
        owner = self._get_client_by_id(owner_id) if owner_id else None
        if owner and notify_owner:
            await self._send_piano_status(
                owner,
                item_id=item.id,
                event="record_stopped",
                recording_state="idle",
            )
            await self._send_item_result(owner, True, "use", "Recording stopped.", item.id)

    async def _auto_stop_piano_recording(self, item_id: str) -> None:
        """Stop a recording automatically at the max recording duration."""

        try:
            while True:
                session = self.piano_recording_state_by_item.get(item_id)
                if not isinstance(session, dict):
                    return
                if self._recording_elapsed_ms(session) >= PIANO_RECORDING_MAX_MS:
                    await self._finalize_piano_recording(item_id, notify_owner=True)
                    return
                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            return

    async def _start_piano_playback(self, item: WorldItem) -> None:
        """Run one piano recording playback task and broadcast note events."""

        sender_id = f"item:{item.id}:playback"
        events: list[dict[str, object]] = []
        song_id = str(item.params.get("songId", "")).strip()
        song_payload = self.item_service.piano_songs.get(song_id) if song_id else None
        if isinstance(song_payload, dict):
            keys = song_payload.get("keys")
            states = song_payload.get("states")
            compact_events = song_payload.get("events")
            meta = song_payload.get("meta")
            if isinstance(keys, list) and isinstance(compact_events, list):
                base_state = None
                if isinstance(meta, dict):
                    instrument = str(meta.get("instrument", "")).strip().lower() or "piano"
                    raw_voice_mode = str(meta.get("voiceMode", "")).strip().lower()
                    voice_mode = raw_voice_mode if raw_voice_mode in {"mono", "poly"} else "poly"
                    attack = int(meta.get("attack", 15)) if isinstance(meta.get("attack"), (int, float)) else 15
                    decay = int(meta.get("decay", 45)) if isinstance(meta.get("decay"), (int, float)) else 45
                    release = int(meta.get("release", 35)) if isinstance(meta.get("release"), (int, float)) else 35
                    brightness = int(meta.get("brightness", 55)) if isinstance(meta.get("brightness"), (int, float)) else 55
                    emit_range = int(meta.get("emitRange", 15)) if isinstance(meta.get("emitRange"), (int, float)) else 15
                    base_state = (
                        instrument,
                        voice_mode,
                        max(0, min(100, attack)),
                        max(0, min(100, decay)),
                        max(0, min(100, release)),
                        max(0, min(100, brightness)),
                        max(5, min(20, emit_range)),
                    )
                for row in compact_events:
                    if not isinstance(row, list) or len(row) < 4:
                        continue
                    raw_time, raw_key_idx, raw_midi, raw_on = row[:4]
                    if not isinstance(raw_time, (int, float)) or not isinstance(raw_key_idx, (int, float)) or not isinstance(raw_midi, (int, float)):
                        continue
                    key_idx = int(raw_key_idx)
                    if key_idx < 0 or key_idx >= len(keys):
                        continue
                    raw_key = keys[key_idx]
                    if not isinstance(raw_key, str) or not raw_key.strip():
                        continue
                    state = base_state
                    if len(row) >= 5 and isinstance(states, list) and isinstance(row[4], (int, float)):
                        state_idx = int(row[4])
                        if 0 <= state_idx < len(states):
                            state_row = states[state_idx]
                            if isinstance(state_row, list) and len(state_row) >= 7:
                                candidate_instrument = str(state_row[0]).strip().lower() or "piano"
                                candidate_voice_mode = str(state_row[1]).strip().lower()
                                state = (
                                    candidate_instrument,
                                    candidate_voice_mode if candidate_voice_mode in {"mono", "poly"} else "poly",
                                    max(0, min(100, int(state_row[2]) if isinstance(state_row[2], (int, float)) else 15)),
                                    max(0, min(100, int(state_row[3]) if isinstance(state_row[3], (int, float)) else 45)),
                                    max(0, min(100, int(state_row[4]) if isinstance(state_row[4], (int, float)) else 35)),
                                    max(0, min(100, int(state_row[5]) if isinstance(state_row[5], (int, float)) else 55)),
                                    max(5, min(20, int(state_row[6]) if isinstance(state_row[6], (int, float)) else 15)),
                                )
                    if state is None:
                        continue
                    events.append(
                        {
                            "t": max(0, min(PIANO_RECORDING_MAX_MS, int(raw_time))),
                            "keyId": raw_key[:32],
                            "midi": max(0, min(127, int(raw_midi))),
                            "on": bool(raw_on),
                            "instrument": state[0],
                            "voiceMode": state[1],
                            "attack": state[2],
                            "decay": state[3],
                            "release": state[4],
                            "brightness": state[5],
                            "emitRange": state[6],
                        }
                    )
        events.sort(key=lambda entry: int(entry["t"]))
        if not events:
            return

        active_keys: dict[str, int] = {}
        previous_at_ms = 0
        try:
            for event in events:
                current_at_ms = int(event["t"])
                delay_ms = max(0, current_at_ms - previous_at_ms)
                if delay_ms > 0:
                    await asyncio.sleep(delay_ms / 1000)
                current_item = self.items.get(item.id)
                if not current_item or current_item.type != "piano":
                    break
                key_id = str(event["keyId"])
                midi = int(event["midi"])
                on = bool(event["on"])
                if on:
                    active_keys[key_id] = midi
                else:
                    active_keys.pop(key_id, None)
                await self._broadcast_item_piano_note(
                    current_item,
                    sender_id=sender_id,
                    key_id=key_id,
                    midi=midi,
                    on=on,
                    instrument_override=event.get("instrument") if isinstance(event.get("instrument"), str) else None,
                    voice_mode_override=event.get("voiceMode") if isinstance(event.get("voiceMode"), str) else None,
                    attack_override=event.get("attack") if isinstance(event.get("attack"), int) else None,
                    decay_override=event.get("decay") if isinstance(event.get("decay"), int) else None,
                    release_override=event.get("release") if isinstance(event.get("release"), int) else None,
                    brightness_override=event.get("brightness") if isinstance(event.get("brightness"), int) else None,
                    emit_range_override=event.get("emitRange") if isinstance(event.get("emitRange"), int) else None,
                )
                previous_at_ms = current_at_ms
        except asyncio.CancelledError:
            pass
        finally:
            current_item = self.items.get(item.id)
            if current_item and current_item.type == "piano":
                for key_id, midi in list(active_keys.items()):
                    await self._broadcast_item_piano_note(
                        current_item,
                        sender_id=sender_id,
                        key_id=key_id,
                        midi=midi,
                        on=False,
                    )
            current_task = self.piano_playback_tasks_by_item.get(item.id)
            if current_task is asyncio.current_task():
                self.piano_playback_tasks_by_item.pop(item.id, None)

    def _is_in_bounds(self, x: int, y: int) -> bool:
        """Check whether a coordinate is inside server-authoritative world bounds."""

        return 0 <= x < self.grid_size and 0 <= y < self.grid_size

    def _movement_window_index(self, now_ms: int) -> int:
        """Return current movement rate-limit window index for a server timestamp."""

        return max(0, now_ms // self.movement_tick_ms)

    def _consume_movement_budget(self, client: ClientConnection, now_ms: int, requested_delta: int) -> bool:
        """Consume per-window movement budget; return whether the move is allowed."""

        window_index = self._movement_window_index(now_ms)
        if client.movement_window_index != window_index:
            client.movement_window_index = window_index
            client.movement_window_steps_used = 0
        remaining = max(0, self.movement_max_steps_per_tick - client.movement_window_steps_used)
        if requested_delta > remaining:
            return False
        client.movement_window_steps_used += requested_delta
        return True

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
    def _format_clock_display_time(cls, params: dict) -> str:
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

    async def _send_item_result(
        self,
        client: ClientConnection,
        ok: bool,
        action: Literal["add", "pickup", "drop", "delete", "use", "secondary_use", "update"],
        message: str,
        item_id: str | None = None,
    ) -> None:
        """Send a structured item action result to one client."""

        await self._send(
            client.websocket,
            ItemActionResultPacket(
                type="item_action_result",
                ok=ok,
                action=action,
                message=message,
                itemId=item_id,
            ),
        )

    async def _send_piano_status(
        self,
        client: ClientConnection,
        *,
        item_id: str,
        event: Literal[
            "use_mode_entered",
            "record_started",
            "record_paused",
            "record_resumed",
            "record_stopped",
            "playback_started",
            "playback_stopped",
        ],
        recording_state: Literal["idle", "recording", "paused", "playback"] | None = None,
    ) -> None:
        """Send structured piano state transitions without relying on status-message text."""

        await self._send(
            client.websocket,
            ItemPianoStatusPacket(
                type="item_piano_status",
                itemId=item_id,
                event=event,
                recordingState=recording_state,
            ),
        )

    async def _broadcast_item(self, item: WorldItem) -> None:
        """Broadcast a full item snapshot update to all connected clients."""

        await self._broadcast(ItemUpsertPacket(type="item_upsert", item=item))

    async def start(self) -> None:
        """Start websocket serving and run until cancelled."""

        protocol = "wss" if self._ssl_context else "ws"
        LOGGER.info("starting signaling server on %s://%s:%d", protocol, self.host, self.port)
        self._radio_metadata_task = asyncio.create_task(self._run_radio_metadata_loop())
        try:
            async with serve(
                self._handle_client,
                self.host,
                self.port,
                ssl=self._ssl_context,
                max_size=self.max_message_size,
            ):
                await asyncio.Future()
        finally:
            if self._radio_metadata_task is not None:
                self._radio_metadata_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._radio_metadata_task
                self._radio_metadata_task = None
            self._flush_state_save()
            self.auth_service.close()

    async def _handle_client(self, websocket: ServerConnection) -> None:
        """Handle one websocket client's connect/message/disconnect lifecycle."""

        client = ClientConnection(websocket=websocket, id=str(uuid.uuid4()))
        LOGGER.info("websocket opened id=%s", client.id)

        try:
            await self._send(
                websocket,
                AuthRequiredPacket(
                    type="auth_required",
                    message="Authentication required.",
                    authPolicy=self._auth_policy(),
                ),
            )
            async for raw_message in websocket:
                await self._handle_message(client, raw_message)
        finally:
            if websocket in self.clients:
                disconnected = self.clients.pop(websocket)
                self.active_piano_keys_by_client.pop(disconnected.id, None)
                self._persist_client_position(disconnected, force=True)
                if disconnected.user_id:
                    self._last_position_persist_ms_by_user.pop(disconnected.user_id, None)
                for item_id, session in list(self.piano_recording_state_by_item.items()):
                    if session.get("ownerClientId") != disconnected.id:
                        continue
                    await self._finalize_piano_recording(item_id)
                for item in self.item_service.drop_carried_items_for_disconnect(disconnected):
                    await self._broadcast_item(item)
                self._request_state_save()
                LOGGER.info(
                    "client disconnected id=%s nickname=%s total=%d",
                    disconnected.id,
                    disconnected.nickname,
                    len(self.clients),
                )
                await self._broadcast(UserLeftPacket(type="user_left", id=disconnected.id), exclude=websocket)
                await self._broadcast(
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message=f"{disconnected.nickname} has logged out.",
                        system=True,
                    ),
                    exclude=websocket,
                )

    async def _send_welcome(self, client: ClientConnection) -> None:
        """Send initial world snapshot to a newly connected client."""

        users = [
            RemoteUser(id=other.id, nickname=other.nickname, x=other.x, y=other.y)
            for ws, other in self.clients.items()
            if ws is not client.websocket
        ]
        packet = WelcomePacket(
            type="welcome",
            id=client.id,
            player=RemoteUser(id=client.id, nickname=client.nickname, x=client.x, y=client.y),
            users=users,
            items=[item.model_dump(exclude_none=True) for item in self.items.values()],
            worldConfig={
                "gridSize": self.grid_size,
                "movementTickMs": self.movement_tick_ms,
                "movementMaxStepsPerTick": self.movement_max_steps_per_tick,
            },
            uiDefinitions=self._build_ui_definitions(),
            serverInfo={"instanceId": self.instance_id, "version": self.server_version},
            auth={
                "authenticated": client.authenticated,
                "userId": client.user_id,
                "username": client.username,
                "role": client.role if client.authenticated else None,
                "policy": self._auth_policy(),
            },
        )
        await self._send(client.websocket, packet)

    async def _activate_authenticated_client(self, client: ClientConnection) -> None:
        """Move an authenticated websocket client into the active world roster."""

        if client.websocket in self.clients:
            return
        saved_x = getattr(client, "saved_x", None)
        saved_y = getattr(client, "saved_y", None)
        if isinstance(saved_x, int) and isinstance(saved_y, int) and self._is_in_bounds(saved_x, saved_y):
            client.x = saved_x
            client.y = saved_y
        else:
            client.x = random.randrange(self.grid_size)
            client.y = random.randrange(self.grid_size)
        now_ms = self.item_service.now_ms()
        client.last_position_update_ms = now_ms
        client.movement_window_index = self._movement_window_index(now_ms)
        client.movement_window_steps_used = 0
        self.clients[client.websocket] = client
        LOGGER.info(
            "client authenticated id=%s user_id=%s username=%s total=%d",
            client.id,
            client.user_id,
            client.username,
            len(self.clients),
        )
        await self._send_welcome(client)
        await self._broadcast(
            BroadcastChatMessagePacket(
                type="chat_message",
                message=f"{client.nickname} has logged in.",
                system=True,
            ),
            exclude=client.websocket,
        )

    async def _handle_auth_packet(self, client: ClientConnection, packet: ClientPacket) -> bool:
        """Handle pre-auth packets; returns True when packet was an auth command."""

        if client.authenticated and isinstance(packet, (AuthLoginPacket, AuthRegisterPacket, AuthResumePacket)):
            await self._send(
                client.websocket,
                AuthResultPacket(
                    type="auth_result",
                    ok=False,
                    message="Already authenticated.",
                    authPolicy=self._auth_policy(),
                ),
            )
            return True

        if isinstance(packet, (AuthLoginPacket, AuthRegisterPacket, AuthResumePacket)) and self._is_auth_rate_limited(
            client, packet
        ):
            LOGGER.warning(
                "auth rate limited id=%s ip=%s packet=%s",
                client.id,
                self._client_ip(client),
                packet.type,
            )
            await self._sleep_auth_failure_jitter()
            await self._send(
                client.websocket,
                AuthResultPacket(
                    type="auth_result",
                    ok=False,
                    message="Too many authentication attempts. Try again shortly.",
                    authPolicy=self._auth_policy(),
                ),
            )
            return True

        try:
            if isinstance(packet, AuthRegisterPacket):
                session = await self._run_auth_hash_task(
                    self.auth_service.register,
                    packet.username,
                    packet.password,
                    email=packet.email,
                )
                LOGGER.info(
                    "auth register success id=%s ip=%s username=%s user_id=%s",
                    client.id,
                    self._client_ip(client),
                    session.user.username,
                    session.user.id,
                )
            elif isinstance(packet, AuthLoginPacket):
                session = await self._run_auth_hash_task(self.auth_service.login, packet.username, packet.password)
                LOGGER.info(
                    "auth login success id=%s ip=%s username=%s user_id=%s",
                    client.id,
                    self._client_ip(client),
                    session.user.username,
                    session.user.id,
                )
            elif isinstance(packet, AuthResumePacket):
                session = self.auth_service.resume(packet.sessionToken)
                LOGGER.info(
                    "auth resume success id=%s ip=%s username=%s user_id=%s",
                    client.id,
                    self._client_ip(client),
                    session.user.username,
                    session.user.id,
                )
            elif isinstance(packet, AuthLogoutPacket):
                if client.session_token:
                    self.auth_service.revoke(client.session_token)
                    client.session_token = None
                LOGGER.info("auth logout id=%s ip=%s username=%s", client.id, self._client_ip(client), client.username)
                await self._send(
                    client.websocket,
                    AuthResultPacket(
                        type="auth_result",
                        ok=True,
                        message="Logged out.",
                        authPolicy=self._auth_policy(),
                    ),
                )
                await client.websocket.close()
                return True
            else:
                return False
        except AuthError as exc:
            if isinstance(packet, (AuthLoginPacket, AuthRegisterPacket, AuthResumePacket)):
                self._record_auth_failure(client, packet)
                await self._sleep_auth_failure_jitter()
            LOGGER.warning(
                "auth failure id=%s ip=%s packet=%s reason=%s",
                client.id,
                self._client_ip(client),
                packet.type,
                str(exc),
            )
            await self._send(
                client.websocket,
                AuthResultPacket(
                    type="auth_result",
                    ok=False,
                    message=str(exc),
                    authPolicy=self._auth_policy(),
                ),
            )
            return True

        if isinstance(packet, (AuthLoginPacket, AuthRegisterPacket, AuthResumePacket)):
            self._clear_auth_failures(client, packet)

        client.authenticated = True
        client.user_id = session.user.id
        client.username = session.user.username
        client.role = session.user.role
        client.session_token = session.token
        client.nickname = session.user.last_nickname or client.nickname
        client.saved_x = session.user.last_x
        client.saved_y = session.user.last_y
        await self._send(
            client.websocket,
            AuthResultPacket(
                type="auth_result",
                ok=True,
                message="Authenticated.",
                sessionToken=session.token,
                username=session.user.username,
                role=session.user.role,
                nickname=client.nickname,
                authPolicy=self._auth_policy(),
            ),
        )
        await self._activate_authenticated_client(client)
        return True

    def _build_ui_definitions(self) -> dict:
        """Build server-owned UI definitions for item/menu rendering."""

        item_types: list[dict] = []
        for item_type in ITEM_TYPE_SEQUENCE:
            editable = list(ITEM_TYPE_EDITABLE_PROPERTIES.get(item_type, ("title",)))
            item_types.append(
                {
                    "type": item_type,
                    "label": ITEM_TYPE_LABELS.get(item_type, item_type),
                    "tooltip": ITEM_TYPE_TOOLTIPS.get(item_type),
                    "capabilities": list(get_item_definition(item_type).capabilities),
                    "editableProperties": editable,
                    "propertyMetadata": ITEM_TYPE_PROPERTY_METADATA.get(item_type, {}),
                    "globalProperties": get_item_global_properties(item_type),
                }
            )
        return {
            "itemTypeOrder": list(ITEM_TYPE_SEQUENCE),
            "itemTypes": item_types,
        }

    async def _broadcast_wheel_result_after_delay(
        self,
        client: ClientConnection,
        self_message: str,
        others_message: str,
        delay_seconds: float = 3.0,
    ) -> None:
        """Delay then publish wheel result text to self and other users."""

        await asyncio.sleep(delay_seconds)
        await self._broadcast(
            BroadcastChatMessagePacket(type="chat_message", message=others_message, system=True),
            exclude=client.websocket,
        )
        if client.websocket in self.clients:
            await self._send(
                client.websocket,
                BroadcastChatMessagePacket(type="chat_message", message=self_message, system=True),
            )

    async def _handle_message(self, client: ClientConnection, raw_message: str) -> None:
        """Decode, validate, and route one inbound client packet."""

        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            PACKET_LOGGER.warning("non-json packet from id=%s", client.id)
            return

        try:
            packet = CLIENT_PACKET_ADAPTER.validate_python(payload)
        except ValidationError as exc:
            PACKET_LOGGER.warning("invalid packet from id=%s: %s", client.id, exc)
            return

        # Compatibility path for local tests injecting pre-authenticated clients
        # directly into server.clients without running websocket auth handshake.
        if not client.authenticated and client.websocket in self.clients:
            client.authenticated = True
            client.user_id = client.user_id or client.id
            client.username = client.username or client.nickname

        if await self._handle_auth_packet(client, packet):
            return
        if not client.authenticated:
            await self._send(
                client.websocket,
                AuthResultPacket(type="auth_result", ok=False, message="Authenticate before sending gameplay actions."),
            )
            return

        if isinstance(packet, UpdatePositionPacket):
            if not self._is_in_bounds(packet.x, packet.y):
                PACKET_LOGGER.warning(
                    "out-of-bounds position ignored id=%s x=%d y=%d grid_size=%d",
                    client.id,
                    packet.x,
                    packet.y,
                    self.grid_size,
                )
                await self._send(
                    client.websocket,
                    BroadcastPositionPacket(type="update_position", id=client.id, x=client.x, y=client.y),
                )
                return
            now_ms = self.item_service.now_ms()
            requested_delta = max(abs(packet.x - client.x), abs(packet.y - client.y))
            if not self._consume_movement_budget(client, now_ms, requested_delta):
                remaining = max(0, self.movement_max_steps_per_tick - client.movement_window_steps_used)
                PACKET_LOGGER.warning(
                    "position rate limit ignored id=%s from=%d,%d to=%d,%d requested_delta=%d remaining_budget=%d window=%d",
                    client.id,
                    client.x,
                    client.y,
                    packet.x,
                    packet.y,
                    requested_delta,
                    remaining,
                    client.movement_window_index,
                )
                await self._send(
                    client.websocket,
                    BroadcastPositionPacket(type="update_position", id=client.id, x=client.x, y=client.y),
                )
                return
            client.x = packet.x
            client.y = packet.y
            client.last_position_update_ms = now_ms
            self._persist_client_position(client)
            await self._send(
                client.websocket,
                BroadcastPositionPacket(type="update_position", id=client.id, x=client.x, y=client.y),
            )
            await self._broadcast(
                BroadcastPositionPacket(type="update_position", id=client.id, x=client.x, y=client.y),
                exclude=client.websocket,
            )
            carried = self.item_service.find_carried_item(client.id)
            if carried:
                carried.x = client.x
                carried.y = client.y
                carried.updatedAt = self.item_service.now_ms()
                await self._broadcast_item(carried)
            return

        if isinstance(packet, TeleportCompletePacket):
            if not self._is_in_bounds(packet.x, packet.y):
                PACKET_LOGGER.warning(
                    "out-of-bounds teleport ignored id=%s x=%d y=%d grid_size=%d",
                    client.id,
                    packet.x,
                    packet.y,
                    self.grid_size,
                )
                await self._send(
                    client.websocket,
                    BroadcastPositionPacket(type="update_position", id=client.id, x=client.x, y=client.y),
                )
                return

            client.x = packet.x
            client.y = packet.y
            client.last_position_update_ms = self.item_service.now_ms()
            self._persist_client_position(client, force=True)
            await self._send(
                client.websocket,
                BroadcastPositionPacket(type="update_position", id=client.id, x=client.x, y=client.y),
            )
            await self._broadcast(
                BroadcastPositionPacket(type="update_position", id=client.id, x=client.x, y=client.y),
                exclude=client.websocket,
            )
            carried = self.item_service.find_carried_item(client.id)
            if carried:
                carried.x = client.x
                carried.y = client.y
                carried.updatedAt = self.item_service.now_ms()
                await self._broadcast_item(carried)
            await self._broadcast(
                BroadcastTeleportCompletePacket(
                    type="teleport_complete",
                    id=client.id,
                    x=client.x,
                    y=client.y,
                ),
                exclude=client.websocket,
            )
            return

        if isinstance(packet, UpdateNicknamePacket):
            requested_nickname = packet.nickname.strip()
            if not requested_nickname:
                await self._send(
                    client.websocket,
                    NicknameResultPacket(
                        type="nickname_result",
                        accepted=False,
                        requestedNickname=packet.nickname,
                        effectiveNickname=client.nickname,
                        reason="Nickname is required.",
                    ),
                )
                return
            old_nickname = client.nickname
            if self._is_nickname_taken(requested_nickname, exclude_client_id=client.id):
                await self._send(
                    client.websocket,
                    NicknameResultPacket(
                        type="nickname_result",
                        accepted=False,
                        requestedNickname=requested_nickname,
                        effectiveNickname=client.nickname,
                        reason="Nickname already in use.",
                    ),
                )
                return
            if requested_nickname == old_nickname:
                await self._send(
                    client.websocket,
                    NicknameResultPacket(
                        type="nickname_result",
                        accepted=True,
                        requestedNickname=requested_nickname,
                        effectiveNickname=client.nickname,
                    ),
                )
                return
            client.nickname = requested_nickname
            if client.user_id:
                self.auth_service.set_last_nickname(client.user_id, client.nickname)
            if old_nickname == "user...":
                LOGGER.info("user login id=%s nickname=%s", client.id, client.nickname)
            else:
                LOGGER.info("nickname change id=%s old=%s new=%s", client.id, old_nickname, client.nickname)
            await self._send(
                client.websocket,
                NicknameResultPacket(
                    type="nickname_result",
                    accepted=True,
                    requestedNickname=requested_nickname,
                    effectiveNickname=client.nickname,
                ),
            )
            await self._broadcast(
                BroadcastNicknamePacket(type="update_nickname", id=client.id, nickname=client.nickname),
                exclude=client.websocket,
            )
            if old_nickname == "user...":
                await self._broadcast(
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message=f"{client.nickname} has logged in.",
                        system=True,
                    ),
                    exclude=client.websocket,
                )
            else:
                await self._broadcast(
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message=f"{old_nickname} is now known as {client.nickname}.",
                        system=True,
                    ),
                    exclude=client.websocket,
                )
            self_message = (
                f"Welcome. Logged in as {client.nickname}."
                if old_nickname == "user..."
                else f"You are now known as {client.nickname}."
            )
            await self._send(
                client.websocket,
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=self_message,
                    system=True,
                ),
            )
            return

        if isinstance(packet, ChatMessagePacket):
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=packet.message,
                    senderId=client.id,
                    senderNickname=client.nickname,
                    system=False,
                )
            )
            return

        if isinstance(packet, PingPacket):
            await self._send(
                client.websocket,
                PongPacket(type="pong", clientSentAt=packet.clientSentAt),
            )
            return

        if isinstance(packet, ItemAddPacket):
            if not is_known_item_type(packet.itemType):
                await self._send_item_result(client, False, "add", "Unknown item type.")
                return
            item = self.item_service.default_item(client, packet.itemType)
            self.item_service.add_item(item)
            await self._broadcast_item(item)
            self._request_state_save()
            LOGGER.info(
                "item created by=%s item_id=%s type=%s title=%s x=%d y=%d",
                client.nickname,
                item.id,
                item.type,
                item.title,
                item.x,
                item.y,
            )
            item_text = f"{item.title} ({self._item_type_label(item)})"
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"{client.nickname} placed {item_text} at {item.x}, {item.y}.",
                    system=True,
                ),
                exclude=client.websocket,
            )
            await self._send_item_result(
                client,
                True,
                "add",
                f"You placed {item_text} at {item.x}, {item.y}.",
                item.id,
            )
            return

        if isinstance(packet, ItemPickupPacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "pickup", "Item not found.")
                return
            if item.carrierId and item.carrierId != client.id:
                await self._send_item_result(client, False, "pickup", "Item is already being carried.", item.id)
                return
            carried = self.item_service.find_carried_item(client.id)
            if carried and carried.id != item.id:
                await self._send_item_result(client, False, "pickup", "You are already carrying an item.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "pickup", "Item is not on your square.", item.id)
                return
            item.carrierId = client.id
            item.x = client.x
            item.y = client.y
            item.updatedAt = self.item_service.now_ms()
            await self._broadcast_item(item)
            self._request_state_save()
            await self._send_item_result(client, True, "pickup", f"Picked up {item.title}.", item.id)
            return

        if isinstance(packet, ItemDropPacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "drop", "Item not found.")
                return
            if item.carrierId != client.id:
                await self._send_item_result(client, False, "drop", "You are not carrying that item.", item.id)
                return
            if not self._is_in_bounds(packet.x, packet.y):
                await self._send_item_result(client, False, "drop", "Drop position is out of bounds.", item.id)
                return
            item.carrierId = None
            item.x = packet.x
            item.y = packet.y
            item.updatedAt = self.item_service.now_ms()
            await self._broadcast_item(item)
            self._request_state_save()
            await self._send_item_result(client, True, "drop", f"Dropped {item.title}.", item.id)
            return

        if isinstance(packet, ItemDeletePacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "delete", "Item not found.")
                return
            if item.carrierId and item.carrierId != client.id:
                await self._send_item_result(client, False, "delete", "Item is being carried by another user.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "delete", "Item is not on your square.", item.id)
                return
            LOGGER.info(
                "item deleted by=%s item_id=%s type=%s title=%s",
                client.nickname,
                item.id,
                item.type,
                item.title,
            )
            self._cancel_piano_playback(item.id)
            recording_state = self.piano_recording_state_by_item.pop(item.id, None)
            if recording_state is not None:
                auto_stop_task = recording_state.get("autoStopTask")
                if isinstance(auto_stop_task, asyncio.Task) and not auto_stop_task.done():
                    auto_stop_task.cancel()
            song_id = str(item.params.get("songId", "")).strip()
            if song_id and song_id in self.item_service.piano_songs:
                self.item_service.piano_songs.pop(song_id, None)
                self.item_service.save_piano_songs()
            self.item_service.remove_item(item.id)
            self.item_last_use_ms.pop(item.id, None)
            await self._broadcast(ItemRemovePacket(type="item_remove", itemId=item.id))
            self._request_state_save()
            await self._send_item_result(client, True, "delete", f"Deleted {item.title}.", item.id)
            return

        if isinstance(packet, ItemUsePacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "use", "Item not found.")
                return
            if item.carrierId not in (None, client.id):
                await self._send_item_result(client, False, "use", "Item is not available.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "use", "Item is not on your square.", item.id)
                return
            handler = get_item_type_handler(item.type)
            now_ms = self.item_service.now_ms()
            cooldown_ms = get_item_use_cooldown_ms(item.type)
            last_use_ms = self.item_last_use_ms.get(item.id)
            if last_use_ms is not None and now_ms - last_use_ms < cooldown_ms:
                remaining_ms = cooldown_ms - (now_ms - last_use_ms)
                remaining_seconds = max(0.1, round(remaining_ms / 1000, 1))
                await self._send_item_result(
                    client,
                    False,
                    "use",
                    f"{item.title} is on cooldown for {remaining_seconds:.1f} s.",
                    item.id,
                )
                return
            try:
                use_result = handler.use(item, client.nickname, self._format_clock_display_time)
            except ValueError as exc:
                await self._send_item_result(client, False, "use", str(exc), item.id)
                return

            if use_result.updated_params is not None:
                try:
                    item.params = handler.validate_update(item, {**item.params, **use_result.updated_params})
                except ValueError as exc:
                    await self._send_item_result(client, False, "use", str(exc), item.id)
                    return
                item.updatedAt = now_ms
                self._request_state_save()
                await self._broadcast_item(item)

            self.item_last_use_ms[item.id] = now_ms
            await self._broadcast(
                BroadcastChatMessagePacket(type="chat_message", message=use_result.others_message, system=True),
                exclude=client.websocket,
            )
            use_sound = self._resolve_item_use_sound(item)
            if use_sound:
                sound_x, sound_y = self._get_item_sound_source_position(item)
                await self._broadcast(
                    ItemUseSoundPacket(
                        type="item_use_sound",
                        itemId=item.id,
                        sound=use_sound,
                        x=sound_x,
                        y=sound_y,
                    )
                )
            if item.type == "piano":
                await self._send_piano_status(
                    client,
                    item_id=item.id,
                    event="use_mode_entered",
                    recording_state="idle",
                )
            await self._send_item_result(client, True, "use", use_result.self_message, item.id)
            if use_result.delayed_self_message is not None and use_result.delayed_others_message is not None:
                asyncio.create_task(
                    self._broadcast_wheel_result_after_delay(
                        client=client,
                        self_message=use_result.delayed_self_message,
                        others_message=use_result.delayed_others_message,
                    )
                )
            return

        if isinstance(packet, ItemSecondaryUsePacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "secondary_use", "Item not found.")
                return
            if item.carrierId not in (None, client.id):
                await self._send_item_result(client, False, "secondary_use", "Item is not available.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "secondary_use", "Item is not on your square.", item.id)
                return
            handler = get_item_type_handler(item.type)
            if handler.secondary_use is None:
                await self._send_item_result(
                    client,
                    False,
                    "secondary_use",
                    f"No secondary action for {item.title}.",
                    item.id,
                )
                return
            try:
                secondary_result = handler.secondary_use(item, client.nickname, self._format_clock_display_time)
            except ValueError as exc:
                await self._send_item_result(client, False, "secondary_use", str(exc), item.id)
                return
            if secondary_result.updated_params is not None:
                try:
                    item.params = handler.validate_update(item, {**item.params, **secondary_result.updated_params})
                except ValueError as exc:
                    await self._send_item_result(client, False, "secondary_use", str(exc), item.id)
                    return
                item.updatedAt = self.item_service.now_ms()
                item.version += 1
                self._request_state_save()
                await self._broadcast_item(item)
            if secondary_result.others_message.strip():
                await self._broadcast(
                    BroadcastChatMessagePacket(type="chat_message", message=secondary_result.others_message, system=True),
                    exclude=client.websocket,
                )
            await self._send_item_result(client, True, "secondary_use", secondary_result.self_message, item.id)
            return

        if isinstance(packet, ItemPianoNotePacket):
            item = self.items.get(packet.itemId)
            if not item or item.type != "piano":
                return
            if item.carrierId not in (None, client.id):
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                return
            active_keys = self.active_piano_keys_by_client.setdefault(client.id, set())
            if packet.on:
                if packet.keyId not in active_keys and len(active_keys) >= MAX_ACTIVE_PIANO_KEYS_PER_CLIENT:
                    return
                active_keys.add(packet.keyId)
            else:
                active_keys.discard(packet.keyId)
            recording_state = self.piano_recording_state_by_item.get(item.id)
            if recording_state and recording_state.get("ownerClientId") == client.id and recording_state.get("paused") is not True:
                elapsed_ms = max(0, min(PIANO_RECORDING_MAX_MS, self._recording_elapsed_ms(recording_state)))
                events = recording_state.get("events")
                if isinstance(events, list) and len(events) < PIANO_RECORDING_MAX_EVENTS:
                    instrument = str(item.params.get("instrument", "piano")).strip().lower()
                    voice_mode = str(item.params.get("voiceMode", "poly")).strip().lower()
                    if voice_mode not in {"poly", "mono"}:
                        voice_mode = "poly"
                    attack = int(item.params.get("attack", 15)) if isinstance(item.params.get("attack", 15), (int, float)) else 15
                    decay = int(item.params.get("decay", 45)) if isinstance(item.params.get("decay", 45), (int, float)) else 45
                    release = int(item.params.get("release", 35)) if isinstance(item.params.get("release", 35), (int, float)) else 35
                    brightness = int(item.params.get("brightness", 55)) if isinstance(item.params.get("brightness", 55), (int, float)) else 55
                    emit_range = int(item.params.get("emitRange", 15)) if isinstance(item.params.get("emitRange", 15), (int, float)) else 15
                    events.append(
                        {
                            "t": elapsed_ms,
                            "keyId": packet.keyId[:32],
                            "midi": packet.midi,
                            "on": packet.on,
                            "instrument": instrument,
                            "voiceMode": voice_mode,
                            "attack": max(0, min(100, attack)),
                            "decay": max(0, min(100, decay)),
                            "release": max(0, min(100, release)),
                            "brightness": max(0, min(100, brightness)),
                            "emitRange": max(5, min(20, emit_range)),
                        }
                    )
                if elapsed_ms >= PIANO_RECORDING_MAX_MS:
                    await self._finalize_piano_recording(item.id, notify_owner=True)
            await self._broadcast_item_piano_note(
                item,
                sender_id=client.id,
                key_id=packet.keyId,
                midi=packet.midi,
                on=packet.on,
                exclude=client.websocket,
            )
            return

        if isinstance(packet, ItemPianoRecordingPacket):
            item = self.items.get(packet.itemId)
            if not item or item.type != "piano":
                await self._send_item_result(client, False, "use", "Piano not found.")
                return
            if item.carrierId not in (None, client.id):
                await self._send_item_result(client, False, "use", "Piano is not available.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "use", "Piano is not on your square.", item.id)
                return

            if packet.action == "toggle_record":
                existing = self.piano_recording_state_by_item.get(item.id)
                if existing and existing.get("ownerClientId") != client.id:
                    await self._send_item_result(client, False, "use", "This piano is already recording.", item.id)
                    return
                if existing and existing.get("ownerClientId") == client.id:
                    if existing.get("paused") is True:
                        existing["paused"] = False
                        existing["lastResumeMonotonic"] = time.monotonic()
                        await self._send_piano_status(client, item_id=item.id, event="record_resumed", recording_state="recording")
                        await self._send_item_result(client, True, "use", "Recording resumed.", item.id)
                    else:
                        existing["elapsedMs"] = self._recording_elapsed_ms(existing)
                        existing["paused"] = True
                        existing.pop("lastResumeMonotonic", None)
                        await self._send_piano_status(client, item_id=item.id, event="record_paused", recording_state="paused")
                        await self._send_item_result(client, True, "use", "Recording paused.", item.id)
                    return
                self._cancel_piano_playback(item.id)
                recording_state = {
                    "ownerClientId": client.id,
                    "elapsedMs": 0,
                    "paused": False,
                    "lastResumeMonotonic": time.monotonic(),
                    "events": [],
                }
                self.piano_recording_state_by_item[item.id] = recording_state
                auto_stop_task = asyncio.create_task(self._auto_stop_piano_recording(item.id))
                recording_state["autoStopTask"] = auto_stop_task
                await self._send_piano_status(client, item_id=item.id, event="record_started", recording_state="recording")
                await self._send_item_result(client, True, "use", "Recording started.", item.id)
                return

            if packet.action == "stop_record":
                existing = self.piano_recording_state_by_item.get(item.id)
                if existing and existing.get("ownerClientId") != client.id:
                    await self._send_item_result(client, False, "use", "This piano is already recording.", item.id)
                    return
                if existing and existing.get("ownerClientId") == client.id:
                    await self._finalize_piano_recording(item.id, notify_owner=True)
                    return
                await self._send_piano_status(client, item_id=item.id, event="record_stopped", recording_state="idle")
                await self._send_item_result(client, True, "use", "Recording stopped.", item.id)
                return

            if packet.action == "playback":
                if item.id in self.piano_recording_state_by_item:
                    await self._send_item_result(client, False, "use", "Stop recording before playback.", item.id)
                    return
                song_id = str(item.params.get("songId", "")).strip()
                has_song = isinstance(self.item_service.piano_songs.get(song_id), dict) if song_id else False
                if not has_song:
                    await self._send_item_result(client, False, "use", "No recording saved on this piano.", item.id)
                    return
                self._cancel_piano_playback(item.id)
                playback_task = asyncio.create_task(self._start_piano_playback(item))
                self.piano_playback_tasks_by_item[item.id] = playback_task
                await self._send_piano_status(client, item_id=item.id, event="playback_started", recording_state="playback")
                await self._send_item_result(client, True, "use", "Playback started.", item.id)
                return

            if packet.action == "stop_playback":
                self._cancel_piano_playback(item.id)
                await self._send_piano_status(client, item_id=item.id, event="playback_stopped", recording_state="idle")
                await self._send_item_result(client, True, "use", "Playback stopped.", item.id)
                return
            return

        if isinstance(packet, ItemUpdatePacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "update", "Item not found.")
                return
            if item.carrierId not in (None, client.id):
                await self._send_item_result(client, False, "update", "Item is not available for editing.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "update", "Item is not on your square.", item.id)
                return
            if packet.title is not None:
                title = packet.title.strip()
                if not title:
                    await self._send_item_result(client, False, "update", "Title cannot be empty.", item.id)
                    return
                item.title = title[:80]
            if packet.params:
                next_params = {**item.params, **packet.params}
                handler = get_item_type_handler(item.type)
                try:
                    next_params = handler.validate_update(item, next_params)
                except ValueError as exc:
                    await self._send_item_result(client, False, "update", str(exc), item.id)
                    return
                item.params = next_params
            item.updatedAt = self.item_service.now_ms()
            item.version += 1
            await self._broadcast_item(item)
            self._request_state_save()
            await self._send_item_result(client, True, "update", f"Updated {item.title}.", item.id)
            return

        target = self._find_by_id(packet.targetId)
        if not target:
            PACKET_LOGGER.info("signal target not found sender=%s target=%s", client.id, packet.targetId)
            return

        await self._send(
            target.websocket,
            ForwardSignalPacket(
                type="signal",
                senderId=client.id,
                senderNickname=client.nickname,
                x=client.x,
                y=client.y,
                sdp=packet.sdp,
                ice=packet.ice,
            ),
        )

    async def _broadcast(self, packet: object, exclude: ServerConnection | None = None) -> None:
        """Broadcast one packet to all clients except an optional websocket."""

        recipients = [websocket for websocket in self.clients if websocket is not exclude]
        if not recipients:
            return
        await asyncio.gather(*(self._send(websocket, packet) for websocket in recipients))

    async def _send(self, websocket: ServerConnection, packet: object) -> None:
        """Send one packet to one websocket, swallowing per-client send failures."""

        try:
            if hasattr(packet, "model_dump"):
                data = packet.model_dump(exclude_none=True)
            else:
                data = packet
            await websocket.send(json.dumps(data))
        except Exception as exc:  # intentionally broad to keep server alive per client error
            LOGGER.debug("send failure: %s", exc)

    def _find_by_id(self, client_id: str) -> ClientConnection | None:
        """Resolve a client id to an active connection."""

        for client in self.clients.values():
            if client.id == client_id:
                return client
        return None

    @staticmethod
    def _build_ssl_context(cert: str | None, key: str | None) -> ssl.SSLContext | None:
        """Create TLS server context when cert/key are configured."""

        if not cert or not key:
            return None
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=Path(cert), keyfile=Path(key))
        return context


def run() -> None:
    """CLI entrypoint for running the signaling server process."""

    parser = argparse.ArgumentParser(description="chgrid signaling server")
    parser.add_argument("--config", default="config.toml")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--ssl-cert", default=None)
    parser.add_argument("--ssl-key", default=None)
    parser.add_argument("--allow-insecure-ws", action="store_true", default=None)
    parser.add_argument("--bootstrap-admin", action="store_true", default=False)
    args = parser.parse_args()

    config_path = Path(args.config) if args.config else None
    if config_path and not config_path.exists() and args.config == "config.toml":
        config_path = None
    config = load_config(config_path)

    host = args.host or config.server.bind_ip
    port = args.port or config.server.port
    allow_insecure_ws = config.network.allow_insecure_ws
    if args.allow_insecure_ws is True:
        allow_insecure_ws = True

    ssl_cert = args.ssl_cert if args.ssl_cert is not None else config.tls.cert_file or None
    ssl_key = args.ssl_key if args.ssl_key is not None else config.tls.key_file or None
    state_file_value = config.storage.state_file.strip()
    state_file: Path | None = None
    if state_file_value:
        base_dir = config_path.parent if config_path is not None else Path.cwd()
        state_file = Path(state_file_value)
        if not state_file.is_absolute():
            state_file = base_dir / state_file

    if not allow_insecure_ws and (not ssl_cert or not ssl_key):
        raise SystemExit(
            "TLS is required when insecure ws is disabled. Set tls.cert_file/tls.key_file in config.toml."
        )

    auth_secret = os.getenv("CHGRID_AUTH_SECRET", "").strip()
    if not auth_secret:
        raise SystemExit("CHGRID_AUTH_SECRET is required.")
    auth_db_value = config.auth.db_file.strip()
    if not auth_db_value:
        raise SystemExit("auth.db_file must not be empty.")
    auth_base_dir = config_path.parent if config_path is not None else Path.cwd()
    auth_db_path = Path(auth_db_value)
    if not auth_db_path.is_absolute():
        auth_db_path = auth_base_dir / auth_db_path
    auth_db_path.parent.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=getattr(logging, config.logging.level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if args.bootstrap_admin:
        auth_service = AuthService(
            db_path=auth_db_path,
            token_hash_secret=auth_secret,
            password_min_length=config.auth.password_min_length,
            password_max_length=config.auth.password_max_length,
            username_min_length=config.auth.username_min_length,
            username_max_length=config.auth.username_max_length,
        )
        try:
            print(
                "Username rules: "
                f"{auth_service.username_min_length}-{auth_service.username_max_length} chars, "
                "lowercase letters, numbers, underscore, dash."
            )
            print(
                "Password rules: "
                f"{auth_service.password_min_length}-{auth_service.password_max_length} chars."
            )
            while True:
                username = input("Admin username: ").strip()
                normalized_username = auth_service._normalize_username(username)
                try:
                    auth_service._validate_username(normalized_username)
                except AuthError as exc:
                    print(f"Invalid username: {exc}")
                    continue

                password = getpass("Admin password: ")
                try:
                    auth_service._validate_password(password)
                except AuthError as exc:
                    print(f"Invalid password: {exc}")
                    continue

                password_confirm = getpass("Re-enter admin password: ")
                if password != password_confirm:
                    print("Passwords do not match.")
                    continue

                email = input("Admin email (optional): ").strip() or None
                try:
                    created = auth_service.bootstrap_admin(normalized_username, password, email=email)
                    print(f"Admin created: {created.username}")
                    break
                except AuthError as exc:
                    print(f"Could not create admin: {exc}")
        finally:
            auth_service.close()
        return
    server = SignalingServer(
        host,
        port,
        ssl_cert,
        ssl_key,
        auth_db_path=auth_db_path,
        auth_token_hash_secret=auth_secret,
        password_min_length=config.auth.password_min_length,
        password_max_length=config.auth.password_max_length,
        username_min_length=config.auth.username_min_length,
        username_max_length=config.auth.username_max_length,
        max_message_size=config.network.max_message_bytes,
        state_file=state_file,
        grid_size=config.world.grid_size,
        state_save_debounce_ms=config.storage.state_save_debounce_ms,
        state_save_max_delay_ms=config.storage.state_save_max_delay_ms,
    )
    asyncio.run(server.start())
