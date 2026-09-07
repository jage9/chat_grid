from __future__ import annotations

import os
from dataclasses import dataclass
from typing import cast
from uuid import uuid4

import pytest
from websockets.asyncio.server import ServerConnection

from app.client import ClientConnection
from app.delivery import RecordingTransport
from app.server import SignalingServer


os.environ.setdefault("CHGRID_AUTH_SECRET", "test-secret")


@dataclass
class World:
    server: SignalingServer
    transport: RecordingTransport

    def connect(
        self, nickname: str, *, client_id: str | None = None, **fields
    ) -> ClientConnection:
        """Create an unauthenticated client outside the roster."""
        client = ClientConnection(
            websocket=cast(ServerConnection, object()),
            id=client_id if client_id is not None else uuid4().hex,
            nickname=nickname,
        )
        for name, value in fields.items():
            setattr(client, name, value)
        return client

    def join(
        self,
        nickname: str,
        *,
        x: int = 20,
        y: int = 20,
        z: int = 0,
        client_id: str | None = None,
        user_id: str | None = None,
        username: str | None = None,
        role: str = "admin",
        permissions: set[str] | None = None,
        **fields,
    ) -> ClientConnection:
        """Create an authenticated, world-ready client in the roster."""
        client = self.connect(nickname, client_id=client_id, x=x, y=y, z=z)
        client.authenticated = True
        client.user_id = client.id if user_id is None else user_id
        client.username = nickname if username is None else username
        client.role = role
        client.permissions = set(
            self.server.auth_service.list_all_permissions()
            if permissions is None
            else permissions
        )
        client.world_ready = True
        for name, value in fields.items():
            setattr(client, name, value)
        self.server.clients[client.websocket] = client
        return client


@pytest.fixture
def make_world():
    def make_world(**server_kwargs) -> World:
        transport = RecordingTransport()
        server = SignalingServer(
            "127.0.0.1", 8765, None, None, transport=transport, **server_kwargs
        )
        return World(server, transport)

    return make_world


@pytest.fixture
def world(make_world) -> World:
    return make_world()
