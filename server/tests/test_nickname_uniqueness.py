from __future__ import annotations

from typing import cast

from websockets.asyncio.server import ServerConnection

from app.server import ClientConnection, SignalingServer


def _fake_ws() -> ServerConnection:
    return cast(ServerConnection, object())


def test_nickname_taken_is_case_insensitive() -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    first_ws = _fake_ws()
    second_ws = _fake_ws()
    server.clients[first_ws] = ClientConnection(websocket=first_ws, id="1", nickname="Jage")
    server.clients[second_ws] = ClientConnection(websocket=second_ws, id="2", nickname="Alice")

    assert server._is_nickname_taken("jage", exclude_client_id="2")
    assert server._is_nickname_taken("JAGE", exclude_client_id="2")
    assert not server._is_nickname_taken("jage", exclude_client_id="1")


def test_nickname_key_uses_casefold() -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    assert server._nickname_key("Jage") == server._nickname_key("jage")
