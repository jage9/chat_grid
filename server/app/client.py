from __future__ import annotations

from dataclasses import dataclass

from websockets.asyncio.server import ServerConnection


@dataclass
class ClientConnection:
    websocket: ServerConnection
    id: str
    nickname: str = "user..."
    x: int = 20
    y: int = 20

    def summary(self) -> dict[str, str | int]:
        return {"id": self.id, "nickname": self.nickname, "x": self.x, "y": self.y}
