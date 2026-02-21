from __future__ import annotations

import json
from pathlib import Path
from typing import cast

from websockets.asyncio.server import ServerConnection

from app.client import ClientConnection
from app.item_service import ItemService


def _fake_ws() -> ServerConnection:
    return cast(ServerConnection, object())


def test_item_persistence_omits_global_type_properties(tmp_path: Path) -> None:
    state_file = tmp_path / "items.json"
    service = ItemService(state_file=state_file)
    client = ClientConnection(websocket=_fake_ws(), id="u1", x=3, y=4)

    item = service.default_item(client, "dice")
    service.add_item(item)
    service.save_state()

    saved = json.loads(state_file.read_text(encoding="utf-8"))
    assert isinstance(saved, list)
    assert len(saved) == 1
    assert "capabilities" not in saved[0]
    assert "useSound" not in saved[0]
    assert "emitSound" not in saved[0]

    reloaded = ItemService(state_file=state_file)
    loaded_item = reloaded.items[item.id]
    assert loaded_item.useSound == "sounds/roll.ogg"
    assert loaded_item.emitSound is None
    assert "usable" in loaded_item.capabilities
