from __future__ import annotations

import asyncio
import json
from time import monotonic
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from app.client import ClientConnection
from app.server import SignalingServer


def _fake_ws() -> ServerConnection:
    return cast(ServerConnection, object())


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
