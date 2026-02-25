"""Client connection model used by the signaling server."""

from __future__ import annotations

from dataclasses import dataclass

from websockets.asyncio.server import ServerConnection


@dataclass
class ClientConnection:
    """Represents one connected websocket client and its world state."""

    websocket: ServerConnection
    id: str
    nickname: str = "user..."
    x: int = 20
    y: int = 20
    last_position_update_ms: int = 0

    def summary(self) -> dict[str, str | int]:
        """Return a compact serializable snapshot for logs/diagnostics."""

        return {"id": self.id, "nickname": self.nickname, "x": self.x, "y": self.y}
