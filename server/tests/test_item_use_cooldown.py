from __future__ import annotations

import json
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from app.server import ClientConnection, SignalingServer


def _fake_ws() -> ServerConnection:
    return cast(ServerConnection, object())


@pytest.mark.asyncio
async def test_item_use_has_global_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "dice")
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    now_ms = 10_000

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True

    now_ms += 400
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is False
    assert "cooldown" in send_payloads[-1].message.lower()

    now_ms += 700
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True


@pytest.mark.asyncio
async def test_radio_use_toggles_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "radio_station")
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []
    now_ms = 20_000

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    assert item.params.get("enabled") is True
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert item.params.get("enabled") is False
    assert send_payloads[-1].ok is True

    now_ms += 1200
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert item.params.get("enabled") is True
    assert send_payloads[-1].ok is True

    assert any(getattr(packet, "type", "") == "item_upsert" for packet in broadcast_payloads)


@pytest.mark.asyncio
async def test_radio_channel_update_validates(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "radio_station")
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"channel": "left"}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("channel") == "left"

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"channel": "invalid"}}),
    )
    assert send_payloads[-1].ok is False
    assert "channel must be one of" in send_payloads[-1].message.lower()


@pytest.mark.asyncio
async def test_clock_use_reports_time_without_use_sound_packet(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "clock")
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: 30_000)
    monkeypatch.setattr(server, "_format_clock_display_time", lambda _params: "2:15 PM")

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))

    assert send_payloads[-1].ok is True
    assert send_payloads[-1].message == f"{item.title} says 2:15 PM."
    assert not any(getattr(packet, "type", "") == "item_use_sound" for packet in broadcast_payloads)


@pytest.mark.asyncio
async def test_clock_timezone_update_validates(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "clock")
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"timeZone": "Europe/Berlin"}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("timeZone") == "Europe/Berlin"

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"timeZone": "Invalid/Zone"}}),
    )
    assert send_payloads[-1].ok is False
    assert "timezone must be one of" in send_payloads[-1].message.lower()


@pytest.mark.asyncio
async def test_failed_wheel_use_does_not_consume_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "wheel")
    item.params["spaces"] = ",,,"
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    now_ms = 40_000

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is False
    assert "spaces" in send_payloads[-1].message.lower()

    item.params["spaces"] = "a,b,c"
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True
