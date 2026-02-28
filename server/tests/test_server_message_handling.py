from __future__ import annotations

import asyncio
import json
from time import monotonic
from typing import cast
import uuid

import pytest
from websockets.asyncio.server import ServerConnection

from app.client import ClientConnection
from app.server import SignalingServer


def _fake_ws() -> ServerConnection:
    return cast(ServerConnection, object())


def _packet_types(payloads: list[object]) -> list[str]:
    return [getattr(packet, "type", "") for packet in payloads]


@pytest.mark.asyncio
async def test_update_position_rejects_out_of_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client

    broadcast_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(client, json.dumps({"type": "update_position", "x": 200, "y": -5}))

    assert client.x == 5
    assert client.y == 6
    assert broadcast_payloads == []


@pytest.mark.asyncio
async def test_radio_metadata_refresh_updates_station_and_title(monkeypatch: pytest.MonkeyPatch) -> None:
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

    monkeypatch.setattr(server, "_broadcast_item", fake_broadcast_item)
    monkeypatch.setattr(server, "_fetch_stream_metadata", fake_fetch)

    await server._refresh_radio_metadata_once()

    assert radio.params["stationName"] == "Test Station"
    assert radio.params["nowPlaying"] == "Test Song"


@pytest.mark.asyncio
async def test_radio_metadata_refresh_skips_when_no_listener_in_range(monkeypatch: pytest.MonkeyPatch) -> None:
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

    monkeypatch.setattr(server, "_fetch_stream_metadata", fake_fetch)

    await server._refresh_radio_metadata_once()

    assert called is False


@pytest.mark.asyncio
async def test_item_secondary_use_radio_reports_now_playing(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5)
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

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(client, json.dumps({"type": "item_secondary_use", "itemId": radio.id}))

    results = [packet for packet in send_payloads if getattr(packet, "type", "") == "item_action_result"]
    assert results
    assert results[-1].ok is True
    assert results[-1].action == "secondary_use"
    assert "Playing Song Y from Station X." in results[-1].message
    assert broadcast_payloads == []


@pytest.mark.asyncio
async def test_item_secondary_use_missing_handler_returns_message(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5)
    server.clients[ws] = client

    dice = server.item_service.default_item(client, "dice")
    dice.x = 5
    dice.y = 5
    server.item_service.add_item(dice)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(client, json.dumps({"type": "item_secondary_use", "itemId": dice.id}))

    results = [packet for packet in send_payloads if getattr(packet, "type", "") == "item_action_result"]
    assert results
    assert results[-1].ok is False
    assert results[-1].action == "secondary_use"
    assert "No secondary action" in results[-1].message


def test_clock_alarm_announcement_sequence_shape() -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    params = {"timeZone": "America/Detroit", "use24Hour": False}

    alarm_sounds = server._build_clock_announcement_sounds(params, top_of_hour=False, alarm=True)
    assert alarm_sounds
    assert alarm_sounds[0] == "/sounds/clock/el640/announcement.ogg"
    assert alarm_sounds[-1] == "/sounds/clock/el640/alarm.ogg"

    top_of_hour_sounds = server._build_clock_announcement_sounds(params, top_of_hour=True, alarm=False)
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

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return None

    async def fake_run_auth_hash_task(func, /, *args, **kwargs):
        offload_calls.append(getattr(func, "__name__", "unknown"))
        return func(*args, **kwargs)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_run_auth_hash_task", fake_run_auth_hash_task)

    await server._handle_message(
        client,
        json.dumps({"type": "auth_login", "username": username, "password": "password99"}),
    )

    assert "login" in offload_calls
    auth_results = [packet for packet in send_payloads if getattr(packet, "type", "") == "auth_result"]
    assert auth_results
    assert auth_results[-1].ok is True


@pytest.mark.asyncio
async def test_auth_rate_limit_blocks_before_hash(monkeypatch: pytest.MonkeyPatch) -> None:
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

    await server._handle_message(client, json.dumps({"type": "auth_login", "username": "alpha", "password": "wrongpass"}))

    assert called_login is False
    assert send_payloads
    assert send_payloads[-1].ok is False
    assert "too many" in send_payloads[-1].message.lower()


@pytest.mark.asyncio
async def test_item_drop_rejects_out_of_bounds(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "dice")
    item.carrierId = client.id
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(client, json.dumps({"type": "item_drop", "itemId": item.id, "x": 999, "y": 999}))

    assert item.carrierId == client.id
    assert send_payloads[-1].ok is False
    assert "out of bounds" in send_payloads[-1].message.lower()


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
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(client, json.dumps({"type": "item_add", "itemType": "not_a_type"}))

    assert send_payloads
    assert send_payloads[-1].ok is False
    assert "unknown item type" in send_payloads[-1].message.lower()


@pytest.mark.asyncio
async def test_update_position_enforces_cumulative_budget_per_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    server.movement_tick_ms = 100
    server.movement_max_steps_per_tick = 2
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5)
    server.clients[ws] = client

    fixed_now = 10_000
    monkeypatch.setattr(server.item_service, "now_ms", lambda: fixed_now)

    broadcast_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    # First 1-step move in this tick: allowed.
    await server._handle_message(client, json.dumps({"type": "update_position", "x": 6, "y": 5}))
    # Second 1-step move in the same tick: allowed (budget now exhausted at 2).
    await server._handle_message(client, json.dumps({"type": "update_position", "x": 7, "y": 5}))
    # Third 1-step move in the same tick: must be rejected.
    await server._handle_message(client, json.dumps({"type": "update_position", "x": 8, "y": 5}))

    assert client.x == 7
    assert client.y == 5
    assert len(broadcast_payloads) == 2


@pytest.mark.asyncio
async def test_teleport_complete_broadcasts_spatial_event(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=12, y=13)
    server.clients[ws] = client

    broadcast_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        return None

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(client, json.dumps({"type": "teleport_complete", "x": 12, "y": 13}))

    assert len(broadcast_payloads) == 2
    assert broadcast_payloads[0].type == "update_position"
    assert broadcast_payloads[0].id == "u1"
    assert broadcast_payloads[0].x == 12
    assert broadcast_payloads[0].y == 13
    assert broadcast_payloads[1].type == "teleport_complete"
    assert broadcast_payloads[1].id == "u1"
    assert broadcast_payloads[1].x == 12
    assert broadcast_payloads[1].y == 13


@pytest.mark.asyncio
async def test_update_position_rate_reject_sends_self_correction(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=5)
    server.clients[ws] = client
    server.movement_tick_ms = 100
    server.movement_max_steps_per_tick = 1

    fixed_now = 10_000
    monkeypatch.setattr(server.item_service, "now_ms", lambda: fixed_now)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return None

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    # 2-tile move exceeds per-window budget and should be rejected with correction.
    await server._handle_message(client, json.dumps({"type": "update_position", "x": 7, "y": 5}))

    assert client.x == 5
    assert client.y == 5
    assert send_payloads
    correction = send_payloads[-1]
    assert correction.type == "update_position"
    assert correction.id == "u1"
    assert correction.x == 5
    assert correction.y == 5


@pytest.mark.asyncio
async def test_chat_me_command_broadcasts_action(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="Tester")
    server.clients[ws] = client

    broadcast_payloads: list[object] = []
    send_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(client, json.dumps({"type": "chat_message", "message": "/Me waves hello"}))

    assert send_payloads == []
    assert len(broadcast_payloads) == 1
    packet = broadcast_payloads[0]
    assert getattr(packet, "type", "") == "chat_message"
    assert packet.action is True
    assert packet.system is False
    assert packet.message == "Tester waves hello"


@pytest.mark.asyncio
async def test_chat_up_command_sends_sender_only(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="Tester")
    server.clients[ws] = client

    broadcast_payloads: list[object] = []
    send_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_format_uptime", lambda: "1h 2m 3s")

    await server._handle_message(client, json.dumps({"type": "chat_message", "message": "/UP"}))

    assert broadcast_payloads == []
    assert len(send_payloads) == 1
    packet = send_payloads[0]
    assert getattr(packet, "type", "") == "chat_message"
    assert packet.system is True
    assert packet.message == "Server uptime: 1h 2m 3s"


@pytest.mark.asyncio
async def test_chat_command_requires_leading_slash(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="Tester")
    server.clients[ws] = client

    broadcast_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(client, json.dumps({"type": "chat_message", "message": " /up"}))

    assert len(broadcast_payloads) == 1
    packet = broadcast_payloads[0]
    assert getattr(packet, "type", "") == "chat_message"
    assert packet.system is False
    assert packet.action is False
    assert packet.message == " /up"


@pytest.mark.asyncio
async def test_chat_version_command_is_sender_only(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="Tester")
    server.clients[ws] = client
    server.server_version = "2026.02.27 R293"

    broadcast_payloads: list[object] = []
    send_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)

    await server._handle_message(client, json.dumps({"type": "chat_message", "message": "/version"}))

    assert broadcast_payloads == []
    assert len(send_payloads) == 1
    packet = send_payloads[0]
    assert getattr(packet, "type", "") == "chat_message"
    assert packet.system is True
    assert packet.message == "Server version: 2026.02.27 R293"


@pytest.mark.asyncio
async def test_chat_reboot_requires_permission(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="Tester", authenticated=True, user_id="1", permissions={"chat.send"})
    server.clients[ws] = client

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_schedule_reboot", lambda _requested_by, _message: True)

    await server._handle_message(client, json.dumps({"type": "chat_message", "message": "/reboot patching"}))

    assert send_payloads
    packet = send_payloads[-1]
    assert getattr(packet, "type", "") == "chat_message"
    assert packet.system is True
    assert "not authorized" in packet.message.lower()


@pytest.mark.asyncio
async def test_chat_reboot_schedules_and_broadcasts_message(monkeypatch: pytest.MonkeyPatch) -> None:
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
    server.clients[ws] = client

    broadcast_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_schedule_reboot", lambda requested_by, message: requested_by == "tester" and message == "maintenance")

    await server._handle_message(client, json.dumps({"type": "chat_message", "message": "/reboot maintenance"}))

    assert len(broadcast_payloads) == 1
    packet = broadcast_payloads[0]
    assert getattr(packet, "type", "") == "chat_message"
    assert packet.system is True
    assert packet.message == "Server rebooting in 5 seconds. maintenance"


@pytest.mark.asyncio
async def test_chat_reboot_already_in_progress_sends_sender_only_notice(monkeypatch: pytest.MonkeyPatch) -> None:
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
    server.clients[ws] = client

    broadcast_payloads: list[object] = []
    send_payloads: list[object] = []

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_schedule_reboot", lambda _requested_by, _message: False)

    await server._handle_message(client, json.dumps({"type": "chat_message", "message": "/reboot maintenance"}))

    assert broadcast_payloads == []
    assert len(send_payloads) == 1
    packet = send_payloads[0]
    assert getattr(packet, "type", "") == "chat_message"
    assert packet.system is True
    assert packet.message == "Server reboot already in progress."
