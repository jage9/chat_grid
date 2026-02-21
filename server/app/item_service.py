from __future__ import annotations

import json
import logging
import time
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Literal

from .client import ClientConnection
from .item_catalog import get_item_definition
from .models import PersistedWorldItem, WorldItem

LOGGER = logging.getLogger("chgrid.server")


class ItemService:
    def __init__(self, state_file: Path | None = None):
        self.state_file = state_file
        self.items: dict[str, WorldItem] = {}
        self.load_state()

    @staticmethod
    def now_ms() -> int:
        return int(time.time() * 1000)

    def default_item(self, client: ClientConnection, item_type: Literal["radio_station", "dice", "wheel", "clock"]) -> WorldItem:
        item_def = get_item_definition(item_type)
        now = self.now_ms()
        return WorldItem(
            id=str(uuid.uuid4()),
            type=item_type,
            title=item_def.default_title,
            x=client.x,
            y=client.y,
            createdBy=client.id,
            createdAt=now,
            updatedAt=now,
            version=1,
            capabilities=list(item_def.capabilities),
            useSound=item_def.use_sound,
            emitSound=item_def.emit_sound,
            params=deepcopy(item_def.default_params),
            carrierId=None,
        )

    def add_item(self, item: WorldItem) -> None:
        self.items[item.id] = item

    def remove_item(self, item_id: str) -> None:
        if item_id in self.items:
            del self.items[item_id]

    def find_carried_item(self, client_id: str) -> WorldItem | None:
        for item in self.items.values():
            if item.carrierId == client_id:
                return item
        return None

    def items_on_square(self, x: int, y: int) -> list[WorldItem]:
        return [item for item in self.items.values() if item.carrierId is None and item.x == x and item.y == y]

    def drop_carried_items_for_disconnect(self, client: ClientConnection) -> list[WorldItem]:
        changed: list[WorldItem] = []
        for item in self.items.values():
            if item.carrierId == client.id:
                item.carrierId = None
                item.x = client.x
                item.y = client.y
                item.updatedAt = self.now_ms()
                changed.append(item)
        return changed

    def load_state(self) -> None:
        if not self.state_file:
            return
        try:
            if not self.state_file.exists():
                return
            raw = json.loads(self.state_file.read_text(encoding="utf-8"))
            if not isinstance(raw, list):
                return
            loaded: dict[str, WorldItem] = {}
            for entry in raw:
                persisted = PersistedWorldItem.model_validate(entry)
                item_def = get_item_definition(persisted.type)
                item = WorldItem(
                    id=persisted.id,
                    type=persisted.type,
                    title=persisted.title,
                    x=persisted.x,
                    y=persisted.y,
                    createdBy=persisted.createdBy,
                    createdAt=persisted.createdAt,
                    updatedAt=persisted.updatedAt,
                    version=persisted.version,
                    capabilities=list(item_def.capabilities),
                    useSound=item_def.use_sound,
                    emitSound=item_def.emit_sound,
                    params=persisted.params,
                    carrierId=persisted.carrierId,
                )
                loaded[item.id] = item
            self.items = loaded
            LOGGER.info("loaded %d persisted items from %s", len(self.items), self.state_file)
        except Exception as exc:
            LOGGER.warning("failed to load persisted item state from %s: %s", self.state_file, exc)

    def save_state(self) -> None:
        if not self.state_file:
            return
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            payload = [
                PersistedWorldItem(
                    id=item.id,
                    type=item.type,
                    title=item.title,
                    x=item.x,
                    y=item.y,
                    createdBy=item.createdBy,
                    createdAt=item.createdAt,
                    updatedAt=item.updatedAt,
                    version=item.version,
                    params=item.params,
                    carrierId=item.carrierId,
                ).model_dump(exclude_none=True)
                for item in self.items.values()
            ]
            self.state_file.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
        except Exception as exc:
            LOGGER.warning("failed to persist item state to %s: %s", self.state_file, exc)
