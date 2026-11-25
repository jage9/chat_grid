from __future__ import annotations

import asyncio
import json
import uuid
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from app.client import ClientConnection
from app.models import (
    AuthResultPacket,
    BroadcastChatMessagePacket,
    LiveKitTokenPacket,
    WelcomePacket,
)

from .conftest import World


class ClosableSocket:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class HeldSocket(ClosableSocket):
    def __init__(self) -> None:
        super().__init__()
        self.close_started = asyncio.Event()
        self.release = asyncio.Event()

    async def close(self) -> None:
        self.close_started.set()
        await self.release.wait()
        self.closed = True


def register_user(world: World) -> str:
    username = f"spare_{uuid.uuid4().hex[:8]}"
    world.server.auth_service.register(username, "password99")
    return username


async def log_in(
    world: World, username: str, socket: ClosableSocket | None = None
) -> ClientConnection:
    client = world.connect("spare")
    client.websocket = cast(ServerConnection, socket or ClosableSocket())
    await world.server._handle_message(
        client,
        json.dumps(
            {"type": "auth_login", "username": username, "password": "password99"}
        ),
    )
    return client


async def log_in_without_joining(world: World) -> tuple[ClientConnection, str]:
    username = register_user(world)
    client = await log_in(world, username)
    assert client.authenticated is True
    assert client.websocket not in world.server.clients
    return client, username


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("packet_type", "message"),
    [
        ("admin_user_ban", "Account is disabled."),
        ("admin_user_delete", "Account deleted."),
    ],
)
async def test_ban_and_delete_close_connections_that_have_not_joined(
    world: World, packet_type: str, message: str
) -> None:
    admin = world.join("admin")
    spare, username = await log_in_without_joining(world)

    await world.server._handle_message(
        admin, json.dumps({"type": packet_type, "username": username})
    )

    assert cast(ClosableSocket, spare.websocket).closed is True
    result = world.transport.last_packet_of_type(spare, AuthResultPacket)
    assert result.ok is False
    assert result.message == message


@pytest.mark.asyncio
@pytest.mark.parametrize("remove_account", ["disable", "delete"])
async def test_welcome_ready_rejects_an_account_that_is_no_longer_active(
    world: World, remove_account: str
) -> None:
    observer = world.join("observer")
    spare, username = await log_in_without_joining(world)
    if remove_account == "disable":
        world.server.auth_service.set_user_status(username, "disabled")
    else:
        world.server.auth_service.delete_user(username)
    world.transport.clear()

    await world.server._handle_message(spare, json.dumps({"type": "welcome_ready"}))

    assert spare.websocket not in world.server.clients
    assert spare.world_ready is False
    assert cast(ClosableSocket, spare.websocket).closed is True
    assert world.transport.last_packet_of_type(spare, AuthResultPacket).ok is False
    assert world.transport.packets_to(observer) == []


@pytest.mark.asyncio
async def test_login_that_finishes_after_a_ban_is_rejected(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    username = register_user(world)
    auth_service = world.server.auth_service
    real_login = auth_service.login

    def login_then_ban(name: str, password: str):
        session = real_login(name, password)
        auth_service.set_user_status(name, "disabled")
        return session

    monkeypatch.setattr(auth_service, "login", login_then_ban)
    monkeypatch.setattr(
        world.server, "_sleep_auth_failure_jitter", lambda: asyncio.sleep(0)
    )

    client = await log_in(world, username)

    assert client.authenticated is False
    assert client.websocket not in world.server.authenticated_clients
    assert world.transport.last_packet_of_type(client, AuthResultPacket).ok is False
    assert not world.transport.packets_of_type(client, WelcomePacket)
    assert not world.transport.packets_of_type(client, LiveKitTokenPacket)


@pytest.mark.asyncio
async def test_ban_revokes_every_connection_before_waiting_on_any_close(
    world: World,
) -> None:
    admin = world.join("admin")
    observer = world.join("observer")
    username = register_user(world)
    held_socket = HeldSocket()
    joined = await log_in(world, username, held_socket)
    await world.server._handle_message(joined, json.dumps({"type": "welcome_ready"}))
    assert joined.websocket in world.server.clients
    pending = await log_in(world, username)
    world.transport.clear()

    ban = asyncio.create_task(
        world.server._handle_message(
            admin, json.dumps({"type": "admin_user_ban", "username": username})
        )
    )
    await held_socket.close_started.wait()
    try:
        assert joined.revoked is True
        assert pending.revoked is True
        assert cast(ClosableSocket, pending.websocket).closed is True

        await world.server._handle_message(
            joined, json.dumps({"type": "chat_message", "message": "still here"})
        )
        assert not world.transport.packets_of_type(observer, BroadcastChatMessagePacket)
    finally:
        held_socket.release.set()
        await ban

    assert held_socket.closed is True
