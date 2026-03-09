from __future__ import annotations

import json
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from app.models import BroadcastChatMessagePacket, BroadcastNicknamePacket, NicknameResultPacket
from app.server import ClientConnection, SignalingServer


def _fake_ws() -> ServerConnection:
    return cast(ServerConnection, object())


def _activate_client(client: ClientConnection) -> ClientConnection:
    client.authenticated = True
    client.user_id = client.user_id or client.id
    client.username = client.username or client.nickname
    client.permissions = set(client.permissions or set()) | {"profile.update_nickname"}
    client.world_ready = True
    return client


@pytest.mark.asyncio
async def test_same_nickname_same_case_is_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(ClientConnection(websocket=ws, id="1", nickname="Jage"))
    server.clients[ws] = client

    sent_packets: list[object] = []
    broadcast_packets: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        sent_packets.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_packets.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(client, json.dumps({"type": "update_nickname", "nickname": "Jage"}))

    assert client.nickname == "Jage"
    assert broadcast_packets == []
    assert any(
        isinstance(packet, NicknameResultPacket) and packet.accepted and packet.effectiveNickname == "Jage"
        for packet in sent_packets
    )


@pytest.mark.asyncio
async def test_case_only_change_is_allowed_and_broadcast(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = _activate_client(ClientConnection(websocket=ws, id="1", nickname="jage"))
    server.clients[ws] = client

    sent_packets: list[object] = []
    broadcast_packets: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        sent_packets.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_packets.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(client, json.dumps({"type": "update_nickname", "nickname": "Jage"}))

    assert client.nickname == "Jage"
    assert any(
        isinstance(packet, NicknameResultPacket) and packet.accepted and packet.effectiveNickname == "Jage"
        for packet in sent_packets
    )
    assert any(isinstance(packet, BroadcastNicknamePacket) for packet in broadcast_packets)
    assert any(isinstance(packet, BroadcastChatMessagePacket) for packet in broadcast_packets)
