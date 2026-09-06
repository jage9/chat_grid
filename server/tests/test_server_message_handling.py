from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from time import monotonic
from typing import Sequence, TypeVar, cast
import uuid

import pytest
from websockets.asyncio.server import ServerConnection

from app.client import ClientConnection
from app.auth_service import AuthError
from app.models import (
    BasePacket,
    BroadcastChatMessagePacket,
    BroadcastNicknamePacket,
    BroadcastPositionPacket,
    BroadcastTeleportCompletePacket,
    AdminActionResultPacket,
    AdminUsersListResultPacket,
    AuthResultPacket,
    ItemActionResultPacket,
    ItemTransferTargetsResultPacket,
    LiveKitTokenPacket,
    PongPacket,
    WorldSoundPacket,
)
from app.server import (
    AUTH_LOGIN_FAILURE_MESSAGE,
    AUTH_RESUME_FAILURE_MESSAGE,
    SignalingServer,
)

PacketT = TypeVar("PacketT", bound=BasePacket)


def _fake_ws() -> ServerConnection:
    return cast(ServerConnection, object())


def _packet_types(payloads: list[object]) -> list[str]:
    return [getattr(packet, "type", "") for packet in payloads]


def _packets_of_type(
    payloads: Sequence[object], packet_type: type[PacketT]
) -> list[PacketT]:
    return [packet for packet in payloads if isinstance(packet, packet_type)]


def _last_packet_of_type(
    payloads: Sequence[object], packet_type: type[PacketT]
) -> PacketT:
    packets = _packets_of_type(payloads, packet_type)
    assert packets
    return packets[-1]


def _activate_client(
    client: ClientConnection,
    *,
    user_id: str | None = None,
    username: str | None = None,
    permissions: set[str] | None = None,
) -> ClientConnection:
    client.authenticated = True
    client.user_id = user_id or client.user_id or client.id
    client.username = username or client.username or client.nickname
    client.permissions = set(permissions or client.permissions or set())
    client.world_ready = True
    return client


def test_client_ip_prefers_forwarded_for_from_loopback_proxy() -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = cast(
        ServerConnection,
        SimpleNamespace(
            remote_address=("127.0.0.1", 12345),
            request=SimpleNamespace(
                headers={"X-Forwarded-For": "203.0.113.10, 198.51.100.25"}
            ),
        ),
    )
    client = ClientConnection(websocket=ws, id="u1", nickname="tester")
    assert server._client_ip(client) == "198.51.100.25"


def test_last_seen_persistence_is_debounced(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    server = SignalingServer(
        "127.0.0.1", 8765, None, None, auth_db_path=tmp_path / "auth.db"
    )
    client = _activate_client(
        ClientConnection(websocket=_fake_ws(), id="u1", nickname="tester"),
        user_id="1",
    )
    timestamps = iter((100_000, 110_000, 131_000))
    persisted: list[tuple[str, int]] = []
    monkeypatch.setattr(server.item_service, "now_ms", lambda: next(timestamps))
    monkeypatch.setattr(
        server.auth_service,
        "touch_last_seen",
        lambda user_id, seen_at_ms: persisted.append((user_id, seen_at_ms)),
    )

    server._persist_client_last_seen(client)
    server._persist_client_last_seen(client)
    server._persist_client_last_seen(client)

    assert persisted == [("1", 100_000), ("1", 131_000)]
    assert client.last_seen_at_ms == 131_000


def test_client_ip_ignores_forwarded_for_from_non_loopback_peer() -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = cast(
        ServerConnection,
        SimpleNamespace(
            remote_address=("203.0.113.20", 12345),
            request=SimpleNamespace(headers={"X-Forwarded-For": "198.51.100.25"}),
        ),
    )
    client = ClientConnection(websocket=ws, id="u1", nickname="tester")
    assert server._client_ip(client) == "203.0.113.20"


def test_resolve_client_version_metadata_reads_release_and_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    version_text = """
window.CHGRID_RELEASE_VERSION = "0.1.1";
window.CHGRID_CLIENT_REVISION = "R350";
""".strip()
    resolved = SignalingServer._client_version_metadata_from_web_version_text(
        version_text
    )

    assert resolved == ("0.1.1", "R350")


@pytest.mark.asyncio
async def test_update_position_rejects_out_of_bounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client

    broadcast_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client, json.dumps({"type": "update_position", "x": 200, "y": -5, "z": 0})
    )

    assert client.x == 5
    assert client.y == 6
    assert broadcast_payloads == []


@pytest.mark.asyncio
async def test_update_position_cannot_change_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Horizontal movement packets must preserve the server-owned floor."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6, z=0)
    )
    server.clients[ws] = client
    sent: list[object] = []

    async def fake_send(_websocket: ServerConnection, packet: object) -> None:
        sent.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client, json.dumps({"type": "update_position", "x": 6, "y": 6, "z": 40})
    )

    assert (client.x, client.y, client.z) == (5, 6, 0)
    correction = _last_packet_of_type(sent, BroadcastPositionPacket)
    assert (correction.x, correction.y, correction.z) == (5, 6, 0)


@pytest.mark.asyncio
async def test_welcome_includes_livekit_token_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer(
        "127.0.0.1",
        8765,
        None,
        None,
        livekit_url="wss://livekit.example.test",
        livekit_api_key="key",
        livekit_api_secret="test-livekit-secret-with-at-least-32-bytes",
    )
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="connection-1", nickname="tester"),
        permissions={"voice.send"},
    )
    sent: list[object] = []

    async def fake_send(_websocket: ServerConnection, packet: object) -> None:
        sent.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    await server._send_welcome(client)

    token_packet = _last_packet_of_type(sent, LiveKitTokenPacket)
    assert token_packet.url == "wss://livekit.example.test"
    assert token_packet.token


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("authenticated", "world_ready", "enabled", "expected_types"),
    [
        (True, True, True, ["livekit_token"]),
        (False, False, True, ["auth_result"]),
        (True, False, True, []),
        (True, True, False, []),
    ],
)
async def test_livekit_token_request(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    authenticated: bool,
    world_ready: bool,
    enabled: bool,
    expected_types: list[str],
) -> None:
    """Fresh voice credentials go only to an authenticated, ready requester."""

    server = SignalingServer(
        "127.0.0.1",
        8765,
        None,
        None,
        auth_db_path=tmp_path / "auth.db",
        livekit_url="wss://livekit.example.test" if enabled else None,
        livekit_api_key="key" if enabled else None,
        livekit_api_secret="test-livekit-secret-with-at-least-32-bytes"
        if enabled
        else None,
    )
    client = ClientConnection(websocket=_fake_ws(), id="requester", nickname="tester")
    if authenticated:
        _activate_client(client, permissions={"voice.send"})
        server.clients[client.websocket] = client
    client.world_ready = world_ready
    other = _activate_client(
        ClientConnection(websocket=_fake_ws(), id="other", nickname="other")
    )
    server.clients[other.websocket] = other
    deliveries: list[tuple[ServerConnection, object]] = []

    async def record_send(websocket: ServerConnection, packet: object) -> None:
        deliveries.append((websocket, packet))

    monkeypatch.setattr(server, "_send", record_send)
    await server._handle_message(client, json.dumps({"type": "livekit_token_request"}))

    assert _packet_types([packet for _, packet in deliveries]) == expected_types
    assert all(websocket is client.websocket for websocket, _ in deliveries)
    if authenticated and world_ready and enabled:
        token_packet = _last_packet_of_type(
            [packet for _, packet in deliveries], LiveKitTokenPacket
        )
        assert token_packet.url == server.livekit_url
        assert token_packet.token
        deliveries.clear()
        monkeypatch.setattr(server, "_generate_livekit_token", lambda _: "fresh-token")
        await server._handle_message(
            client, json.dumps({"type": "livekit_token_request"})
        )
        assert deliveries == [
            (
                client.websocket,
                LiveKitTokenPacket(
                    type="livekit_token", token="fresh-token", url=server.livekit_url
                ),
            )
        ]
    elif not authenticated:
        result = _last_packet_of_type(
            [packet for _, packet in deliveries], AuthResultPacket
        )
        assert result.ok is False


@pytest.mark.asyncio
async def test_radio_metadata_refresh_updates_station_and_title(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=10, y=10)
    server.clients[ws] = client

    radio = server.item_service.default_item(client, "radio_station")
    radio.params["streamUrl"] = "http://example.com/stream"
    radio.params["enabled"] = True
    radio.params["emitRange"] = 10
    radio.params["stationName"] = ""
    radio.params["nowPlaying"] = ""
    server.item_service.add_item(radio)

    async def fake_broadcast_item(item: object) -> None:
        return None

    def fake_fetch(url: str) -> tuple[str, str]:
        assert url == "http://example.com/stream"
        return ("Test Station", "Test Song")

    monkeypatch.setattr(server.item_runtime, "broadcast_item", fake_broadcast_item)
    monkeypatch.setattr(server.item_runtime.radio, "_fetch_stream_metadata", fake_fetch)

    await server.item_runtime.radio.refresh_once()

    assert radio.params["stationName"] == "Test Station"
    assert radio.params["nowPlaying"] == "Test Song"


@pytest.mark.asyncio
async def test_radio_metadata_refresh_skips_when_no_listener_in_range(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=0, y=0)
    server.clients[ws] = client

    radio = server.item_service.default_item(client, "radio_station")
    radio.x = 30
    radio.y = 30
    radio.params["streamUrl"] = "http://example.com/stream"
    radio.params["enabled"] = True
    radio.params["emitRange"] = 5
    server.item_service.add_item(radio)

    called = False

    def fake_fetch(url: str) -> tuple[str, str]:
        nonlocal called
        called = True
        return ("X", "Y")

    monkeypatch.setattr(server.item_runtime.radio, "_fetch_stream_metadata", fake_fetch)

    await server.item_runtime.radio.refresh_once()

    assert called is False


@pytest.mark.asyncio
async def test_radio_metadata_refresh_continues_after_one_stream_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=10, y=10)
    server.clients[ws] = client

    failed_radio = server.item_service.default_item(client, "radio_station")
    failed_radio.params["streamUrl"] = "https://failed.example/stream"
    failed_radio.params["enabled"] = True
    failed_radio.params["emitRange"] = 10
    failed_radio.params["stationName"] = "Previous Station"
    failed_radio.params["nowPlaying"] = "Previous Song"
    server.item_service.add_item(failed_radio)

    working_radio = server.item_service.default_item(client, "radio_station")
    working_radio.params["streamUrl"] = "https://working.example/stream"
    working_radio.params["enabled"] = True
    working_radio.params["emitRange"] = 10
    server.item_service.add_item(working_radio)

    async def fake_broadcast_item(item: object) -> None:
        return None

    def fake_fetch(url: str) -> tuple[str, str]:
        if url == "https://failed.example/stream":
            raise RuntimeError("upstream disconnected")
        return ("Working Station", "Working Song")

    monkeypatch.setattr(server.item_runtime, "broadcast_item", fake_broadcast_item)
    monkeypatch.setattr(server.item_runtime.radio, "_fetch_stream_metadata", fake_fetch)

    await server.item_runtime.radio.refresh_once()

    assert working_radio.params["stationName"] == "Working Station"
    assert working_radio.params["nowPlaying"] == "Working Song"
    assert failed_radio.params["stationName"] == "Previous Station"
    assert failed_radio.params["nowPlaying"] == "Previous Song"


@pytest.mark.asyncio
async def test_item_secondary_use_radio_reports_now_playing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5),
        permissions={"item.use"},
    )
    server.clients[ws] = client

    radio = server.item_service.default_item(client, "radio_station")
    radio.x = 5
    radio.y = 5
    radio.params["enabled"] = True
    radio.params["stationName"] = "Station X"
    radio.params["nowPlaying"] = "Song Y"
    server.item_service.add_item(radio)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client, json.dumps({"type": "item_secondary_use", "itemId": radio.id})
    )

    results = _packets_of_type(send_payloads, ItemActionResultPacket)
    assert results
    assert results[-1].ok is True
    assert results[-1].action == "secondary_use"
    assert "Playing Song Y from Station X." in results[-1].message
    assert broadcast_payloads == []


@pytest.mark.asyncio
async def test_item_secondary_use_radio_fetches_missing_now_playing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5),
        permissions={"item.use"},
    )
    server.clients[ws] = client

    radio = server.item_service.default_item(client, "radio_station")
    radio.x = 5
    radio.y = 5
    radio.params["streamUrl"] = "https://radio.example/stream"
    radio.params["enabled"] = True
    radio.params["stationName"] = ""
    radio.params["nowPlaying"] = ""
    server.item_service.add_item(radio)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        return None

    def fake_fetch(url: str) -> tuple[str, str]:
        assert url == "https://radio.example/stream"
        return ("Station X", "Song Y")

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_runtime.radio, "_fetch_stream_metadata", fake_fetch)

    await server._handle_message(
        client, json.dumps({"type": "item_secondary_use", "itemId": radio.id})
    )

    result = _last_packet_of_type(send_payloads, ItemActionResultPacket)
    assert result.ok is True
    assert result.message == "Playing Song Y from Station X."


@pytest.mark.asyncio
async def test_item_secondary_use_missing_handler_returns_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5),
        permissions={"item.use"},
    )
    server.clients[ws] = client

    dice = server.item_service.default_item(client, "dice")
    dice.x = 5
    dice.y = 5
    server.item_service.add_item(dice)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client, json.dumps({"type": "item_secondary_use", "itemId": dice.id})
    )

    results = _packets_of_type(send_payloads, ItemActionResultPacket)
    assert results
    assert results[-1].ok is False
    assert results[-1].action == "secondary_use"
    assert "No secondary action" in results[-1].message


def test_clock_alarm_announcement_sequence_shape() -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    params = {"timeZone": "America/Detroit", "use24Hour": False}

    alarm_sounds = server.item_runtime.clock._build_clock_announcement_sounds(
        params, top_of_hour=False, alarm=True
    )
    assert alarm_sounds
    assert alarm_sounds[0] == "/sounds/clock/el640/announcement.ogg"
    assert alarm_sounds[-1] == "/sounds/clock/el640/alarm.ogg"

    top_of_hour_sounds = server.item_runtime.clock._build_clock_announcement_sounds(
        params, top_of_hour=True, alarm=False
    )
    assert top_of_hour_sounds
    assert top_of_hour_sounds[0] == "/sounds/clock/el640/hour1.ogg"
    assert top_of_hour_sounds[-1] == "/sounds/clock/el640/hour2.ogg"


@pytest.mark.asyncio
async def test_auth_login_uses_hash_offload(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    username = f"alpha_{uuid.uuid4().hex[:8]}"
    server.auth_service.register(username, "password99")
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester")

    send_payloads: list[object] = []
    offload_calls: list[str] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        return None

    async def fake_run_auth_hash_task(func, /, *args, **kwargs):
        offload_calls.append(getattr(func, "__name__", "unknown"))
        return func(*args, **kwargs)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_run_auth_hash_task", fake_run_auth_hash_task)

    await server._handle_message(
        client,
        json.dumps(
            {"type": "auth_login", "username": username, "password": "password99"}
        ),
    )

    assert "login" in offload_calls
    auth_results = _packets_of_type(send_payloads, AuthResultPacket)
    assert auth_results
    assert auth_results[-1].ok is True


@pytest.mark.asyncio
async def test_auth_rate_limit_blocks_before_hash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester")

    send_payloads: list[object] = []
    called_login = False

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    def fake_login(username: str, password: str):  # pragma: no cover - should never run
        nonlocal called_login
        called_login = True
        raise RuntimeError("unexpected login call")

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_sleep_auth_failure_jitter", lambda: asyncio.sleep(0))
    monkeypatch.setattr(server.auth_service, "login", fake_login)
    monkeypatch.setattr(server, "_is_auth_rate_limited", lambda _client, _packet: True)

    await server._handle_message(
        client,
        json.dumps(
            {"type": "auth_login", "username": "alpha", "password": "wrongpass"}
        ),
    )

    assert called_login is False
    assert send_payloads
    auth_result = _last_packet_of_type(send_payloads, AuthResultPacket)
    assert auth_result.ok is False
    assert "too many" in auth_result.message.lower()


@pytest.mark.asyncio
async def test_auth_login_failure_message_is_generic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester")
    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_sleep_auth_failure_jitter", lambda: asyncio.sleep(0))

    def fake_login(_username: str, _password: str):
        raise AuthError("Account is disabled.")

    monkeypatch.setattr(server.auth_service, "login", fake_login)

    await server._handle_message(
        client,
        json.dumps(
            {"type": "auth_login", "username": "alpha", "password": "wrongpass"}
        ),
    )

    auth_results = _packets_of_type(send_payloads, AuthResultPacket)
    assert auth_results
    assert auth_results[-1].ok is False
    assert auth_results[-1].message == AUTH_LOGIN_FAILURE_MESSAGE


@pytest.mark.asyncio
async def test_auth_login_defers_activation_until_welcome_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    username = f"ready_{uuid.uuid4().hex[:8]}"
    server.auth_service.register(username, "password99")
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester")

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client,
        json.dumps(
            {"type": "auth_login", "username": username, "password": "password99"}
        ),
    )

    assert client.authenticated is True
    assert client.world_ready is False
    assert ws not in server.clients
    assert any(getattr(packet, "type", "") == "welcome" for packet in send_payloads)
    assert not any(
        "has logged in" in getattr(packet, "message", "")
        for packet in broadcast_payloads
    )

    await server._handle_message(client, json.dumps({"type": "welcome_ready"}))

    assert client.world_ready is True
    assert server.clients.get(ws) is client
    assert _packet_types(broadcast_payloads)[-3:] == [
        "update_position",
        "update_nickname",
        "chat_message",
    ]
    presence = _last_packet_of_type(broadcast_payloads, BroadcastPositionPacket)
    assert (presence.id, presence.x, presence.y, presence.z) == (
        client.id,
        client.x,
        client.y,
        client.z,
    )
    nickname = _last_packet_of_type(broadcast_payloads, BroadcastNicknamePacket)
    assert nickname.id == client.id
    assert nickname.nickname == client.nickname
    assert any(
        "has logged in" in getattr(packet, "message", "")
        for packet in broadcast_payloads
    )


@pytest.mark.asyncio
async def test_ping_works_before_welcome_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    username = f"ping_{uuid.uuid4().hex[:8]}"
    server.auth_service.register(username, "password99")
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester")

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client,
        json.dumps(
            {"type": "auth_login", "username": username, "password": "password99"}
        ),
    )
    assert client.world_ready is False

    await server._handle_message(
        client, json.dumps({"type": "ping", "clientSentAt": -1})
    )

    pong_packets = _packets_of_type(send_payloads, PongPacket)
    assert pong_packets
    assert pong_packets[-1].clientSentAt == -1


@pytest.mark.asyncio
async def test_auth_resume_failure_message_is_generic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester")
    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_sleep_auth_failure_jitter", lambda: asyncio.sleep(0))

    def fake_resume(_token: str):
        raise AuthError("Session has expired.")

    monkeypatch.setattr(server.auth_service, "resume", fake_resume)

    await server._handle_message(
        client, json.dumps({"type": "auth_resume", "sessionToken": "expired-token"})
    )

    auth_results = _packets_of_type(send_payloads, AuthResultPacket)
    assert auth_results
    assert auth_results[-1].ok is False
    assert auth_results[-1].message == AUTH_RESUME_FAILURE_MESSAGE


@pytest.mark.asyncio
async def test_item_drop_rejects_out_of_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6),
        permissions={"item.pickup_drop.any"},
    )
    server.clients[ws] = client
    item = server.item_service.default_item(client, "dice")
    item.carrierId = client.id
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_drop", "itemId": item.id, "x": 999, "y": 999, "z": 0}
        ),
    )

    assert item.carrierId == client.id
    item_result = _last_packet_of_type(send_payloads, ItemActionResultPacket)
    assert item_result.ok is False
    assert "out of bounds" in item_result.message.lower()


@pytest.mark.asyncio
async def test_item_transfer_updates_item_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    owner_ws = _fake_ws()
    target_ws = _fake_ws()
    owner = ClientConnection(
        websocket=owner_ws,
        id="u1",
        nickname="owner",
        authenticated=True,
        user_id="1",
        username="owner_user",
        permissions={"item.transfer.own"},
        x=5,
        y=6,
    )
    _activate_client(owner)
    target = ClientConnection(
        websocket=target_ws,
        id="u2",
        nickname="target",
        authenticated=True,
        user_id="2",
        username="target_user",
        permissions=set(),
        x=10,
        y=10,
    )
    _activate_client(target)
    server.clients[owner_ws] = owner
    server.clients[target_ws] = target
    item = server.item_service.default_item(owner, "dice")
    item.x = owner.x
    item.y = owner.y
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcasted_items: list[object] = []
    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast_item(broadcast_item: object) -> None:
        broadcasted_items.append(broadcast_item)

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server.item_runtime, "broadcast_item", fake_broadcast_item)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        owner,
        json.dumps(
            {"type": "item_transfer", "itemId": item.id, "targetUserId": target.user_id}
        ),
    )

    assert item.createdBy == target.user_id
    assert item.createdByName == target.username
    assert broadcasted_items
    assert send_payloads
    result = _last_packet_of_type(send_payloads, ItemActionResultPacket)
    assert result.ok is True
    assert result.action == "transfer"
    assert "you transferred" in result.message.lower()
    assert broadcast_payloads
    chat_packet = _last_packet_of_type(broadcast_payloads, BroadcastChatMessagePacket)
    assert "owner transferred" in chat_packet.message.lower()


@pytest.mark.asyncio
async def test_item_transfer_allows_self_target_for_transfer_any(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    owner_ws = _fake_ws()
    actor_ws = _fake_ws()
    owner = ClientConnection(
        websocket=owner_ws,
        id="u1",
        nickname="owner",
        authenticated=True,
        user_id="1",
        username="owner_user",
        permissions=set(),
        x=5,
        y=6,
    )
    _activate_client(owner)
    actor = ClientConnection(
        websocket=actor_ws,
        id="u3",
        nickname="actor",
        authenticated=True,
        user_id="3",
        username="actor_user",
        permissions={"item.transfer.any"},
        x=5,
        y=6,
    )
    _activate_client(actor)
    server.clients[owner_ws] = owner
    server.clients[actor_ws] = actor
    item = server.item_service.default_item(owner, "dice")
    item.x = actor.x
    item.y = actor.y
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcasted_items: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast_item(broadcast_item: object) -> None:
        broadcasted_items.append(broadcast_item)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server.item_runtime, "broadcast_item", fake_broadcast_item)

    await server._handle_message(
        actor,
        json.dumps(
            {"type": "item_transfer", "itemId": item.id, "targetUserId": actor.user_id}
        ),
    )

    assert item.createdBy == actor.user_id
    assert item.createdByName == actor.username
    assert broadcasted_items
    result = _last_packet_of_type(send_payloads, ItemActionResultPacket)
    assert result.ok is True
    assert result.action == "transfer"


@pytest.mark.asyncio
async def test_item_transfer_accepts_offline_target_user_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    server = SignalingServer(
        "127.0.0.1", 8765, None, None, auth_db_path=tmp_path / "auth.db", grid_size=41
    )
    owner_session = server.auth_service.register("owner_test", "password99")
    actor_session = server.auth_service.register("actor_test", "password99")
    offline_session = server.auth_service.register("offline_test", "password99")
    owner_ws = _fake_ws()
    actor_ws = _fake_ws()
    owner = ClientConnection(
        websocket=owner_ws,
        id="u1",
        nickname="owner",
        authenticated=True,
        user_id=owner_session.user.id,
        username=owner_session.user.username,
        permissions=set(),
        x=5,
        y=6,
    )
    _activate_client(owner)
    actor = ClientConnection(
        websocket=actor_ws,
        id="u3",
        nickname="actor",
        authenticated=True,
        user_id=actor_session.user.id,
        username=actor_session.user.username,
        permissions={"item.transfer.any"},
        x=5,
        y=6,
    )
    _activate_client(actor)
    server.clients[owner_ws] = owner
    server.clients[actor_ws] = actor
    item = server.item_service.default_item(owner, "dice")
    item.x = actor.x
    item.y = actor.y
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        actor,
        json.dumps(
            {
                "type": "item_transfer",
                "itemId": item.id,
                "targetUserId": offline_session.user.id,
            }
        ),
    )

    assert item.createdBy == offline_session.user.id
    assert item.createdByName == offline_session.user.username
    result = _last_packet_of_type(send_payloads, ItemActionResultPacket)
    assert result.ok is True
    assert result.action == "transfer"


@pytest.mark.asyncio
async def test_item_transfer_targets_lists_online_and_offline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    server = SignalingServer(
        "127.0.0.1", 8765, None, None, auth_db_path=tmp_path / "auth.db", grid_size=41
    )
    owner_session = server.auth_service.register("owner_menu", "password99")
    actor_session = server.auth_service.register("actor_menu", "password99")
    online_session = server.auth_service.register("online_menu", "password99")
    offline_session = server.auth_service.register("offline_menu", "password99")
    owner_ws = _fake_ws()
    actor_ws = _fake_ws()
    online_ws = _fake_ws()
    owner = ClientConnection(
        websocket=owner_ws,
        id="u1",
        nickname="owner",
        authenticated=True,
        user_id=owner_session.user.id,
        username=owner_session.user.username,
        permissions=set(),
        x=5,
        y=6,
    )
    _activate_client(owner)
    actor = ClientConnection(
        websocket=actor_ws,
        id="u3",
        nickname="actor",
        authenticated=True,
        user_id=actor_session.user.id,
        username=actor_session.user.username,
        permissions={"item.transfer.any"},
        x=5,
        y=6,
    )
    _activate_client(actor)
    online = ClientConnection(
        websocket=online_ws,
        id="u4",
        nickname="online",
        authenticated=True,
        user_id=online_session.user.id,
        username=online_session.user.username,
        permissions=set(),
        x=10,
        y=10,
    )
    _activate_client(online)
    server.clients[owner_ws] = owner
    server.clients[actor_ws] = actor
    server.clients[online_ws] = online
    item = server.item_service.default_item(owner, "dice")
    item.x = actor.x
    item.y = actor.y
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        actor, json.dumps({"type": "item_transfer_targets", "itemId": item.id})
    )

    assert send_payloads
    result = _last_packet_of_type(send_payloads, ItemTransferTargetsResultPacket)
    usernames = {entry.username for entry in result.targets}
    assert owner_session.user.username not in usernames
    assert online_session.user.username in usernames
    assert offline_session.user.username in usernames
    by_username = {entry.username: entry for entry in result.targets}
    assert by_username[online_session.user.username].online is True
    assert by_username[offline_session.user.username].online is False


@pytest.mark.asyncio
async def test_item_delete_sends_others_notification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    owner_ws = _fake_ws()
    watcher_ws = _fake_ws()
    owner = ClientConnection(
        websocket=owner_ws,
        id="u1",
        nickname="owner",
        authenticated=True,
        user_id="1",
        username="owner_user",
        permissions={"item.delete.own"},
        x=5,
        y=6,
    )
    _activate_client(owner)
    watcher = ClientConnection(
        websocket=watcher_ws,
        id="u2",
        nickname="watcher",
        authenticated=True,
        user_id="2",
        username="watcher_user",
        permissions=set(),
        x=5,
        y=6,
    )
    _activate_client(watcher)
    server.clients[owner_ws] = owner
    server.clients[watcher_ws] = watcher
    item = server.item_service.default_item(owner, "dice")
    item.x = owner.x
    item.y = owner.y
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        owner, json.dumps({"type": "item_delete", "itemId": item.id})
    )

    result_packets = _packets_of_type(send_payloads, ItemActionResultPacket)
    assert result_packets
    assert result_packets[-1].ok is True
    assert "you deleted" in result_packets[-1].message.lower()
    chat_packets = _packets_of_type(broadcast_payloads, BroadcastChatMessagePacket)
    assert chat_packets
    assert "owner deleted" in getattr(chat_packets[-1], "message", "").lower()


@pytest.mark.asyncio
async def test_item_transfer_rejects_when_not_authorized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    owner_ws = _fake_ws()
    target_ws = _fake_ws()
    owner = ClientConnection(
        websocket=owner_ws,
        id="u1",
        nickname="owner",
        authenticated=True,
        user_id="1",
        username="owner_user",
        permissions={"item.use"},
        x=5,
        y=6,
    )
    _activate_client(owner)
    target = ClientConnection(
        websocket=target_ws,
        id="u2",
        nickname="target",
        authenticated=True,
        user_id="2",
        username="target_user",
        permissions=set(),
        x=10,
        y=10,
    )
    _activate_client(target)
    server.clients[owner_ws] = owner
    server.clients[target_ws] = target
    item = server.item_service.default_item(owner, "dice")
    item.x = owner.x
    item.y = owner.y
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        owner,
        json.dumps(
            {"type": "item_transfer", "itemId": item.id, "targetUserId": target.user_id}
        ),
    )

    assert item.createdBy == owner.user_id
    assert send_payloads
    result = _last_packet_of_type(send_payloads, ItemActionResultPacket)
    assert result.ok is False
    assert result.action == "transfer"
    assert "not authorized" in result.message.lower()


@pytest.mark.asyncio
async def test_admin_user_delete_requires_permission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(
        websocket=ws,
        id="u1",
        nickname="Tester",
        authenticated=True,
        user_id="1",
        username="tester",
        permissions={"user.ban_unban"},
    )
    _activate_client(client)
    server.clients[ws] = client

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client, json.dumps({"type": "admin_user_delete", "username": "alpha"})
    )

    assert send_payloads
    packet = _last_packet_of_type(send_payloads, AdminActionResultPacket)
    assert packet.ok is False
    assert packet.action == "user_delete"
    assert "not authorized" in packet.message.lower()


@pytest.mark.asyncio
async def test_user_list_permission_allows_read_only_registered_user_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="Tester"),
        user_id="1",
        username="tester",
        permissions={"user.list"},
    )
    server.clients[ws] = client
    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(
        server.auth_service,
        "list_users_for_admin",
        lambda: [
            {
                "id": "1",
                "username": "tester",
                "role": "user",
                "status": "active",
                "lastSeenAt": 1_800_000_000_000,
            }
        ],
    )

    await server._handle_message(client, json.dumps({"type": "admin_users_list"}))

    result = _last_packet_of_type(send_payloads, AdminUsersListResultPacket)
    assert result.users[0].username == "tester"
    assert result.users[0].online is True


@pytest.mark.asyncio
async def test_user_list_permission_does_not_allow_admin_target_lists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="Tester"),
        user_id="1",
        username="tester",
        permissions={"user.list"},
    )
    server.clients[ws] = client
    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client,
        json.dumps({"type": "admin_users_list", "action": "ban"}),
    )

    result = _last_packet_of_type(send_payloads, AdminActionResultPacket)
    assert result.ok is False
    assert result.action == "user_ban"


@pytest.mark.asyncio
async def test_admin_user_delete_calls_auth_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(
        websocket=ws,
        id="u1",
        nickname="Tester",
        authenticated=True,
        user_id="1",
        username="tester",
        permissions={"account.delete.any"},
    )
    _activate_client(client)
    server.clients[ws] = client

    send_payloads: list[object] = []
    calls: list[tuple[str, str | None]] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(
        server.auth_service, "get_user_id_by_username", lambda _username: None
    )

    def fake_delete_user(username: str, *, actor_user_id: str | None = None) -> str:
        calls.append((username, actor_user_id))
        return username

    monkeypatch.setattr(server.auth_service, "delete_user", fake_delete_user)

    await server._handle_message(
        client, json.dumps({"type": "admin_user_delete", "username": "alpha"})
    )

    assert calls == [("alpha", "1")]
    assert send_payloads
    packet = _last_packet_of_type(send_payloads, AdminActionResultPacket)
    assert packet.ok is True
    assert packet.action == "user_delete"


@pytest.mark.asyncio
async def test_broadcast_fanout_is_concurrent(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws1 = _fake_ws()
    ws2 = _fake_ws()
    server.clients[ws1] = ClientConnection(websocket=ws1, id="u1")
    server.clients[ws2] = ClientConnection(websocket=ws2, id="u2")

    send_started_at: dict[ServerConnection, float] = {}

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_started_at[websocket] = monotonic()
        if websocket is ws1:
            await asyncio.sleep(0.05)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._broadcast({"type": "noop"})

    assert ws1 in send_started_at
    assert ws2 in send_started_at
    assert abs(send_started_at[ws1] - send_started_at[ws2]) < 0.02


@pytest.mark.asyncio
async def test_item_add_rejects_unknown_type(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6),
        permissions={"item.create"},
    )
    server.clients[ws] = client

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client, json.dumps({"type": "item_add", "itemType": "not_a_type"})
    )

    assert send_payloads
    item_result = _last_packet_of_type(send_payloads, ItemActionResultPacket)
    assert item_result.ok is False
    assert "unknown item type" in item_result.message.lower()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("preset_id", "movement_blocked", "expected_x", "sound_x"),
    (("curtain", False, 6, 6), ("solid", True, 5, 5)),
)
async def test_wall_contact_broadcasts_world_sound(
    monkeypatch: pytest.MonkeyPatch,
    preset_id: str,
    movement_blocked: bool,
    expected_x: int,
    sound_x: int,
) -> None:
    server = SignalingServer(
        "127.0.0.1",
        8765,
        None,
        None,
        structure_presets={
            preset_id: {
                "title": "Curtain" if preset_id == "curtain" else "Wall",
                "movementBlocked": movement_blocked,
                "soundTransmission": 0.5 if preset_id == "curtain" else 0.0,
                "height": 40,
                "contactSound": "/sounds/wall.ogg",
            }
        },
    )
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5)
    )
    server.clients[ws] = client
    server.structure_service.add_wall(client, preset_id=preset_id, direction="east")
    broadcasts: list[object] = []

    async def fake_send(_websocket: ServerConnection, _packet: object) -> None:
        return None

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcasts.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client, json.dumps({"type": "update_position", "x": 6, "y": 5, "z": 0})
    )

    assert client.x == expected_x
    sound = _last_packet_of_type(broadcasts, WorldSoundPacket)
    assert sound.sound == "/sounds/wall.ogg"
    assert (sound.x, sound.y, sound.z) == (sound_x, 5, 0)
    assert sound.acousticZoneId == "floor:0"


@pytest.mark.asyncio
async def test_update_position_enforces_cumulative_budget_per_tick(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    server.movement_tick_ms = 100
    server.movement_max_steps_per_tick = 2
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5)
    )
    server.clients[ws] = client

    fixed_now = 10_000
    monkeypatch.setattr(server.item_service, "now_ms", lambda: fixed_now)

    broadcast_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    # First 1-step move in this tick: allowed.
    await server._handle_message(
        client, json.dumps({"type": "update_position", "x": 6, "y": 5, "z": 0})
    )
    # Second 1-step move in the same tick: allowed (budget now exhausted at 2).
    await server._handle_message(
        client, json.dumps({"type": "update_position", "x": 7, "y": 5, "z": 0})
    )
    # Third 1-step move in the same tick: must be rejected.
    await server._handle_message(
        client, json.dumps({"type": "update_position", "x": 8, "y": 5, "z": 0})
    )

    assert client.x == 7
    assert client.y == 5
    assert len(broadcast_payloads) == 2


@pytest.mark.asyncio
async def test_teleport_complete_broadcasts_spatial_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=12, y=13)
    )
    server.clients[ws] = client

    broadcast_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        return None

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client,
        json.dumps({"type": "teleport_complete", "x": 12, "y": 13, "z": 0}),
    )

    position_packets = _packets_of_type(broadcast_payloads, BroadcastPositionPacket)
    teleport_packets = _packets_of_type(
        broadcast_payloads, BroadcastTeleportCompletePacket
    )
    assert len(position_packets) == 1
    assert len(teleport_packets) == 1
    assert position_packets[0].id == "u1"
    assert position_packets[0].x == 12
    assert position_packets[0].y == 13
    assert teleport_packets[0].id == "u1"
    assert teleport_packets[0].x == 12
    assert teleport_packets[0].y == 13
    assert teleport_packets[0].acousticZoneId == "floor:0"


@pytest.mark.asyncio
async def test_update_position_rate_reject_sends_self_correction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5)
    )
    server.clients[ws] = client
    server.movement_tick_ms = 100
    server.movement_max_steps_per_tick = 1

    fixed_now = 10_000
    monkeypatch.setattr(server.item_service, "now_ms", lambda: fixed_now)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        return None

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    # 2-tile move exceeds per-window budget and should be rejected with correction.
    await server._handle_message(
        client, json.dumps({"type": "update_position", "x": 7, "y": 5, "z": 0})
    )

    assert client.x == 5
    assert client.y == 5
    assert send_payloads
    correction = _last_packet_of_type(send_payloads, BroadcastPositionPacket)
    assert correction.id == "u1"
    assert correction.x == 5
    assert correction.y == 5


@pytest.mark.asyncio
async def test_chat_me_command_broadcasts_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="Tester"),
        permissions={"chat.send"},
    )
    server.clients[ws] = client

    broadcast_payloads: list[object] = []
    send_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client, json.dumps({"type": "chat_message", "message": "/Me waves hello"})
    )

    assert send_payloads == []
    assert len(broadcast_payloads) == 1
    packet = _last_packet_of_type(broadcast_payloads, BroadcastChatMessagePacket)
    assert packet.action is True
    assert packet.system is False
    assert packet.message == "Tester waves hello"


@pytest.mark.asyncio
async def test_chat_up_command_sends_sender_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="Tester"),
        permissions={"chat.send"},
    )
    server.clients[ws] = client

    broadcast_payloads: list[object] = []
    send_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_format_uptime", lambda: "1h 2m 3s")

    await server._handle_message(
        client, json.dumps({"type": "chat_message", "message": "/UP"})
    )

    assert broadcast_payloads == []
    assert len(send_payloads) == 1
    packet = _last_packet_of_type(send_payloads, BroadcastChatMessagePacket)
    assert packet.system is True
    assert packet.message == "Server uptime: 1h 2m 3s"


@pytest.mark.asyncio
async def test_chat_command_requires_leading_slash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="Tester"),
        permissions={"chat.send"},
    )
    server.clients[ws] = client

    broadcast_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client, json.dumps({"type": "chat_message", "message": " /up"})
    )

    assert len(broadcast_payloads) == 1
    packet = _last_packet_of_type(broadcast_payloads, BroadcastChatMessagePacket)
    assert packet.system is False
    assert packet.action is False
    assert packet.message == " /up"


@pytest.mark.asyncio
async def test_chat_version_command_is_sender_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(
        ClientConnection(websocket=ws, id="u1", nickname="Tester"),
        permissions={"chat.send"},
    )
    server.clients[ws] = client
    server.server_version = "2026.02.27 R293"

    broadcast_payloads: list[object] = []
    send_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(
        client, json.dumps({"type": "chat_message", "message": "/version"})
    )

    assert broadcast_payloads == []
    assert len(send_payloads) == 1
    packet = _last_packet_of_type(send_payloads, BroadcastChatMessagePacket)
    assert packet.system is True
    assert packet.message == "Server version: 2026.02.27 R293"


@pytest.mark.asyncio
async def test_chat_reboot_requires_permission(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(
        websocket=ws,
        id="u1",
        nickname="Tester",
        authenticated=True,
        user_id="1",
        permissions={"chat.send"},
    )
    _activate_client(client)
    server.clients[ws] = client

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(
        server, "_schedule_reboot", lambda _requested_by, _message: True
    )

    await server._handle_message(
        client, json.dumps({"type": "chat_message", "message": "/reboot patching"})
    )

    assert send_payloads
    packet = _last_packet_of_type(send_payloads, BroadcastChatMessagePacket)
    assert packet.system is True
    assert "not authorized" in packet.message.lower()


@pytest.mark.asyncio
async def test_chat_reboot_schedules_and_broadcasts_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(
        websocket=ws,
        id="u1",
        nickname="Tester",
        authenticated=True,
        user_id="1",
        username="tester",
        permissions={"chat.send", "server.allow_reboot"},
    )
    _activate_client(client)
    server.clients[ws] = client

    broadcast_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(
        server,
        "_schedule_reboot",
        lambda requested_by, message: (
            requested_by == "tester" and message == "maintenance"
        ),
    )

    await server._handle_message(
        client, json.dumps({"type": "chat_message", "message": "/reboot maintenance"})
    )

    assert len(broadcast_payloads) == 1
    packet = _last_packet_of_type(broadcast_payloads, BroadcastChatMessagePacket)
    assert packet.system is True
    assert packet.message == "Server rebooting in 5 seconds. maintenance"


@pytest.mark.asyncio
async def test_chat_reboot_already_in_progress_sends_sender_only_notice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(
        websocket=ws,
        id="u1",
        nickname="Tester",
        authenticated=True,
        user_id="1",
        username="tester",
        permissions={"chat.send", "server.allow_reboot"},
    )
    _activate_client(client)
    server.clients[ws] = client

    broadcast_payloads: list[object] = []
    send_payloads: list[object] = []

    async def fake_broadcast(
        packet: object, exclude: ServerConnection | None = None
    ) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(
        server, "_schedule_reboot", lambda _requested_by, _message: False
    )

    await server._handle_message(
        client, json.dumps({"type": "chat_message", "message": "/reboot maintenance"})
    )

    assert broadcast_payloads == []
    assert len(send_payloads) == 1
    packet = _last_packet_of_type(send_payloads, BroadcastChatMessagePacket)
    assert packet.system is True
    assert packet.message == "Server reboot already in progress."
