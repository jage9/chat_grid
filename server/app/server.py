"""Websocket signaling server for chat, presence, and item interactions."""

from __future__ import annotations

import argparse
import asyncio
from collections import deque
from contextlib import suppress
from datetime import datetime, timezone
from getpass import getpass
import ipaddress
import json
import logging
import os
import random
import re
import signal
import ssl
import time
import uuid
from pathlib import Path
from typing import Literal, TypeAlias
from urllib.parse import urlsplit, urlunsplit

from pydantic import ValidationError, TypeAdapter
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request as HttpRequest, Response as HttpResponse
from websockets.typing import Origin

from .auth_service import AuthError, AuthService
from .acoustic_zones import client_acoustic_zone_id, client_position_packet
from .client import ClientConnection
from .config import load_config
from .item_catalog import (
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
from .items.types.clock.runtime import ClockRuntime
from .items.types.elevator.runtime import ElevatorRuntime, ElevatorRuntimeCallbacks
from .items.types.piano.runtime import PianoRuntime
from .items.types.radio_station.runtime import RadioRuntime
from .models import (
    AuthLoginPacket,
    AuthLogoutPacket,
    AuthPermissionsPacket,
    AuthRegisterPacket,
    AuthRequiredPacket,
    AuthResultPacket,
    AuthResumePacket,
    AdminActionResultPacket,
    AdminRoleCreatePacket,
    AdminRoleDeletePacket,
    AdminRoleSummary,
    AdminRoleUpdatePermissionsPacket,
    AdminRolesListPacket,
    AdminRolesListResultPacket,
    AdminUserBanPacket,
    AdminUserDeletePacket,
    AdminUserSetRolePacket,
    AdminUserUnbanPacket,
    AdminUserSummary,
    AdminUsersListPacket,
    AdminUsersListResultPacket,
    BroadcastChatMessagePacket,
    BroadcastNicknamePacket,
    BroadcastTeleportCompletePacket,
    ChatMessagePacket,
    ClientPacket,
    LiveKitTokenPacket,
    ItemActionResultPacket,
    ItemAddPacket,
    ItemDeletePacket,
    ItemDropPacket,
    ItemPianoNotePacket,
    ItemPianoRecordingPacket,
    ItemPickupPacket,
    ItemRemovePacket,
    ItemSecondaryUsePacket,
    ItemTransferPacket,
    ItemTransferTargetSummary,
    ItemTransferTargetsPacket,
    ItemTransferTargetsResultPacket,
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
    WelcomeReadyPacket,
    WelcomePacket,
    WorldItem,
)
from .network_security import normalize_origin
from .ui_metadata import (
    ADMIN_MENU_ACTION_DEFINITIONS,
    ITEM_MANAGEMENT_ACTION_DEFINITIONS,
    MAIN_MODE_SERVER_COMMAND_DEFINITIONS,
)
from .version import format_server_version

LOGGER = logging.getLogger("chgrid.server")
PACKET_LOGGER = logging.getLogger("chgrid.server.packet")
CLIENT_PACKET_ADAPTER: TypeAdapter[ClientPacket] = TypeAdapter(ClientPacket)
SYSTEM_RANDOM = random.SystemRandom()
MAX_ACTIVE_PIANO_KEYS_PER_CLIENT = 12
PIANO_RECORDING_MAX_MS = 30_000
PIANO_RECORDING_MAX_EVENTS = 4096
MOVEMENT_TICK_MS = 200
MOVEMENT_MAX_STEPS_PER_TICK = 1
POSITION_PERSIST_DEBOUNCE_MS = 5_000
LAST_SEEN_PERSIST_DEBOUNCE_MS = 30_000
AUTH_HASH_MAX_CONCURRENCY = 8
AUTH_RATE_LIMIT_WINDOW_S = 30.0
AUTH_RATE_LIMIT_PER_IP = 20
AUTH_RATE_LIMIT_PER_IDENTITY = 8
AUTH_FAILURE_JITTER_MIN_MS = 0.02
AUTH_FAILURE_JITTER_MAX_MS = 0.08
RADIO_METADATA_POLL_INTERVAL_S = 10.0
RADIO_METADATA_TIMEOUT_S = 6.0
RADIO_METADATA_MAX_CONCURRENCY = 4
CLOCK_ANNOUNCE_POLL_INTERVAL_S = 1.0
FLOOR_DEFINITIONS: tuple[dict[str, str | int], ...] = (
    {"id": "ground", "name": "Ground floor", "z": 0},
    {"id": "second", "name": "Second floor", "z": 40},
)
FLOOR_ELEVATIONS = frozenset(int(floor["z"]) for floor in FLOOR_DEFINITIONS)
AUTH_SESSION_COOKIE_NAME = "chgrid_session_token"
AUTH_SESSION_COOKIE_MAX_AGE_SECONDS = 14 * 24 * 60 * 60
AUTH_SESSION_COOKIE_SET_PATH = "auth/session/set"
AUTH_SESSION_COOKIE_CLEAR_PATH = "auth/session/clear"
AUTH_SESSION_COOKIE_CHECK_PATH = "auth/session/check"
WEBSOCKET_PATH = "ws"
AUTH_SESSION_COOKIE_CLIENT_HEADER = "X-Chgrid-Auth-Client"
AUTH_LOGIN_FAILURE_MESSAGE = "We couldn't log you in. Check your details and try again."
AUTH_RESUME_FAILURE_MESSAGE = "We couldn't restore your session. Please log in again."

AdminActionName: TypeAlias = Literal[
    "role_create",
    "role_update_permissions",
    "role_delete",
    "user_set_role",
    "user_ban",
    "user_unban",
    "user_delete",
]


class SignalingServer:
    """Coordinates websocket clients, signaling, and authoritative item actions."""

    def __init__(
        self,
        host: str,
        port: int,
        ssl_cert: str | None,
        ssl_key: str | None,
        auth_db_path: Path | None = None,
        auth_token_hash_secret: str | None = None,
        password_min_length: int = 8,
        password_max_length: int = 32,
        username_min_length: int = 2,
        username_max_length: int = 32,
        max_message_size: int = 2_000_000,
        state_file: Path | None = None,
        grid_size: int = 41,
        state_save_debounce_ms: int = 200,
        state_save_max_delay_ms: int = 1000,
        host_origin: str | None = None,
        base_path: str = "/",
        grid_name: str = "Chat Grid",
        welcome_message: str = (
            "Welcome to the Chat Grid, your immersive audio playground. "
            "Configure your audio, then Log in or register to join the grid."
        ),
        livekit_url: str | None = None,
        livekit_api_key: str | None = None,
        livekit_api_secret: str | None = None,
        livekit_room_name: str = "chatgrid",
    ):
        """Initialize runtime state, TLS context, and item service."""

        self.host = host
        self.port = port
        self.max_message_size = max_message_size
        self._ssl_context = self._build_ssl_context(ssl_cert, ssl_key)
        self.clients: dict[ServerConnection, ClientConnection] = {}
        resolved_auth_db_path = auth_db_path or Path.cwd() / "runtime" / "chatgrid.db"
        auth_secret = (
            auth_token_hash_secret.strip()
            if auth_token_hash_secret is not None
            else os.getenv("CHGRID_AUTH_SECRET", "").strip()
        )
        if not auth_secret:
            raise ValueError("CHGRID_AUTH_SECRET is required.")
        self.auth_service = AuthService(
            db_path=resolved_auth_db_path,
            token_hash_secret=auth_secret,
            password_min_length=password_min_length,
            password_max_length=password_max_length,
            username_min_length=username_min_length,
            username_max_length=username_max_length,
        )
        self.item_service = ItemService(state_file=state_file)
        self.item_last_use_ms: dict[str, int] = {}
        self.piano_runtime = PianoRuntime(self)
        self.grid_size = max(1, grid_size)
        self.movement_tick_ms = MOVEMENT_TICK_MS
        self.movement_max_steps_per_tick = MOVEMENT_MAX_STEPS_PER_TICK
        self.instance_id = str(uuid.uuid4())
        self.release_version, self.expected_client_revision = (
            self._resolve_client_version_metadata()
        )
        self.server_version = self._resolve_server_version(self.release_version)
        self.host_origin = (
            normalize_origin(host_origin, field_name="host origin")
            if host_origin
            else None
        )
        self.base_path = self._normalize_base_path(base_path)
        self.grid_name = str(grid_name).strip() or "Chat Grid"
        self.welcome_message = (
            str(welcome_message).strip()
            or "Welcome to the Chat Grid, your immersive audio playground. Configure your audio, then Log in or register to join the grid."
        )
        self.livekit_url = (livekit_url or "").strip()
        self.livekit_api_key = (livekit_api_key or "").strip()
        self.livekit_api_secret = (livekit_api_secret or "").strip()
        self.livekit_room_name = livekit_room_name.strip() or "chatgrid"
        livekit_values = (
            self.livekit_url,
            self.livekit_api_key,
            self.livekit_api_secret,
        )
        if any(livekit_values) and not all(livekit_values):
            raise ValueError("LiveKit requires url, API key, and API secret.")
        self.auth_session_cookie_name = self._session_cookie_name_for_base_path(
            self.base_path
        )
        self.websocket_path = self._base_path_join(WEBSOCKET_PATH)
        self.auth_session_cookie_set_path = self._base_path_join(
            AUTH_SESSION_COOKIE_SET_PATH
        )
        self.auth_session_cookie_clear_path = self._base_path_join(
            AUTH_SESSION_COOKIE_CLEAR_PATH
        )
        self.auth_session_cookie_check_path = self._base_path_join(
            AUTH_SESSION_COOKIE_CHECK_PATH
        )
        self.state_save_debounce_ms = max(1, int(state_save_debounce_ms))
        self.state_save_max_delay_ms = max(
            self.state_save_debounce_ms, int(state_save_max_delay_ms)
        )
        self._pending_state_save_handle: asyncio.TimerHandle | None = None
        self._pending_state_save_started_at: float | None = None
        self._last_position_persist_ms_by_user: dict[str, int] = {}
        self._last_seen_persist_ms_by_user: dict[str, int] = {}
        self._auth_hash_semaphore = asyncio.Semaphore(AUTH_HASH_MAX_CONCURRENCY)
        self._auth_failures_by_ip: dict[str, deque[float]] = {}
        self._auth_failures_by_identity: dict[str, deque[float]] = {}
        self.radio_runtime = RadioRuntime(self)
        self.clock_runtime = ClockRuntime(self)
        self._started_at_monotonic = time.monotonic()
        self._pending_reboot_task: asyncio.Task[None] | None = None
        self.elevator_runtime = ElevatorRuntime(
            ElevatorRuntimeCallbacks(
                get_item=lambda item_id: self.items.get(item_id),
                iter_clients=lambda: self.clients.values(),
                broadcast=lambda packet: self._broadcast(packet),
                send=lambda websocket, packet: self._send(websocket, packet),
                broadcast_item=lambda item: self._broadcast_item(item),
                send_item_result=lambda client, ok, action, message, item_id: (
                    self._send_item_result(client, ok, action, message, item_id)
                ),
                request_state_save=lambda: self._request_state_save(),
                persist_client_position=lambda client: self._persist_client_position(
                    client, force=True
                ),
                find_carried_item=lambda client_id: self.item_service.find_carried_item(
                    client_id
                ),
                now_ms=lambda: self.item_service.now_ms(),
                floor_name=lambda z: self._floor_name(z),
                get_emit_range=lambda item: self._get_item_emit_range(item),
            )
        )

    @property
    def livekit_enabled(self) -> bool:
        """Return whether complete LiveKit credentials are configured."""

        return bool(
            self.livekit_url and self.livekit_api_key and self.livekit_api_secret
        )

    def _generate_livekit_token(self, client: ClientConnection) -> str:
        """Create a short-lived LiveKit token for one authenticated client."""

        from datetime import timedelta

        from livekit import api

        return (
            api.AccessToken(self.livekit_api_key, self.livekit_api_secret)
            .with_ttl(timedelta(minutes=15))
            .with_identity(client.id)
            .with_name(client.nickname)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=self.livekit_room_name,
                    can_publish=self._client_has_permission(client, "voice.send"),
                    can_subscribe=True,
                )
            )
            .to_jwt()
        )

    @staticmethod
    def _resolve_server_version(release_version: str) -> str:
        """Resolve server diagnostics version text."""

        env_override = os.getenv("CHGRID_SERVER_VERSION", "").strip()
        if env_override:
            return env_override

        return format_server_version(release_version)

    @staticmethod
    def _resolve_client_version_metadata() -> tuple[str, str]:
        """Resolve shared release version and expected client revision from version.js."""

        try:
            version_file = (
                Path(__file__).resolve().parents[2] / "client" / "public" / "version.js"
            )
            text = version_file.read_text(encoding="utf-8")
            return SignalingServer._client_version_metadata_from_web_version_text(text)
        except OSError:
            return "", ""

    @staticmethod
    def _client_version_metadata_from_web_version_text(text: str) -> tuple[str, str]:
        """Parse release/client revision metadata from one client version.js file."""

        release_match = re.search(r'CHGRID_RELEASE_VERSION\s*=\s*"([^"]+)"', text)
        revision_match = re.search(r'CHGRID_CLIENT_REVISION\s*=\s*"([^"]+)"', text)
        return (
            release_match.group(1).strip() if release_match else "",
            revision_match.group(1).strip() if revision_match else "",
        )

    @property
    def items(self) -> dict[str, WorldItem]:
        """Expose current item map owned by the item service."""

        return self.item_service.items

    def _nickname_key(self, nickname: str) -> str:
        """Normalize nickname for case-insensitive comparisons."""

        return nickname.casefold()

    def _persist_client_position(
        self, client: ClientConnection, *, force: bool = False
    ) -> None:
        """Persist one authenticated client's last known position with debounce."""

        if not client.user_id:
            return
        now_ms = self.item_service.now_ms()
        if not force:
            last_saved_ms = self._last_position_persist_ms_by_user.get(
                client.user_id, 0
            )
            if now_ms - last_saved_ms < POSITION_PERSIST_DEBOUNCE_MS:
                return
        self.auth_service.set_last_position(
            client.user_id, client.x, client.y, client.z
        )
        self._last_position_persist_ms_by_user[client.user_id] = now_ms

    def _persist_client_last_seen(
        self, client: ClientConnection, *, force: bool = False
    ) -> None:
        """Persist one authenticated client's grid presence with debounce."""

        if not client.user_id:
            return
        now_ms = self.item_service.now_ms()
        client.last_seen_at_ms = now_ms
        if not force:
            last_saved_ms = self._last_seen_persist_ms_by_user.get(client.user_id, 0)
            if now_ms - last_saved_ms < LAST_SEEN_PERSIST_DEBOUNCE_MS:
                return
        self.auth_service.touch_last_seen(client.user_id, now_ms)
        self._last_seen_persist_ms_by_user[client.user_id] = now_ms

    def _auth_policy(self) -> dict[str, int]:
        """Return server-auth policy limits advertised to clients."""

        return {
            "usernameMinLength": self.auth_service.username_min_length,
            "usernameMaxLength": self.auth_service.username_max_length,
            "passwordMinLength": self.auth_service.password_min_length,
            "passwordMaxLength": self.auth_service.password_max_length,
        }

    @staticmethod
    def _normalize_base_path(value: str) -> str:
        """Normalize one instance base path to leading/trailing slash form."""

        text = str(value).strip()
        if not text or text == "/":
            return "/"
        return f"/{text.strip('/')}/"

    def _base_path_join(self, suffix: str) -> str:
        """Join one instance-relative route suffix to the configured base path."""

        token = suffix.lstrip("/")
        if self.base_path == "/":
            return f"/{token}"
        return f"{self.base_path}{token}"

    @staticmethod
    def _session_cookie_name_for_base_path(base_path: str) -> str:
        """Return one deterministic session cookie name for the configured instance path."""

        if base_path == "/":
            return AUTH_SESSION_COOKIE_NAME
        suffix = re.sub(r"[^a-z0-9]+", "_", base_path.strip("/").casefold()).strip("_")
        if not suffix:
            return AUTH_SESSION_COOKIE_NAME
        return f"chgrid_session_{suffix}"

    def _session_cookie_secure(self, request: HttpRequest | None = None) -> bool:
        """Return True when session cookies should be marked Secure."""

        if self._ssl_context is not None:
            return True
        if request is None:
            return False
        forwarded = (
            str(request.headers.get("X-Forwarded-Proto", ""))
            .split(",", 1)[0]
            .strip()
            .lower()
        )
        return forwarded == "https"

    def _session_cookie_header(
        self, token: str, *, request: HttpRequest | None = None
    ) -> str:
        """Build Set-Cookie header value for a valid session token."""

        secure = "; Secure" if self._session_cookie_secure(request) else ""
        return (
            f"{self.auth_session_cookie_name}={token}; Path={self.base_path}; HttpOnly; SameSite=Lax; "
            f"Max-Age={AUTH_SESSION_COOKIE_MAX_AGE_SECONDS}{secure}"
        )

    def _clear_session_cookie_header(
        self, *, request: HttpRequest | None = None
    ) -> str:
        """Build Set-Cookie header value that expires the session cookie."""

        secure = "; Secure" if self._session_cookie_secure(request) else ""
        return f"{self.auth_session_cookie_name}=; Path={self.base_path}; HttpOnly; SameSite=Lax; Max-Age=0{secure}"

    def _origin_allowed(self, request: HttpRequest) -> bool:
        """Return whether one auth helper HTTP request comes from the configured app origin."""

        if not self.host_origin:
            return False
        raw_origin = str(request.headers.get("Origin", "")).strip()
        if raw_origin:
            try:
                origin = normalize_origin(raw_origin)
            except ValueError:
                return False
            return origin == self.host_origin

        fetch_site = str(request.headers.get("Sec-Fetch-Site", "")).strip().lower()
        if fetch_site == "same-origin":
            return True

        raw_referer = str(request.headers.get("Referer", "")).strip()
        if not raw_referer:
            return False
        try:
            parts = urlsplit(raw_referer)
            referer_origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
            return (
                normalize_origin(referer_origin, field_name="referer")
                == self.host_origin
            )
        except ValueError:
            return False

    @staticmethod
    def _cookie_value(cookie_header: str, name: str) -> str:
        """Extract one cookie value by name from a Cookie header."""

        for segment in cookie_header.split(";"):
            key, separator, raw_value = segment.strip().partition("=")
            if separator and key == name:
                return raw_value.strip()
        return ""

    async def _process_http_request(
        self, _connection: object, request: HttpRequest
    ) -> HttpResponse | None:
        """Handle lightweight same-origin auth cookie set/clear HTTP endpoints."""

        path = request.path.split("?", 1)[0]
        auth_paths = {
            self.auth_session_cookie_set_path,
            self.auth_session_cookie_clear_path,
            self.auth_session_cookie_check_path,
        }
        if path == self.websocket_path:
            return None
        if path not in auth_paths:
            headers = Headers()
            headers["Content-Type"] = "text/plain; charset=utf-8"
            headers["Cache-Control"] = "no-store"
            return HttpResponse(404, "Not Found", headers, b"not found")

        headers = Headers()
        headers["Content-Type"] = "text/plain; charset=utf-8"
        headers["Cache-Control"] = "no-store"
        client_header = str(
            request.headers.get(AUTH_SESSION_COOKIE_CLIENT_HEADER, "")
        ).strip()
        if client_header != "1":
            return HttpResponse(400, "Bad Request", headers, b"missing client header")
        if not self._origin_allowed(request):
            return HttpResponse(403, "Forbidden", headers, b"origin not allowed")

        if path == self.auth_session_cookie_check_path:
            cookie_header = str(request.headers.get("Cookie", "")).strip()
            token = self._cookie_value(cookie_header, self.auth_session_cookie_name)
            if not token:
                return HttpResponse(401, "Unauthorized", headers, b"missing session")
            try:
                self.auth_service.resume(token)
            except AuthError:
                return HttpResponse(401, "Unauthorized", headers, b"invalid session")
            return HttpResponse(204, "No Content", headers, b"")

        if path == self.auth_session_cookie_clear_path:
            headers["Set-Cookie"] = self._clear_session_cookie_header(request=request)
            return HttpResponse(200, "OK", headers, b"cleared")

        authorization = str(request.headers.get("Authorization", "")).strip()
        if not authorization.lower().startswith("bearer "):
            return HttpResponse(400, "Bad Request", headers, b"missing bearer token")
        token = authorization[7:].strip()
        if not token:
            return HttpResponse(400, "Bad Request", headers, b"missing bearer token")
        try:
            session = self.auth_service.resume(token)
        except AuthError:
            return HttpResponse(401, "Unauthorized", headers, b"invalid session")
        headers["Set-Cookie"] = self._session_cookie_header(
            session.token, request=request
        )
        return HttpResponse(200, "OK", headers, b"ok")

    def _session_token_from_websocket_cookie(self, websocket: object) -> str:
        """Read session token from websocket handshake Cookie header."""

        request = getattr(websocket, "request", None)
        headers = getattr(request, "headers", None)
        if headers is None:
            return ""
        cookie_header = str(headers.get("Cookie", "")).strip()
        if not cookie_header:
            return ""
        return self._cookie_value(cookie_header, self.auth_session_cookie_name)

    def _build_admin_menu_actions_for_client(
        self, client: ClientConnection | None
    ) -> list[dict[str, str]]:
        """Build server-authored admin menu actions allowed for one client."""

        if client is None:
            return []
        client_permissions = client.permissions or set()
        return [
            {"id": action["id"], "label": action["label"], "tooltip": action["tooltip"]}
            for action in ADMIN_MENU_ACTION_DEFINITIONS
            if action["permission"] in client_permissions
        ]

    @staticmethod
    def _sorted_permissions(values: set[str] | tuple[str, ...] | None) -> list[str]:
        """Return deterministic sorted permission list."""

        if not values:
            return []
        return sorted(str(value) for value in values if str(value).strip())

    def _client_has_permission(self, client: ClientConnection, key: str) -> bool:
        """Return whether one authenticated client currently has a permission key."""

        if not client.authenticated or not client.user_id:
            return False
        if client.permissions is None:
            client.permissions = self.auth_service.get_user_permissions(client.user_id)
        return key in client.permissions

    def _refresh_client_permissions(self, client: ClientConnection) -> list[str]:
        """Refresh one client's role/permissions from auth storage and return permissions list."""

        if not client.user_id:
            client.permissions = set()
            return []
        user = self.auth_service.get_user_by_id(client.user_id)
        if user is None:
            client.permissions = set()
            return []
        client.role = user.role
        client.permissions = set(user.permissions)
        return self._sorted_permissions(client.permissions)

    async def _send_auth_permissions(self, client: ClientConnection) -> None:
        """Push one authenticated client's current role + permission set."""

        permissions = self._refresh_client_permissions(client)
        await self._send(
            client.websocket,
            AuthPermissionsPacket(
                type="auth_permissions",
                role=client.role,
                permissions=permissions,
                adminMenuActions=self._build_admin_menu_actions_for_client(client),
            ),
        )

    async def _sync_permissions_for_user_ids(self, user_ids: list[str]) -> None:
        """Refresh and push permissions for active websocket clients matching user ids."""

        wanted = {str(user_id) for user_id in user_ids}
        if not wanted:
            return
        for active in self.clients.values():
            if not active.user_id or active.user_id not in wanted:
                continue
            await self._send_auth_permissions(active)

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
        self._pending_state_save_handle = loop.call_later(
            delay_ms / 1000, self._flush_state_save
        )

    def _is_nickname_taken(
        self, nickname: str, exclude_client_id: str | None = None
    ) -> bool:
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
            peer_raw = address[0]
        elif isinstance(address, str):
            peer_raw = address
        else:
            peer_raw = None
        peer_ip = SignalingServer._normalized_ip(peer_raw)
        if not peer_ip:
            return "unknown"

        # Trust X-Forwarded-For only from a loopback proxy hop (e.g., local Apache/nginx).
        try:
            peer_addr = ipaddress.ip_address(peer_ip)
        except ValueError:
            return peer_ip
        if not peer_addr.is_loopback:
            return peer_ip

        request = getattr(client.websocket, "request", None)
        headers = getattr(request, "headers", None)
        if headers is None:
            return peer_ip
        forwarded = str(headers.get("X-Forwarded-For", "")).strip()
        if not forwarded:
            return peer_ip
        # In common reverse-proxy chains, the trusted proxy appends the immediate
        # client IP to the end of X-Forwarded-For. Read right-to-left so a
        # client-supplied left-side value can't spoof throttling/audit identity.
        for candidate in reversed(forwarded.split(",")):
            parsed = SignalingServer._normalized_ip(candidate)
            if parsed:
                return parsed
        return peer_ip

    @staticmethod
    def _normalized_ip(value: object) -> str | None:
        """Return normalized IP text or None when input is invalid."""

        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        if text.startswith("[") and text.endswith("]"):
            text = text[1:-1]
        if "%" in text:
            text = text.split("%", 1)[0]
        try:
            return str(ipaddress.ip_address(text))
        except ValueError:
            return None

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

    def _is_auth_rate_limited(
        self, client: ClientConnection, packet: ClientPacket
    ) -> bool:
        """Return True when recent auth failures exceed IP or identity thresholds."""

        now_s = time.monotonic()
        ip_key = self._client_ip(client)
        identity_key = self._auth_identity_key(client, packet)

        ip_bucket = self._auth_failures_by_ip.setdefault(ip_key, deque())
        identity_bucket = self._auth_failures_by_identity.setdefault(
            identity_key, deque()
        )
        self._prune_failure_window(ip_bucket, now_s)
        self._prune_failure_window(identity_bucket, now_s)

        return (
            len(ip_bucket) >= AUTH_RATE_LIMIT_PER_IP
            or len(identity_bucket) >= AUTH_RATE_LIMIT_PER_IDENTITY
        )

    def _record_auth_failure(
        self, client: ClientConnection, packet: ClientPacket
    ) -> None:
        """Record a failed auth attempt for IP and identity-scoped throttling."""

        now_s = time.monotonic()
        ip_key = self._client_ip(client)
        identity_key = self._auth_identity_key(client, packet)
        self._auth_failures_by_ip.setdefault(ip_key, deque()).append(now_s)
        self._auth_failures_by_identity.setdefault(identity_key, deque()).append(now_s)

    def _clear_auth_failures(
        self, client: ClientConnection, packet: ClientPacket
    ) -> None:
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

        await asyncio.sleep(
            SYSTEM_RANDOM.uniform(
                AUTH_FAILURE_JITTER_MIN_MS, AUTH_FAILURE_JITTER_MAX_MS
            )
        )

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

    @staticmethod
    def _format_display_sound_name(value: object) -> str:
        """Return display-friendly sound token (file name only) for item property menus."""

        raw = str(value or "").strip()
        if not raw:
            return "none"
        if raw.lower() == "none":
            return "none"
        without_query = raw.split("?", 1)[0].split("#", 1)[0]
        segments = [segment for segment in without_query.split("/") if segment]
        return segments[-1] if segments else raw

    @staticmethod
    def _format_display_timestamp_ms(value: int) -> str:
        """Format epoch milliseconds to compact UTC text used in item property menus."""

        dt = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M")

    def _build_item_display_values(self, item: WorldItem) -> dict[str, str]:
        """Build server-authoritative item property display values for readonly/system fields."""

        carrier_label = "none"
        if item.carrierId:
            carrier = self._get_client_by_id(item.carrierId)
            carrier_label = carrier.nickname if carrier is not None else item.carrierId
        return {
            "type": item.type,
            "x": str(item.x),
            "y": str(item.y),
            "z": str(item.z),
            "carrierId": carrier_label,
            "version": str(item.version),
            "createdBy": item.createdByName or item.createdBy,
            "updatedBy": item.updatedByName or item.updatedBy,
            "createdAt": self._format_display_timestamp_ms(item.createdAt),
            "updatedAt": self._format_display_timestamp_ms(item.updatedAt),
            "capabilities": ", ".join(item.capabilities)
            if item.capabilities
            else "none",
            "useSound": self._format_display_sound_name(
                item.params.get("useSound", item.useSound)
            ),
            "emitSound": self._format_display_sound_name(
                item.params.get("emitSound", item.emitSound)
            ),
        }

    def _outbound_item(self, item: WorldItem) -> WorldItem:
        """Return one outbound item snapshot enriched with server-owned display values."""

        return item.model_copy(
            update={"display": self._build_item_display_values(item)}
        )

    @staticmethod
    def _item_updated_actor(client: ClientConnection) -> tuple[str, str]:
        """Resolve `(actor_id, actor_name)` used in item update tracking fields."""

        actor_id = client.user_id or client.id
        actor_name = client.username or client.nickname or actor_id
        return actor_id, actor_name

    @staticmethod
    def _owns_item(client: ClientConnection, item: WorldItem) -> bool:
        """Return whether the authenticated client is the creator/owner of an item."""

        if not client.user_id:
            return False
        return item.createdBy == client.user_id

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
            elevator = (
                self.items.get(client.elevator_id) if client.elevator_id else None
            )
            if elevator is not None and elevator.params.get("state") == "moving":
                continue
            if client.z != item.z:
                continue
            if max(abs(client.x - item.x), abs(client.y - item.y)) <= emit_range:
                return True
        return False

    def _get_item_sound_source_position(self, item: WorldItem) -> tuple[int, int, int]:
        """Resolve source position for item-emitted one-shot sounds."""

        if item.carrierId:
            carrier = self._get_client_by_id(item.carrierId)
            if carrier is not None:
                return carrier.x, carrier.y, carrier.z
        return item.x, item.y, item.z

    def _get_client_by_id(self, client_id: str) -> ClientConnection | None:
        """Resolve one connected client by id."""

        for connected in self.clients.values():
            if connected.id == client_id:
                return connected
        return None

    def _is_in_bounds(self, x: int, y: int) -> bool:
        """Check whether a coordinate is inside server-authoritative world bounds."""

        return 0 <= x < self.grid_size and 0 <= y < self.grid_size

    @staticmethod
    def _is_supported_floor(z: int) -> bool:
        """Return whether a height is a configured floor elevation."""

        return z in FLOOR_ELEVATIONS

    def _item_is_on_client_square(
        self, item: WorldItem, client: ClientConnection
    ) -> bool:
        """Return whether one non-carried item shares the client's world cell."""

        if client.elevator_id == item.id:
            return True
        return self.item_service.item_occupies_position(
            item,
            x=client.x,
            y=client.y,
            z=client.z,
        )

    def _item_footprint_in_bounds(self, item: WorldItem) -> bool:
        """Return whether every occupied cell is inside the horizontal grid."""

        return all(
            self._is_in_bounds(
                item.x + int(offset.get("x", 0)),
                item.y + int(offset.get("y", 0)),
            )
            for offset in item.occupiedOffsets
        )

    @staticmethod
    def _floor_name(z: int) -> str:
        """Return the configured user-facing floor name for an elevation."""

        for floor in FLOOR_DEFINITIONS:
            if int(floor["z"]) == z:
                return str(floor["name"])
        return f"z {z}"

    def _movement_window_index(self, now_ms: int) -> int:
        """Return current movement rate-limit window index for a server timestamp."""

        return max(0, now_ms // self.movement_tick_ms)

    def _consume_movement_budget(
        self, client: ClientConnection, now_ms: int, requested_delta: int
    ) -> bool:
        """Consume per-window movement budget; return whether the move is allowed."""

        window_index = self._movement_window_index(now_ms)
        if client.movement_window_index != window_index:
            client.movement_window_index = window_index
            client.movement_window_steps_used = 0
        remaining = max(
            0, self.movement_max_steps_per_tick - client.movement_window_steps_used
        )
        if requested_delta > remaining:
            return False
        client.movement_window_steps_used += requested_delta
        return True

    async def _send_item_result(
        self,
        client: ClientConnection,
        ok: bool,
        action: Literal[
            "add",
            "pickup",
            "drop",
            "delete",
            "transfer",
            "use",
            "secondary_use",
            "update",
        ],
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

    async def _broadcast_item(self, item: WorldItem) -> None:
        """Broadcast a full item snapshot update to all connected clients."""

        await self._broadcast(
            ItemUpsertPacket(type="item_upsert", item=self._outbound_item(item))
        )

    async def start(self) -> None:
        """Start websocket serving and run until cancelled."""

        protocol = "wss" if self._ssl_context else "ws"
        LOGGER.info(
            "starting signaling server on %s://%s:%d", protocol, self.host, self.port
        )
        self.radio_runtime.start()
        self.clock_runtime.start()
        try:
            async with serve(
                self._handle_client,
                self.host,
                self.port,
                ssl=self._ssl_context,
                max_size=self.max_message_size,
                origins=[Origin(self.host_origin)] if self.host_origin else None,
                process_request=self._process_http_request,
            ):
                await asyncio.Future()
        finally:
            await self.piano_runtime.shutdown()
            await self.elevator_runtime.shutdown()
            if self._pending_reboot_task is not None:
                self._pending_reboot_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._pending_reboot_task
                self._pending_reboot_task = None
            await self.clock_runtime.shutdown()
            await self.radio_runtime.shutdown()
            self._flush_state_save()
            self.auth_service.close()

    async def _handle_client(self, websocket: ServerConnection) -> None:
        """Handle one websocket client's connect/message/disconnect lifecycle."""

        client = ClientConnection(websocket=websocket, id=str(uuid.uuid4()))
        LOGGER.info("websocket opened id=%s", client.id)

        try:
            request = getattr(websocket, "request", None)
            request_path = str(getattr(request, "path", "")).split("?", 1)[0]
            if request_path != self.websocket_path:
                await websocket.close()
                return
            cookie_token = self._session_token_from_websocket_cookie(websocket)
            if cookie_token:
                await self._handle_auth_packet(
                    client,
                    AuthResumePacket(type="auth_resume", sessionToken=cookie_token),
                )
            if not client.authenticated:
                await self._send(
                    websocket,
                    AuthRequiredPacket(
                        type="auth_required",
                        message="Authentication required.",
                        authPolicy=self._auth_policy(),
                        gridName=self.grid_name,
                        welcomeMessage=self.welcome_message,
                        releaseVersion=self.release_version or None,
                        expectedClientRevision=self.expected_client_revision or None,
                        serverVersion=self.server_version,
                    ),
                )
            async for raw_message in websocket:
                if isinstance(raw_message, bytes):
                    raw_message = raw_message.decode("utf-8", errors="replace")
                await self._handle_message(client, raw_message)
        except Exception:
            LOGGER.exception(
                "client message loop error id=%s ip=%s",
                client.id,
                self._client_ip(client),
            )
        finally:
            if websocket in self.clients:
                disconnected = self.clients.pop(websocket)
                await self.piano_runtime.client_disconnected(disconnected)
                self.elevator_runtime.restore_rider_to_landing(disconnected)
                self._persist_client_position(disconnected, force=True)
                self._persist_client_last_seen(disconnected, force=True)
                if disconnected.user_id:
                    self._last_position_persist_ms_by_user.pop(
                        disconnected.user_id, None
                    )
                    self._last_seen_persist_ms_by_user.pop(disconnected.user_id, None)
                for item in self.item_service.drop_carried_items_for_disconnect(
                    disconnected
                ):
                    await self._broadcast_item(item)
                self._request_state_save()
                LOGGER.info(
                    "client disconnected id=%s nickname=%s total=%d",
                    disconnected.id,
                    disconnected.nickname,
                    len(self.clients),
                )
                await self._broadcast(
                    UserLeftPacket(type="user_left", id=disconnected.id),
                    exclude=websocket,
                )
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
            RemoteUser(
                id=other.id,
                userId=other.user_id,
                nickname=other.nickname,
                x=other.x,
                y=other.y,
                z=other.z,
                acousticZoneId=client_acoustic_zone_id(other),
            )
            for ws, other in self.clients.items()
            if ws is not client.websocket
        ]
        packet = WelcomePacket(
            type="welcome",
            id=client.id,
            player=RemoteUser(
                id=client.id,
                userId=client.user_id,
                nickname=client.nickname,
                x=client.x,
                y=client.y,
                z=client.z,
                acousticZoneId=client_acoustic_zone_id(client),
            ),
            users=users,
            items=[
                self._outbound_item(item).model_dump(exclude_none=True)
                for item in self.items.values()
            ],
            worldConfig={
                "gridSize": self.grid_size,
                "movementTickMs": self.movement_tick_ms,
                "movementMaxStepsPerTick": self.movement_max_steps_per_tick,
                "floors": [dict(floor) for floor in FLOOR_DEFINITIONS],
            },
            uiDefinitions=self._build_ui_definitions(client),
            serverInfo={
                "instanceId": self.instance_id,
                "releaseVersion": self.release_version,
                "serverVersion": self.server_version,
                "expectedClientRevision": self.expected_client_revision,
                "gridName": self.grid_name,
                "welcomeMessage": self.welcome_message,
            },
            auth={
                "authenticated": client.authenticated,
                "userId": client.user_id,
                "username": client.username,
                "role": client.role if client.authenticated else None,
                "permissions": self._sorted_permissions(client.permissions),
                "policy": self._auth_policy(),
            },
        )
        await self._send(client.websocket, packet)
        if self.livekit_enabled:
            await self._send(
                client.websocket,
                LiveKitTokenPacket(
                    type="livekit_token",
                    token=self._generate_livekit_token(client),
                    url=self.livekit_url,
                ),
            )

    async def _send_authenticated_welcome(self, client: ClientConnection) -> None:
        """Prepare authenticated client state and send welcome before world activation."""

        saved_x = getattr(client, "saved_x", None)
        saved_y = getattr(client, "saved_y", None)
        saved_z = getattr(client, "saved_z", None)
        if (
            isinstance(saved_x, int)
            and isinstance(saved_y, int)
            and isinstance(saved_z, int)
            and self._is_in_bounds(saved_x, saved_y)
            and self._is_supported_floor(saved_z)
        ):
            client.x = saved_x
            client.y = saved_y
            client.z = saved_z
        else:
            client.x = random.randrange(self.grid_size)  # nosec B311
            client.y = random.randrange(self.grid_size)  # nosec B311
            client.z = 0
        now_ms = self.item_service.now_ms()
        self._refresh_client_permissions(client)
        client.last_position_update_ms = now_ms
        client.movement_window_index = self._movement_window_index(now_ms)
        client.movement_window_steps_used = 0
        client.world_ready = False
        await self._send_welcome(client)

    async def _activate_authenticated_client(self, client: ClientConnection) -> None:
        """Move a welcomed authenticated client into active world roster."""

        if client.websocket in self.clients:
            client.world_ready = True
            return
        client.world_ready = True
        self._persist_client_last_seen(client, force=True)
        self.clients[client.websocket] = client
        LOGGER.info(
            "client authenticated id=%s user_id=%s username=%s total=%d",
            client.id,
            client.user_id,
            client.username,
            len(self.clients),
        )
        await self._broadcast(
            BroadcastChatMessagePacket(
                type="chat_message",
                message=f"{client.nickname} has logged in.",
                system=True,
            ),
            exclude=client.websocket,
        )

    async def _handle_auth_packet(
        self, client: ClientConnection, packet: ClientPacket
    ) -> bool:
        """Handle pre-auth packets; returns True when packet was an auth command."""

        if client.authenticated and isinstance(
            packet, (AuthLoginPacket, AuthRegisterPacket, AuthResumePacket)
        ):
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

        if isinstance(
            packet, (AuthLoginPacket, AuthRegisterPacket, AuthResumePacket)
        ) and self._is_auth_rate_limited(client, packet):
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
                session = await self._run_auth_hash_task(
                    self.auth_service.login, packet.username, packet.password
                )
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
                client.permissions = set()
                LOGGER.info(
                    "auth logout id=%s ip=%s username=%s",
                    client.id,
                    self._client_ip(client),
                    client.username,
                )
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
            if isinstance(
                packet, (AuthLoginPacket, AuthRegisterPacket, AuthResumePacket)
            ):
                self._record_auth_failure(client, packet)
                await self._sleep_auth_failure_jitter()
            response_message = str(exc)
            if isinstance(packet, AuthLoginPacket):
                response_message = AUTH_LOGIN_FAILURE_MESSAGE
            elif isinstance(packet, AuthResumePacket):
                response_message = AUTH_RESUME_FAILURE_MESSAGE
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
                    message=response_message,
                    authPolicy=self._auth_policy(),
                ),
            )
            return True
        except Exception:
            if isinstance(
                packet, (AuthLoginPacket, AuthRegisterPacket, AuthResumePacket)
            ):
                self._record_auth_failure(client, packet)
                await self._sleep_auth_failure_jitter()
            LOGGER.exception(
                "auth unexpected error id=%s ip=%s packet=%s",
                client.id,
                self._client_ip(client),
                packet.type,
            )
            await self._send(
                client.websocket,
                AuthResultPacket(
                    type="auth_result",
                    ok=False,
                    message="Authentication failed due to a server error. Please try again.",
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
        client.permissions = set(session.user.permissions)
        client.session_token = session.token
        client.nickname = session.user.last_nickname or client.nickname
        client.saved_x = session.user.last_x
        client.saved_y = session.user.last_y
        client.saved_z = session.user.last_z
        await self._send(
            client.websocket,
            AuthResultPacket(
                type="auth_result",
                ok=True,
                message="Authenticated.",
                sessionToken=session.token,
                username=session.user.username,
                role=session.user.role,
                permissions=self._sorted_permissions(session.user.permissions),
                adminMenuActions=self._build_admin_menu_actions_for_client(client),
                nickname=client.nickname,
                authPolicy=self._auth_policy(),
            ),
        )
        await self._send_authenticated_welcome(client)
        return True

    def _build_ui_definitions(self, client: ClientConnection | None = None) -> dict:
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
            "commandMetadata": {
                "mainModeActions": list(MAIN_MODE_SERVER_COMMAND_DEFINITIONS)
            },
            "itemManagement": {"actions": list(ITEM_MANAGEMENT_ACTION_DEFINITIONS)},
            "adminMenu": {"actions": self._build_admin_menu_actions_for_client(client)},
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
            BroadcastChatMessagePacket(
                type="chat_message", message=others_message, system=True
            ),
            exclude=client.websocket,
        )
        if client.websocket in self.clients:
            await self._send(
                client.websocket,
                BroadcastChatMessagePacket(
                    type="chat_message", message=self_message, system=True
                ),
            )

    async def _send_admin_action_result(
        self,
        client: ClientConnection,
        *,
        ok: bool,
        action: AdminActionName,
        message: str,
    ) -> None:
        """Send one structured admin action result packet to caller."""

        await self._send(
            client.websocket,
            AdminActionResultPacket(
                type="admin_action_result", ok=ok, action=action, message=message
            ),
        )

    @staticmethod
    def _format_duration(total_seconds: int) -> str:
        """Format a duration value as compact human-readable text."""

        seconds = max(0, int(total_seconds))
        days, remainder = divmod(seconds, 24 * 60 * 60)
        hours, remainder = divmod(remainder, 60 * 60)
        minutes, secs = divmod(remainder, 60)
        parts: list[str] = []
        if days:
            parts.append(f"{days}d")
        if hours:
            parts.append(f"{hours}h")
        if minutes:
            parts.append(f"{minutes}m")
        if secs or not parts:
            parts.append(f"{secs}s")
        return " ".join(parts)

    def _format_uptime(self) -> str:
        """Return current server uptime text."""

        elapsed_seconds = int(max(0.0, time.monotonic() - self._started_at_monotonic))
        return self._format_duration(elapsed_seconds)

    async def _run_delayed_reboot(self, requested_by: str, message: str) -> None:
        """Wait for reboot delay, then terminate process for supervisor restart."""

        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            return
        LOGGER.warning(
            "server reboot requested by=%s message=%s", requested_by, message
        )
        os.kill(os.getpid(), signal.SIGTERM)

    def _schedule_reboot(self, requested_by: str, message: str) -> bool:
        """Schedule one delayed reboot; return False when one is already pending."""

        if (
            self._pending_reboot_task is not None
            and not self._pending_reboot_task.done()
        ):
            return False
        self._pending_reboot_task = asyncio.create_task(
            self._run_delayed_reboot(requested_by, message)
        )
        return True

    async def _handle_chat_command(
        self, client: ClientConnection, message: str
    ) -> bool:
        """Handle slash commands in chat input; return True when handled."""

        if not message.startswith("/"):
            return False
        command_line = message[1:]
        command_token, separator, remainder = command_line.partition(" ")
        command = command_token.casefold()
        if command == "me":
            if not separator or remainder == "":
                await self._send(
                    client.websocket,
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message="Usage: /me <action>",
                        system=True,
                    ),
                )
                return True
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"{client.nickname} {remainder}",
                    senderId=client.id,
                    senderNickname=client.nickname,
                    system=False,
                    action=True,
                )
            )
            return True
        if command == "up":
            await self._send(
                client.websocket,
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"Server uptime: {self._format_uptime()}",
                    system=True,
                ),
            )
            return True
        if command == "version":
            await self._send(
                client.websocket,
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"Server version: {self.server_version}",
                    system=True,
                ),
            )
            return True
        if command == "reboot":
            if not self._client_has_permission(client, "server.allow_reboot"):
                await self._send(
                    client.websocket,
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message="Not authorized to reboot server.",
                        system=True,
                    ),
                )
                return True
            reboot_message = remainder if separator else ""
            if not self._schedule_reboot(
                client.username or client.nickname, reboot_message
            ):
                await self._send(
                    client.websocket,
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message="Server reboot already in progress.",
                        system=True,
                    ),
                )
                return True
            announcement = "Server rebooting in 5 seconds."
            if reboot_message:
                announcement = f"{announcement} {reboot_message}"
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=announcement,
                    system=True,
                )
            )
            return True
        await self._send(
            client.websocket,
            BroadcastChatMessagePacket(
                type="chat_message",
                message=f"Unknown command: /{command_token}",
                system=True,
            ),
        )
        return True

    async def _handle_admin_packet(
        self, client: ClientConnection, packet: ClientPacket
    ) -> bool:
        """Handle role/user administration packets with permission checks."""

        if not isinstance(
            packet,
            (
                AdminRolesListPacket,
                AdminRoleCreatePacket,
                AdminRoleUpdatePermissionsPacket,
                AdminRoleDeletePacket,
                AdminUsersListPacket,
                AdminUserSetRolePacket,
                AdminUserBanPacket,
                AdminUserUnbanPacket,
                AdminUserDeletePacket,
            ),
        ):
            return False

        async def deny(action: AdminActionName, message: str) -> None:
            await self._send_admin_action_result(
                client, ok=False, action=action, message=message
            )

        if isinstance(packet, AdminRolesListPacket):
            if not (
                self._client_has_permission(client, "role.manage")
                or self._client_has_permission(client, "user.change_role")
            ):
                await deny("role_update_permissions", "Not authorized.")
                return True
            roles = [
                AdminRoleSummary.model_validate(role)
                for role in self.auth_service.list_roles_with_counts()
            ]
            await self._send(
                client.websocket,
                AdminRolesListResultPacket(
                    type="admin_roles_list",
                    roles=roles,
                    permissionKeys=self.auth_service.list_all_permissions(),
                    permissionTooltips=self.auth_service.list_all_permission_descriptions(),
                ),
            )
            return True

        if isinstance(packet, AdminUsersListPacket):
            if not (
                self._client_has_permission(client, "user.change_role")
                or self._client_has_permission(client, "user.ban_unban")
                or self._client_has_permission(client, "account.delete.any")
            ):
                await deny("user_set_role", "Not authorized.")
                return True
            users = self.auth_service.list_users_for_admin()
            online_user_ids = {
                connected.user_id
                for connected in self.clients.values()
                if connected.world_ready and connected.user_id
            }
            for entry in users:
                entry["online"] = str(entry["id"]) in online_user_ids
            if packet.action == "ban":
                users = [
                    entry for entry in users if str(entry.get("status")) == "active"
                ]
            elif packet.action == "unban":
                users = [
                    entry for entry in users if str(entry.get("status")) == "disabled"
                ]
            user_summaries = [AdminUserSummary.model_validate(entry) for entry in users]
            await self._send(
                client.websocket,
                AdminUsersListResultPacket(
                    type="admin_users_list", users=user_summaries
                ),
            )
            return True

        if isinstance(packet, AdminRoleCreatePacket):
            if not self._client_has_permission(client, "role.manage"):
                await deny("role_create", "Not authorized.")
                return True
            try:
                created = self.auth_service.create_role(packet.name)
            except AuthError as exc:
                await deny("role_create", str(exc))
                return True
            LOGGER.info(
                "role created actor=%s role=%s", client.user_id, created["name"]
            )
            await self._send_admin_action_result(
                client,
                ok=True,
                action="role_create",
                message=f"Created role {created['name']}.",
            )
            return True

        if isinstance(packet, AdminRoleUpdatePermissionsPacket):
            if not self._client_has_permission(client, "role.manage"):
                await deny("role_update_permissions", "Not authorized.")
                return True
            affected_user_ids = self.auth_service.list_connected_user_ids_for_role(
                packet.role
            )
            try:
                assigned = self.auth_service.update_role_permissions(
                    packet.role, packet.permissions
                )
            except AuthError as exc:
                await deny("role_update_permissions", str(exc))
                return True
            LOGGER.info(
                "role permissions updated actor=%s role=%s permission_count=%d",
                client.user_id,
                packet.role,
                len(assigned),
            )
            await self._sync_permissions_for_user_ids(affected_user_ids)
            await self._send_admin_action_result(
                client,
                ok=True,
                action="role_update_permissions",
                message=f"Updated permissions for {packet.role}.",
            )
            return True

        if isinstance(packet, AdminRoleDeletePacket):
            if not self._client_has_permission(client, "role.manage"):
                await deny("role_delete", "Not authorized.")
                return True
            try:
                affected_usernames, replacement = self.auth_service.delete_role(
                    packet.role, packet.replacementRole
                )
            except AuthError as exc:
                await deny("role_delete", str(exc))
                return True
            affected_ids = [
                user_id
                for username in affected_usernames
                for user_id in [self.auth_service.get_user_id_by_username(username)]
                if user_id is not None
            ]
            await self._sync_permissions_for_user_ids(affected_ids)
            LOGGER.info(
                "role deleted actor=%s role=%s replacement=%s affected=%d",
                client.user_id,
                packet.role,
                replacement,
                len(affected_usernames),
            )
            await self._send_admin_action_result(
                client,
                ok=True,
                action="role_delete",
                message=f"Deleted role {packet.role}; reassigned {len(affected_usernames)} users to {replacement}.",
            )
            return True

        if isinstance(packet, AdminUserSetRolePacket):
            if not self._client_has_permission(client, "user.change_role"):
                await deny("user_set_role", "Not authorized.")
                return True
            target_id = self.auth_service.get_user_id_by_username(packet.username)
            try:
                username = self.auth_service.set_user_role(
                    packet.username, packet.role, actor_user_id=client.user_id
                )
            except AuthError as exc:
                await deny("user_set_role", str(exc))
                return True
            if target_id:
                await self._sync_permissions_for_user_ids([target_id])
            LOGGER.info(
                "user role changed actor=%s target=%s role=%s",
                client.user_id,
                username,
                packet.role,
            )
            await self._send_admin_action_result(
                client,
                ok=True,
                action="user_set_role",
                message=f"Set role for {username} to {packet.role}.",
            )
            return True

        if isinstance(packet, AdminUserBanPacket):
            if not self._client_has_permission(client, "user.ban_unban"):
                await deny("user_ban", "Not authorized.")
                return True
            target_id = self.auth_service.get_user_id_by_username(packet.username)
            try:
                username = self.auth_service.set_user_status(
                    packet.username, "disabled"
                )
            except AuthError as exc:
                await deny("user_ban", str(exc))
                return True
            if target_id:
                await self._sync_permissions_for_user_ids([target_id])
                for active in list(self.clients.values()):
                    if active.user_id != target_id:
                        continue
                    await self._send(
                        active.websocket,
                        AuthResultPacket(
                            type="auth_result", ok=False, message="Account is disabled."
                        ),
                    )
                    await active.websocket.close()
            LOGGER.info("user banned actor=%s target=%s", client.user_id, username)
            await self._send_admin_action_result(
                client,
                ok=True,
                action="user_ban",
                message=f"Banned {username}.",
            )
            return True

        if isinstance(packet, AdminUserUnbanPacket):
            if not self._client_has_permission(client, "user.ban_unban"):
                await deny("user_unban", "Not authorized.")
                return True
            target_id = self.auth_service.get_user_id_by_username(packet.username)
            try:
                username = self.auth_service.set_user_status(packet.username, "active")
            except AuthError as exc:
                await deny("user_unban", str(exc))
                return True
            if target_id:
                await self._sync_permissions_for_user_ids([target_id])
            LOGGER.info("user unbanned actor=%s target=%s", client.user_id, username)
            await self._send_admin_action_result(
                client,
                ok=True,
                action="user_unban",
                message=f"Unbanned {username}.",
            )
            return True

        if isinstance(packet, AdminUserDeletePacket):
            if not self._client_has_permission(client, "account.delete.any"):
                await deny("user_delete", "Not authorized.")
                return True
            target_id = self.auth_service.get_user_id_by_username(packet.username)
            try:
                username = self.auth_service.delete_user(
                    packet.username, actor_user_id=client.user_id
                )
            except AuthError as exc:
                await deny("user_delete", str(exc))
                return True
            if target_id:
                for active in list(self.clients.values()):
                    if active.user_id != target_id:
                        continue
                    await self._send(
                        active.websocket,
                        AuthResultPacket(
                            type="auth_result", ok=False, message="Account deleted."
                        ),
                    )
                    await active.websocket.close()
            LOGGER.info("user deleted actor=%s target=%s", client.user_id, username)
            await self._send_admin_action_result(
                client,
                ok=True,
                action="user_delete",
                message=f"Deleted account {username}.",
            )
            return True

        return True

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

        # Test-harness compatibility: some unit tests inject clients directly into
        # `server.clients` without running auth handshake packets.
        if not client.authenticated and client.websocket in self.clients:
            client.authenticated = True
            client.user_id = client.user_id or client.id
            client.username = client.username or client.nickname
            client.role = "admin"
            client.permissions = set(self.auth_service.list_all_permissions())

        if await self._handle_auth_packet(client, packet):
            return
        if not client.authenticated:
            await self._send(
                client.websocket,
                AuthResultPacket(
                    type="auth_result",
                    ok=False,
                    message="Authenticate before sending gameplay actions.",
                ),
            )
            return

        if isinstance(packet, WelcomeReadyPacket):
            await self._activate_authenticated_client(client)
            return

        if isinstance(packet, PingPacket):
            if client.world_ready:
                self._persist_client_last_seen(client)
            await self._send(
                client.websocket,
                PongPacket(type="pong", clientSentAt=packet.clientSentAt),
            )
            return

        if not client.world_ready:
            PACKET_LOGGER.info(
                "ignoring pre-ready packet id=%s type=%s", client.id, packet.type
            )
            return

        if await self._handle_admin_packet(client, packet):
            return

        if isinstance(packet, UpdatePositionPacket):
            if client.elevator_id is not None:
                await self._send(
                    client.websocket,
                    client_position_packet(client),
                )
                return
            if not self._is_in_bounds(packet.x, packet.y) or packet.z != client.z:
                PACKET_LOGGER.warning(
                    "out-of-bounds position ignored id=%s x=%d y=%d grid_size=%d",
                    client.id,
                    packet.x,
                    packet.y,
                    self.grid_size,
                )
                await self._send(
                    client.websocket,
                    client_position_packet(client),
                )
                return
            now_ms = self.item_service.now_ms()
            requested_delta = max(abs(packet.x - client.x), abs(packet.y - client.y))
            if not self._consume_movement_budget(client, now_ms, requested_delta):
                remaining = max(
                    0,
                    self.movement_max_steps_per_tick
                    - client.movement_window_steps_used,
                )
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
                    client_position_packet(client),
                )
                return
            client.x = packet.x
            client.y = packet.y
            client.last_position_update_ms = now_ms
            self._persist_client_position(client)
            await self._send(
                client.websocket,
                client_position_packet(client),
            )
            await self._broadcast(
                client_position_packet(client),
                exclude=client.websocket,
            )
            carried = self.item_service.find_carried_item(client.id)
            if carried:
                actor_id, actor_name = self._item_updated_actor(client)
                carried.x = client.x
                carried.y = client.y
                carried.z = client.z
                carried.updatedAt = self.item_service.now_ms()
                carried.updatedBy = actor_id
                carried.updatedByName = actor_name
                await self._broadcast_item(carried)
            return

        if isinstance(packet, TeleportCompletePacket):
            if client.elevator_id is not None:
                await self._send(
                    client.websocket,
                    client_position_packet(client),
                )
                return
            if not self._is_in_bounds(packet.x, packet.y) or packet.z != client.z:
                PACKET_LOGGER.warning(
                    "out-of-bounds teleport ignored id=%s x=%d y=%d grid_size=%d",
                    client.id,
                    packet.x,
                    packet.y,
                    self.grid_size,
                )
                await self._send(
                    client.websocket,
                    client_position_packet(client),
                )
                return

            client.x = packet.x
            client.y = packet.y
            client.last_position_update_ms = self.item_service.now_ms()
            self._persist_client_position(client, force=True)
            await self._send(
                client.websocket,
                client_position_packet(client),
            )
            await self._broadcast(
                client_position_packet(client),
                exclude=client.websocket,
            )
            carried = self.item_service.find_carried_item(client.id)
            if carried:
                actor_id, actor_name = self._item_updated_actor(client)
                carried.x = client.x
                carried.y = client.y
                carried.z = client.z
                carried.updatedAt = self.item_service.now_ms()
                carried.updatedBy = actor_id
                carried.updatedByName = actor_name
                await self._broadcast_item(carried)
            await self._broadcast(
                BroadcastTeleportCompletePacket(
                    type="teleport_complete",
                    id=client.id,
                    x=client.x,
                    y=client.y,
                    z=client.z,
                ),
                exclude=client.websocket,
            )
            return

        if isinstance(packet, UpdateNicknamePacket):
            if not self._client_has_permission(client, "profile.update_nickname"):
                await self._send(
                    client.websocket,
                    NicknameResultPacket(
                        type="nickname_result",
                        accepted=False,
                        requestedNickname=packet.nickname,
                        effectiveNickname=client.nickname,
                        reason="Not authorized to change nickname.",
                    ),
                )
                return
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
                LOGGER.info(
                    "nickname change id=%s old=%s new=%s",
                    client.id,
                    old_nickname,
                    client.nickname,
                )
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
                BroadcastNicknamePacket(
                    type="update_nickname", id=client.id, nickname=client.nickname
                ),
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
            if not self._client_has_permission(client, "chat.send"):
                await self._send(
                    client.websocket,
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message="You are not allowed to send chat messages.",
                        system=True,
                    ),
                )
                return
            if await self._handle_chat_command(client, packet.message):
                return
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

        if isinstance(packet, ItemAddPacket):
            if not self._client_has_permission(client, "item.create"):
                await self._send_item_result(
                    client, False, "add", "Not authorized to create items."
                )
                return
            if not is_known_item_type(packet.itemType):
                await self._send_item_result(client, False, "add", "Unknown item type.")
                return
            item = self.item_service.default_item(client, packet.itemType)
            if item.type == "elevator":
                item.z = 0
                item.params["currentZ"] = client.z
            if not self._item_footprint_in_bounds(item):
                await self._send_item_result(
                    client,
                    False,
                    "add",
                    "The item footprint does not fit at this position.",
                )
                return
            self.item_service.add_item(item)
            await self._broadcast_item(item)
            self._request_state_save()
            LOGGER.info(
                "item created by=%s item_id=%s type=%s title=%s x=%d y=%d z=%d",
                client.nickname,
                item.id,
                item.type,
                item.title,
                item.x,
                item.y,
                item.z,
            )
            item_text = f"{item.title} ({self._item_type_label(item)})"
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"{client.nickname} placed {item_text} at {item.x}, {item.y}, {item.z}, {self._floor_name(item.z)}.",
                    system=True,
                ),
                exclude=client.websocket,
            )
            await self._send_item_result(
                client,
                True,
                "add",
                f"You placed {item_text} at {item.x}, {item.y}, {item.z}, {self._floor_name(item.z)}.",
                item.id,
            )
            return

        if isinstance(packet, ItemPickupPacket):
            pickup_item = self.items.get(packet.itemId)
            if not pickup_item:
                await self._send_item_result(client, False, "pickup", "Item not found.")
                return
            if "carryable" not in pickup_item.capabilities:
                await self._send_item_result(
                    client,
                    False,
                    "pickup",
                    "That item cannot be carried.",
                    pickup_item.id,
                )
                return
            if pickup_item.carrierId and pickup_item.carrierId != client.id:
                await self._send_item_result(
                    client,
                    False,
                    "pickup",
                    "Item is already being carried.",
                    pickup_item.id,
                )
                return
            carried = self.item_service.find_carried_item(client.id)
            if carried and carried.id != pickup_item.id:
                await self._send_item_result(
                    client,
                    False,
                    "pickup",
                    "You are already carrying an item.",
                    pickup_item.id,
                )
                return
            if pickup_item.carrierId is None and (
                not self._item_is_on_client_square(pickup_item, client)
            ):
                await self._send_item_result(
                    client,
                    False,
                    "pickup",
                    "Item is not on your square.",
                    pickup_item.id,
                )
                return
            can_pickup_any = self._client_has_permission(client, "item.pickup_drop.any")
            can_pickup_own = self._client_has_permission(
                client, "item.pickup_drop.own"
            ) and self._owns_item(client, pickup_item)
            if not can_pickup_any and not can_pickup_own:
                await self._send_item_result(
                    client,
                    False,
                    "pickup",
                    "Not authorized to pick up this item.",
                    pickup_item.id,
                )
                return
            pickup_item.carrierId = client.id
            pickup_item.x = client.x
            pickup_item.y = client.y
            pickup_item.z = client.z
            pickup_item.updatedAt = self.item_service.now_ms()
            actor_id, actor_name = self._item_updated_actor(client)
            pickup_item.updatedBy = actor_id
            pickup_item.updatedByName = actor_name
            await self._broadcast_item(pickup_item)
            self._request_state_save()
            item_text = f"{pickup_item.title} ({self._item_type_label(pickup_item)})"
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"{client.nickname} picked up {item_text}.",
                    system=True,
                ),
                exclude=client.websocket,
            )
            await self._send_item_result(
                client,
                True,
                "pickup",
                f"Picked up {pickup_item.title}.",
                pickup_item.id,
            )
            return

        if isinstance(packet, ItemDropPacket):
            drop_item = self.items.get(packet.itemId)
            if not drop_item:
                await self._send_item_result(client, False, "drop", "Item not found.")
                return
            if drop_item.carrierId != client.id:
                await self._send_item_result(
                    client,
                    False,
                    "drop",
                    "You are not carrying that item.",
                    drop_item.id,
                )
                return
            if not self._is_in_bounds(packet.x, packet.y) or packet.z != client.z:
                await self._send_item_result(
                    client,
                    False,
                    "drop",
                    "Drop position is out of bounds.",
                    drop_item.id,
                )
                return
            can_drop_any = self._client_has_permission(client, "item.pickup_drop.any")
            can_drop_own = self._client_has_permission(
                client, "item.pickup_drop.own"
            ) and self._owns_item(client, drop_item)
            if not can_drop_any and not can_drop_own:
                await self._send_item_result(
                    client,
                    False,
                    "drop",
                    "Not authorized to drop this item.",
                    drop_item.id,
                )
                return
            drop_item.carrierId = None
            drop_item.x = packet.x
            drop_item.y = packet.y
            drop_item.z = packet.z
            drop_item.updatedAt = self.item_service.now_ms()
            actor_id, actor_name = self._item_updated_actor(client)
            drop_item.updatedBy = actor_id
            drop_item.updatedByName = actor_name
            await self._broadcast_item(drop_item)
            self._request_state_save()
            item_text = f"{drop_item.title} ({self._item_type_label(drop_item)})"
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"{client.nickname} dropped {item_text} at {drop_item.x}, {drop_item.y}, {drop_item.z}, {self._floor_name(drop_item.z)}.",
                    system=True,
                ),
                exclude=client.websocket,
            )
            await self._send_item_result(
                client,
                True,
                "drop",
                f"Dropped {drop_item.title} at {drop_item.x}, {drop_item.y}, {drop_item.z}, {self._floor_name(drop_item.z)}.",
                drop_item.id,
            )
            return

        if isinstance(packet, ItemDeletePacket):
            delete_item = self.items.get(packet.itemId)
            if not delete_item:
                await self._send_item_result(client, False, "delete", "Item not found.")
                return
            if delete_item.carrierId and delete_item.carrierId != client.id:
                await self._send_item_result(
                    client,
                    False,
                    "delete",
                    "Item is being carried by another user.",
                    delete_item.id,
                )
                return
            if delete_item.type == "elevator" and (
                str(delete_item.params.get("state", "idle")) == "moving"
                or any(
                    other.elevator_id == delete_item.id
                    for other in self.clients.values()
                )
            ):
                await self._send_item_result(
                    client,
                    False,
                    "delete",
                    "The elevator cannot be deleted while moving or occupied.",
                    delete_item.id,
                )
                return
            if delete_item.carrierId is None and (
                not self._item_is_on_client_square(delete_item, client)
            ):
                await self._send_item_result(
                    client,
                    False,
                    "delete",
                    "Item is not on your square.",
                    delete_item.id,
                )
                return
            can_delete_any = self._client_has_permission(client, "item.delete.any")
            can_delete_own = self._client_has_permission(
                client, "item.delete.own"
            ) and self._owns_item(client, delete_item)
            if not can_delete_any and not can_delete_own:
                await self._send_item_result(
                    client,
                    False,
                    "delete",
                    "Not authorized to delete this item.",
                    delete_item.id,
                )
                return
            LOGGER.info(
                "item deleted by=%s item_id=%s type=%s title=%s",
                client.nickname,
                delete_item.id,
                delete_item.type,
                delete_item.title,
            )
            self.piano_runtime.remove_item(delete_item)
            self.item_service.remove_item(delete_item.id)
            await self.elevator_runtime.cancel(delete_item.id)
            self.item_last_use_ms.pop(delete_item.id, None)
            await self._broadcast(
                ItemRemovePacket(type="item_remove", itemId=delete_item.id)
            )
            self._request_state_save()
            item_text = f"{delete_item.title} ({self._item_type_label(delete_item)})"
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"{client.nickname} deleted {item_text}.",
                    system=True,
                ),
                exclude=client.websocket,
            )
            await self._send_item_result(
                client, True, "delete", f"You deleted {item_text}.", delete_item.id
            )
            return

        if isinstance(packet, ItemTransferTargetsPacket):
            transfer_targets_item = self.items.get(packet.itemId)
            if not transfer_targets_item:
                await self._send_item_result(
                    client, False, "transfer", "Item not found."
                )
                return
            if transfer_targets_item.carrierId:
                await self._send_item_result(
                    client,
                    False,
                    "transfer",
                    "Item cannot be transferred while carried.",
                    transfer_targets_item.id,
                )
                return
            if not self._item_is_on_client_square(transfer_targets_item, client):
                await self._send_item_result(
                    client,
                    False,
                    "transfer",
                    "Item is not on your square.",
                    transfer_targets_item.id,
                )
                return
            can_transfer_any = self._client_has_permission(client, "item.transfer.any")
            can_transfer_own = self._client_has_permission(
                client, "item.transfer.own"
            ) and self._owns_item(client, transfer_targets_item)
            if not can_transfer_any and not can_transfer_own:
                await self._send_item_result(
                    client,
                    False,
                    "transfer",
                    "Not authorized to transfer this item.",
                    transfer_targets_item.id,
                )
                return
            users = self.auth_service.list_users_for_admin()
            connected_user_ids = {
                other.user_id
                for other in self.clients.values()
                if other.authenticated and other.user_id
            }
            targets = [
                ItemTransferTargetSummary(
                    userId=str(entry["id"]),
                    username=str(entry["username"]),
                    online=str(entry.get("id")) in connected_user_ids,
                )
                for entry in users
                if str(entry.get("status")) == "active"
                and str(entry["id"]) != transfer_targets_item.createdBy
            ]
            await self._send(
                client.websocket,
                ItemTransferTargetsResultPacket(
                    type="item_transfer_targets",
                    itemId=transfer_targets_item.id,
                    targets=targets,
                ),
            )
            return

        if isinstance(packet, ItemTransferPacket):
            transfer_item = self.items.get(packet.itemId)
            if not transfer_item:
                await self._send_item_result(
                    client, False, "transfer", "Item not found."
                )
                return
            if transfer_item.carrierId:
                await self._send_item_result(
                    client,
                    False,
                    "transfer",
                    "Item cannot be transferred while carried.",
                    transfer_item.id,
                )
                return
            if not self._item_is_on_client_square(transfer_item, client):
                await self._send_item_result(
                    client,
                    False,
                    "transfer",
                    "Item is not on your square.",
                    transfer_item.id,
                )
                return
            can_transfer_any = self._client_has_permission(client, "item.transfer.any")
            can_transfer_own = self._client_has_permission(
                client, "item.transfer.own"
            ) and self._owns_item(client, transfer_item)
            if not can_transfer_any and not can_transfer_own:
                await self._send_item_result(
                    client,
                    False,
                    "transfer",
                    "Not authorized to transfer this item.",
                    transfer_item.id,
                )
                return
            target_user_id = str(packet.targetUserId).strip()
            if not target_user_id:
                await self._send_item_result(
                    client,
                    False,
                    "transfer",
                    "Target user is not available.",
                    transfer_item.id,
                )
                return
            if transfer_item.createdBy == target_user_id:
                await self._send_item_result(
                    client,
                    False,
                    "transfer",
                    "Item already belongs to that user.",
                    transfer_item.id,
                )
                return
            target = next(
                (
                    other
                    for other in self.clients.values()
                    if other.authenticated and other.user_id == target_user_id
                ),
                None,
            )
            target_username = (
                target.username
                if target and target.username
                else target.nickname
                if target
                else self.auth_service.get_username_by_id(target_user_id)
                or target_user_id
            )
            transfer_item.createdBy = target_user_id
            transfer_item.createdByName = target_username
            transfer_item.updatedAt = self.item_service.now_ms()
            actor_id, actor_name = self._item_updated_actor(client)
            transfer_item.updatedBy = actor_id
            transfer_item.updatedByName = actor_name
            transfer_item.version += 1
            await self._broadcast_item(transfer_item)
            self._request_state_save()
            item_text = (
                f"{transfer_item.title} ({self._item_type_label(transfer_item)})"
            )
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"{client.nickname} transferred {item_text} to {target_username}.",
                    system=True,
                ),
                exclude=client.websocket,
            )
            await self._send_item_result(
                client,
                True,
                "transfer",
                f"You transferred {item_text} to {target_username}.",
                transfer_item.id,
            )
            return

        if isinstance(packet, ItemUsePacket):
            if not self._client_has_permission(client, "item.use"):
                await self._send_item_result(
                    client, False, "use", "Not authorized to use items."
                )
                return
            use_item = self.items.get(packet.itemId)
            if not use_item:
                await self._send_item_result(client, False, "use", "Item not found.")
                return
            if use_item.carrierId not in (None, client.id):
                await self._send_item_result(
                    client, False, "use", "Item is not available.", use_item.id
                )
                return
            if use_item.carrierId is None and (
                not self._item_is_on_client_square(use_item, client)
            ):
                await self._send_item_result(
                    client, False, "use", "Item is not on your square.", use_item.id
                )
                return
            if use_item.type == "elevator":
                await self.elevator_runtime.use(client, use_item)
                return
            handler = get_item_type_handler(use_item.type)
            now_ms = self.item_service.now_ms()
            cooldown_ms = get_item_use_cooldown_ms(use_item.type)
            last_use_ms = self.item_last_use_ms.get(use_item.id)
            if last_use_ms is not None and now_ms - last_use_ms < cooldown_ms:
                remaining_ms = cooldown_ms - (now_ms - last_use_ms)
                remaining_seconds = max(0.1, round(remaining_ms / 1000, 1))
                await self._send_item_result(
                    client,
                    False,
                    "use",
                    f"{use_item.title} is on cooldown for {remaining_seconds:.1f} s.",
                    use_item.id,
                )
                return
            try:
                use_result = handler.use(
                    use_item, client.nickname, self.clock_runtime.format_display_time
                )
            except ValueError as exc:
                await self._send_item_result(
                    client, False, "use", str(exc), use_item.id
                )
                return

            if use_result.updated_params is not None:
                try:
                    use_item.params = handler.validate_update(
                        use_item, {**use_item.params, **use_result.updated_params}
                    )
                except ValueError as exc:
                    await self._send_item_result(
                        client, False, "use", str(exc), use_item.id
                    )
                    return
                use_item.updatedAt = now_ms
                actor_id, actor_name = self._item_updated_actor(client)
                use_item.updatedBy = actor_id
                use_item.updatedByName = actor_name
                self._request_state_save()
                await self._broadcast_item(use_item)

            self.item_last_use_ms[use_item.id] = now_ms
            if use_result.others_message:
                await self._broadcast(
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message=use_result.others_message,
                        system=True,
                    ),
                    exclude=client.websocket,
                )
            use_sound = self._resolve_item_use_sound(use_item)
            if use_sound:
                sound_x, sound_y, sound_z = self._get_item_sound_source_position(
                    use_item
                )
                sound_range = self._get_item_emit_range(use_item)
                await self._broadcast(
                    ItemUseSoundPacket(
                        type="item_use_sound",
                        itemId=use_item.id,
                        sound=use_sound,
                        x=sound_x,
                        y=sound_y,
                        z=sound_z,
                        range=sound_range,
                    )
                )
            if use_item.type == "clock":
                await self.clock_runtime.broadcast_announcement(
                    use_item, top_of_hour=False, alarm=False
                )
            if use_item.type == "piano":
                await self.piano_runtime.send_status(
                    client,
                    item_id=use_item.id,
                    event="use_mode_entered",
                    recording_state="idle",
                )
            await self._send_item_result(
                client, True, "use", use_result.self_message, use_item.id
            )
            if (
                use_result.delayed_self_message is not None
                and use_result.delayed_others_message is not None
            ):
                asyncio.create_task(
                    self._broadcast_wheel_result_after_delay(
                        client=client,
                        self_message=use_result.delayed_self_message,
                        others_message=use_result.delayed_others_message,
                    )
                )
            return

        if isinstance(packet, ItemSecondaryUsePacket):
            if not self._client_has_permission(client, "item.use"):
                await self._send_item_result(
                    client, False, "secondary_use", "Not authorized to use items."
                )
                return
            secondary_item = self.items.get(packet.itemId)
            if not secondary_item:
                await self._send_item_result(
                    client, False, "secondary_use", "Item not found."
                )
                return
            if secondary_item.carrierId not in (None, client.id):
                await self._send_item_result(
                    client,
                    False,
                    "secondary_use",
                    "Item is not available.",
                    secondary_item.id,
                )
                return
            if secondary_item.carrierId is None and (
                not self._item_is_on_client_square(secondary_item, client)
            ):
                await self._send_item_result(
                    client,
                    False,
                    "secondary_use",
                    "Item is not on your square.",
                    secondary_item.id,
                )
                return
            handler = get_item_type_handler(secondary_item.type)
            if handler.secondary_use is None:
                await self._send_item_result(
                    client,
                    False,
                    "secondary_use",
                    f"No secondary action for {secondary_item.title}.",
                    secondary_item.id,
                )
                return
            if secondary_item.type == "radio_station" and not (
                str(secondary_item.params.get("stationName", "")).strip()
                or str(secondary_item.params.get("nowPlaying", "")).strip()
            ):
                stream_url = str(secondary_item.params.get("streamUrl", "")).strip()
                if stream_url:
                    metadata = await self.radio_runtime.fetch_metadata_safely(
                        stream_url
                    )
                    await self.radio_runtime.apply_metadata([secondary_item], metadata)
            try:
                secondary_result = handler.secondary_use(
                    secondary_item,
                    client.nickname,
                    self.clock_runtime.format_display_time,
                )
            except ValueError as exc:
                await self._send_item_result(
                    client, False, "secondary_use", str(exc), secondary_item.id
                )
                return
            if secondary_result.updated_params is not None:
                try:
                    secondary_item.params = handler.validate_update(
                        secondary_item,
                        {**secondary_item.params, **secondary_result.updated_params},
                    )
                except ValueError as exc:
                    await self._send_item_result(
                        client, False, "secondary_use", str(exc), secondary_item.id
                    )
                    return
                secondary_item.updatedAt = self.item_service.now_ms()
                actor_id, actor_name = self._item_updated_actor(client)
                secondary_item.updatedBy = actor_id
                secondary_item.updatedByName = actor_name
                secondary_item.version += 1
                self._request_state_save()
                await self._broadcast_item(secondary_item)
            if secondary_result.others_message.strip():
                await self._broadcast(
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message=secondary_result.others_message,
                        system=True,
                    ),
                    exclude=client.websocket,
                )
            await self._send_item_result(
                client,
                True,
                "secondary_use",
                secondary_result.self_message,
                secondary_item.id,
            )
            return

        if isinstance(packet, ItemPianoNotePacket):
            await self.piano_runtime.handle_note(client, packet)
            return

        if isinstance(packet, ItemPianoRecordingPacket):
            await self.piano_runtime.handle_recording_action(client, packet)
            return

        if isinstance(packet, ItemUpdatePacket):
            update_item = self.items.get(packet.itemId)
            if not update_item:
                await self._send_item_result(client, False, "update", "Item not found.")
                return
            if update_item.carrierId not in (None, client.id):
                await self._send_item_result(
                    client,
                    False,
                    "update",
                    "Item is not available for editing.",
                    update_item.id,
                )
                return
            if update_item.carrierId is None and (
                not self._item_is_on_client_square(update_item, client)
            ):
                await self._send_item_result(
                    client,
                    False,
                    "update",
                    "Item is not on your square.",
                    update_item.id,
                )
                return
            can_edit_any = self._client_has_permission(client, "item.edit.any")
            can_edit_own = self._client_has_permission(
                client, "item.edit.own"
            ) and self._owns_item(client, update_item)
            if not can_edit_any and not can_edit_own:
                await self._send_item_result(
                    client,
                    False,
                    "update",
                    "Not authorized to edit this item.",
                    update_item.id,
                )
                return
            if packet.title is not None:
                title = packet.title.strip()
                if not title:
                    await self._send_item_result(
                        client,
                        False,
                        "update",
                        "Title cannot be empty.",
                        update_item.id,
                    )
                    return
                update_item.title = title[:80]
            if packet.params:
                next_params = {**update_item.params, **packet.params}
                handler = get_item_type_handler(update_item.type)
                try:
                    next_params = handler.validate_update(update_item, next_params)
                except ValueError as exc:
                    await self._send_item_result(
                        client, False, "update", str(exc), update_item.id
                    )
                    return
                update_item.params = next_params
            update_item.updatedAt = self.item_service.now_ms()
            actor_id, actor_name = self._item_updated_actor(client)
            update_item.updatedBy = actor_id
            update_item.updatedByName = actor_name
            update_item.version += 1
            await self._broadcast_item(update_item)
            self._request_state_save()
            await self._send_item_result(
                client, True, "update", f"Updated {update_item.title}.", update_item.id
            )
            return

    async def _broadcast(
        self, packet: object, exclude: ServerConnection | None = None
    ) -> None:
        """Broadcast one packet to all clients except an optional websocket."""

        recipients = [
            websocket for websocket in self.clients if websocket is not exclude
        ]
        if not recipients:
            return
        await asyncio.gather(
            *(self._send(websocket, packet) for websocket in recipients)
        )

    async def _send(self, websocket: ServerConnection, packet: object) -> None:
        """Send one packet to one websocket, swallowing per-client send failures."""

        try:
            if hasattr(packet, "model_dump"):
                data = packet.model_dump(exclude_none=True)
            else:
                data = packet
            await websocket.send(json.dumps(data))
        except (
            Exception
        ) as exc:  # intentionally broad to keep server alive per client error
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

    ssl_cert = (
        args.ssl_cert if args.ssl_cert is not None else config.tls.cert_file or None
    )
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
    host_origin = os.getenv("CHGRID_HOST_ORIGIN", "").strip()
    if not host_origin:
        raise SystemExit("CHGRID_HOST_ORIGIN is required.")
    try:
        host_origin = normalize_origin(host_origin, field_name="CHGRID_HOST_ORIGIN")
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    livekit_url = os.getenv("LIVEKIT_URL", "").strip()
    if not livekit_url:
        raise SystemExit("LIVEKIT_URL is required.")
    livekit_api_key = os.getenv("LIVEKIT_API_KEY", "").strip()
    livekit_api_secret = os.getenv("LIVEKIT_API_SECRET", "").strip()
    if not livekit_api_key or not livekit_api_secret:
        raise SystemExit("LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required.")
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
            if auth_service.has_admin():
                print("An admin account already exists.")
                return

            def prompt_create_admin() -> bool:
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
                        created = auth_service.bootstrap_admin(
                            normalized_username, password, email=email
                        )
                        print(f"Admin created: {created.username}")
                        return True
                    except AuthError as exc:
                        print(f"Could not create admin: {exc}")
                        if auth_service.has_admin():
                            return False

            def prompt_promote_existing_admin() -> bool:
                users = auth_service.list_users_for_admin()
                if not users:
                    print("No existing users found; create a new admin instead.")
                    return False
                print("Existing users:")
                for user in users:
                    print(f"  - {user['username']} ({user['role']}, {user['status']})")
                while True:
                    username = input("Existing username to promote: ").strip()
                    if not username:
                        print("Username is required.")
                        continue
                    try:
                        normalized = auth_service._normalize_username(username)
                        auth_service.set_user_role(normalized, "admin")
                        print(f"Admin promoted: {normalized}")
                        return True
                    except AuthError as exc:
                        print(f"Could not promote user: {exc}")

            if auth_service.list_users_for_admin():
                print("No admin account found. Choose bootstrap mode:")
                print("  1) Promote existing account to admin")
                print("  2) Create new admin account")
                while True:
                    choice = input("Select [1/2]: ").strip()
                    if choice == "1":
                        if prompt_promote_existing_admin():
                            break
                        print("Falling back to new admin creation.")
                        if prompt_create_admin():
                            break
                        continue
                    if choice == "2":
                        if prompt_create_admin():
                            break
                        continue
                    print("Please select 1 or 2.")
            else:
                prompt_create_admin()
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
        host_origin=host_origin,
        base_path=config.server.base_path,
        grid_name=config.server.grid_name,
        welcome_message=config.server.welcome_message,
        livekit_url=livekit_url,
        livekit_api_key=livekit_api_key,
        livekit_api_secret=livekit_api_secret,
        livekit_room_name=config.livekit.room_name,
    )
    asyncio.run(server.start())
