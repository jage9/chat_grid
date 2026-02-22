"""Websocket signaling server for chat, presence, and item interactions."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime
import json
import logging
import ssl
import uuid
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import ValidationError, TypeAdapter
from websockets.asyncio.server import ServerConnection, serve

from .client import ClientConnection
from .config import load_config
from .item_catalog import (
    CLOCK_DEFAULT_TIME_ZONE,
    CLOCK_TIME_ZONE_OPTIONS,
    ITEM_PROPERTY_OPTIONS,
    ITEM_TYPE_EDITABLE_PROPERTIES,
    ITEM_TYPE_LABELS,
    ITEM_TYPE_PROPERTY_METADATA,
    ITEM_TYPE_SEQUENCE,
    ITEM_TYPE_TOOLTIPS,
    get_item_global_properties,
    get_item_use_cooldown_ms,
)
from .item_type_handlers import get_item_type_handler
from .item_service import ItemService
from .models import (
    BroadcastChatMessagePacket,
    BroadcastNicknamePacket,
    BroadcastPositionPacket,
    ChatMessagePacket,
    ClientPacket,
    ForwardSignalPacket,
    ItemActionResultPacket,
    ItemAddPacket,
    ItemDeletePacket,
    ItemDropPacket,
    ItemPickupPacket,
    ItemRemovePacket,
    ItemUpdatePacket,
    ItemUpsertPacket,
    ItemUsePacket,
    ItemUseSoundPacket,
    NicknameResultPacket,
    PingPacket,
    PongPacket,
    RemoteUser,
    UpdateNicknamePacket,
    UpdatePositionPacket,
    UserLeftPacket,
    WelcomePacket,
    WorldItem,
)

LOGGER = logging.getLogger("chgrid.server")
PACKET_LOGGER = logging.getLogger("chgrid.server.packet")
CLIENT_PACKET_ADAPTER = TypeAdapter(ClientPacket)


class SignalingServer:
    """Coordinates websocket clients, signaling, and authoritative item actions."""

    def __init__(
        self,
        host: str,
        port: int,
        ssl_cert: str | None,
        ssl_key: str | None,
        max_message_size: int = 2_000_000,
        state_file: Path | None = None,
        grid_size: int = 41,
    ):
        """Initialize runtime state, TLS context, and item service."""

        self.host = host
        self.port = port
        self.max_message_size = max_message_size
        self._ssl_context = self._build_ssl_context(ssl_cert, ssl_key)
        self.clients: dict[ServerConnection, ClientConnection] = {}
        self.item_service = ItemService(state_file=state_file)
        self.item_last_use_ms: dict[str, int] = {}
        self.grid_size = max(1, grid_size)

    @property
    def items(self) -> dict[str, WorldItem]:
        """Expose current item map owned by the item service."""

        return self.item_service.items

    def _nickname_key(self, nickname: str) -> str:
        """Normalize nickname for case-insensitive comparisons."""

        return nickname.casefold()

    def _is_nickname_taken(self, nickname: str, exclude_client_id: str | None = None) -> bool:
        """Check whether nickname is already used by another active client."""

        wanted = self._nickname_key(nickname)
        for other in self.clients.values():
            if exclude_client_id is not None and other.id == exclude_client_id:
                continue
            if self._nickname_key(other.nickname) == wanted:
                return True
        return False

    @staticmethod
    def _item_type_label(item: WorldItem) -> str:
        """Return user-facing item type wording for chat/status strings."""

        return "radio" if item.type == "radio_station" else item.type

    def _is_in_bounds(self, x: int, y: int) -> bool:
        """Check whether a coordinate is inside server-authoritative world bounds."""

        return 0 <= x < self.grid_size and 0 <= y < self.grid_size

    @staticmethod
    def _normalize_clock_timezone(value: object) -> str:
        """Normalize timezone input to one of supported clock zones."""

        token = str(value or "").strip()
        if token in CLOCK_TIME_ZONE_OPTIONS:
            return token
        return CLOCK_DEFAULT_TIME_ZONE

    @staticmethod
    def _parse_clock_use_24_hour(value: object) -> bool | None:
        """Parse bool-like clock format values (`on/off`, `true/false`, etc.)."""

        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            token = value.strip().lower()
            if token in {"on", "true", "1", "yes"}:
                return True
            if token in {"off", "false", "0", "no"}:
                return False
        return None

    @classmethod
    def _format_clock_display_time(cls, params: dict) -> str:
        """Render current clock text based on item timezone/format params."""

        tz_name = cls._normalize_clock_timezone(params.get("timeZone"))
        use_24_hour = cls._parse_clock_use_24_hour(params.get("use24Hour"))
        if use_24_hour is None:
            use_24_hour = False
        now = datetime.now(ZoneInfo(tz_name))
        if use_24_hour:
            return now.strftime("%H:%M")
        hour_12 = now.hour % 12 or 12
        return f"{hour_12}:{now.minute:02d} {'AM' if now.hour < 12 else 'PM'}"

    async def _send_item_result(
        self,
        client: ClientConnection,
        ok: bool,
        action: Literal["add", "pickup", "drop", "delete", "use", "update"],
        message: str,
        item_id: str | None = None,
    ) -> None:
        """Send a structured item action result to one client."""

        await self._send(
            client.websocket,
            ItemActionResultPacket(
                type="item_action_result",
                ok=ok,
                action=action,
                message=message,
                itemId=item_id,
            ),
        )

    async def _broadcast_item(self, item: WorldItem) -> None:
        """Broadcast a full item snapshot update to all connected clients."""

        await self._broadcast(ItemUpsertPacket(type="item_upsert", item=item))

    async def start(self) -> None:
        """Start websocket serving and run until cancelled."""

        protocol = "wss" if self._ssl_context else "ws"
        LOGGER.info("starting signaling server on %s://%s:%d", protocol, self.host, self.port)
        async with serve(
            self._handle_client,
            self.host,
            self.port,
            ssl=self._ssl_context,
            max_size=self.max_message_size,
        ):
            await asyncio.Future()

    async def _handle_client(self, websocket: ServerConnection) -> None:
        """Handle one websocket client's connect/message/disconnect lifecycle."""

        client = ClientConnection(websocket=websocket, id=str(uuid.uuid4()))
        self.clients[websocket] = client
        LOGGER.info("client connected id=%s total=%d", client.id, len(self.clients))

        try:
            await self._send_welcome(client)
            async for raw_message in websocket:
                await self._handle_message(client, raw_message)
        finally:
            if websocket in self.clients:
                disconnected = self.clients.pop(websocket)
                for item in self.item_service.drop_carried_items_for_disconnect(disconnected):
                    await self._broadcast_item(item)
                self.item_service.save_state()
                LOGGER.info(
                    "client disconnected id=%s nickname=%s total=%d",
                    disconnected.id,
                    disconnected.nickname,
                    len(self.clients),
                )
                await self._broadcast(UserLeftPacket(type="user_left", id=disconnected.id), exclude=websocket)
                await self._broadcast(
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message=f"{disconnected.nickname} has logged out.",
                        system=True,
                    ),
                    exclude=websocket,
                )

    async def _send_welcome(self, client: ClientConnection) -> None:
        """Send initial world snapshot to a newly connected client."""

        users = [
            RemoteUser(id=other.id, nickname=other.nickname, x=other.x, y=other.y)
            for ws, other in self.clients.items()
            if ws is not client.websocket
        ]
        packet = WelcomePacket(
            type="welcome",
            id=client.id,
            users=users,
            items=[item.model_dump(exclude_none=True) for item in self.items.values()],
            worldConfig={"gridSize": self.grid_size},
            uiDefinitions=self._build_ui_definitions(),
        )
        await self._send(client.websocket, packet)

    def _build_ui_definitions(self) -> dict:
        """Build server-owned UI definitions for item/menu rendering."""

        item_types: list[dict] = []
        for item_type in ITEM_TYPE_SEQUENCE:
            editable = list(ITEM_TYPE_EDITABLE_PROPERTIES.get(item_type, ("title",)))
            property_options: dict[str, list[str]] = {}
            for key in editable:
                options = ITEM_PROPERTY_OPTIONS.get(key)
                if options:
                    property_options[key] = list(options)
            item_types.append(
                {
                    "type": item_type,
                    "label": ITEM_TYPE_LABELS.get(item_type, item_type),
                    "tooltip": ITEM_TYPE_TOOLTIPS.get(item_type),
                    "editableProperties": editable,
                    "propertyOptions": property_options,
                    "propertyMetadata": ITEM_TYPE_PROPERTY_METADATA.get(item_type, {}),
                    "globalProperties": get_item_global_properties(item_type),
                }
            )
        return {
            "itemTypeOrder": list(ITEM_TYPE_SEQUENCE),
            "itemTypes": item_types,
        }

    async def _broadcast_wheel_result_after_delay(
        self,
        client: ClientConnection,
        self_message: str,
        others_message: str,
        delay_seconds: float = 3.0,
    ) -> None:
        """Delay then publish wheel result text to self and other users."""

        await asyncio.sleep(delay_seconds)
        await self._broadcast(
            BroadcastChatMessagePacket(type="chat_message", message=others_message, system=True),
            exclude=client.websocket,
        )
        if client.websocket in self.clients:
            await self._send(
                client.websocket,
                BroadcastChatMessagePacket(type="chat_message", message=self_message, system=True),
            )

    async def _handle_message(self, client: ClientConnection, raw_message: str) -> None:
        """Decode, validate, and route one inbound client packet."""

        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            PACKET_LOGGER.warning("non-json packet from id=%s", client.id)
            return

        try:
            packet = CLIENT_PACKET_ADAPTER.validate_python(payload)
        except ValidationError as exc:
            PACKET_LOGGER.warning("invalid packet from id=%s: %s", client.id, exc)
            return

        if isinstance(packet, UpdatePositionPacket):
            if not self._is_in_bounds(packet.x, packet.y):
                PACKET_LOGGER.warning(
                    "out-of-bounds position ignored id=%s x=%d y=%d grid_size=%d",
                    client.id,
                    packet.x,
                    packet.y,
                    self.grid_size,
                )
                return
            client.x = packet.x
            client.y = packet.y
            await self._broadcast(
                BroadcastPositionPacket(type="update_position", id=client.id, x=client.x, y=client.y),
                exclude=client.websocket,
            )
            carried = self.item_service.find_carried_item(client.id)
            if carried:
                carried.x = client.x
                carried.y = client.y
                carried.updatedAt = self.item_service.now_ms()
                await self._broadcast_item(carried)
            return

        if isinstance(packet, UpdateNicknamePacket):
            requested_nickname = packet.nickname.strip()
            if not requested_nickname:
                await self._send(
                    client.websocket,
                    NicknameResultPacket(
                        type="nickname_result",
                        accepted=False,
                        requestedNickname=packet.nickname,
                        effectiveNickname=client.nickname,
                        reason="Nickname is required.",
                    ),
                )
                return
            old_nickname = client.nickname
            if self._is_nickname_taken(requested_nickname, exclude_client_id=client.id):
                await self._send(
                    client.websocket,
                    NicknameResultPacket(
                        type="nickname_result",
                        accepted=False,
                        requestedNickname=requested_nickname,
                        effectiveNickname=client.nickname,
                        reason="Nickname already in use.",
                    ),
                )
                return
            if requested_nickname == old_nickname:
                await self._send(
                    client.websocket,
                    NicknameResultPacket(
                        type="nickname_result",
                        accepted=True,
                        requestedNickname=requested_nickname,
                        effectiveNickname=client.nickname,
                    ),
                )
                return
            client.nickname = requested_nickname
            if old_nickname == "user...":
                LOGGER.info("user login id=%s nickname=%s", client.id, client.nickname)
            else:
                LOGGER.info("nickname change id=%s old=%s new=%s", client.id, old_nickname, client.nickname)
            await self._send(
                client.websocket,
                NicknameResultPacket(
                    type="nickname_result",
                    accepted=True,
                    requestedNickname=requested_nickname,
                    effectiveNickname=client.nickname,
                ),
            )
            await self._broadcast(
                BroadcastNicknamePacket(type="update_nickname", id=client.id, nickname=client.nickname),
                exclude=client.websocket,
            )
            if old_nickname == "user...":
                await self._broadcast(
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message=f"{client.nickname} has logged in.",
                        system=True,
                    ),
                    exclude=client.websocket,
                )
            else:
                await self._broadcast(
                    BroadcastChatMessagePacket(
                        type="chat_message",
                        message=f"{old_nickname} is now known as {client.nickname}.",
                        system=True,
                    ),
                    exclude=client.websocket,
                )
            self_message = (
                f"Welcome. Logged in as {client.nickname}."
                if old_nickname == "user..."
                else f"You are now known as {client.nickname}."
            )
            await self._send(
                client.websocket,
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=self_message,
                    system=True,
                ),
            )
            return

        if isinstance(packet, ChatMessagePacket):
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=packet.message,
                    senderId=client.id,
                    senderNickname=client.nickname,
                    system=False,
                )
            )
            return

        if isinstance(packet, PingPacket):
            await self._send(
                client.websocket,
                PongPacket(type="pong", clientSentAt=packet.clientSentAt),
            )
            return

        if isinstance(packet, ItemAddPacket):
            item = self.item_service.default_item(client, packet.itemType)
            self.item_service.add_item(item)
            await self._broadcast_item(item)
            self.item_service.save_state()
            LOGGER.info(
                "item created by=%s item_id=%s type=%s title=%s x=%d y=%d",
                client.nickname,
                item.id,
                item.type,
                item.title,
                item.x,
                item.y,
            )
            item_text = f"{item.title} ({self._item_type_label(item)})"
            await self._broadcast(
                BroadcastChatMessagePacket(
                    type="chat_message",
                    message=f"{client.nickname} placed {item_text} at {item.x}, {item.y}.",
                    system=True,
                ),
                exclude=client.websocket,
            )
            await self._send_item_result(
                client,
                True,
                "add",
                f"You placed {item_text} at {item.x}, {item.y}.",
                item.id,
            )
            return

        if isinstance(packet, ItemPickupPacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "pickup", "Item not found.")
                return
            if item.carrierId and item.carrierId != client.id:
                await self._send_item_result(client, False, "pickup", "Item is already being carried.", item.id)
                return
            carried = self.item_service.find_carried_item(client.id)
            if carried and carried.id != item.id:
                await self._send_item_result(client, False, "pickup", "You are already carrying an item.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "pickup", "Item is not on your square.", item.id)
                return
            item.carrierId = client.id
            item.x = client.x
            item.y = client.y
            item.updatedAt = self.item_service.now_ms()
            await self._broadcast_item(item)
            self.item_service.save_state()
            await self._send_item_result(client, True, "pickup", f"Picked up {item.title}.", item.id)
            return

        if isinstance(packet, ItemDropPacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "drop", "Item not found.")
                return
            if item.carrierId != client.id:
                await self._send_item_result(client, False, "drop", "You are not carrying that item.", item.id)
                return
            if not self._is_in_bounds(packet.x, packet.y):
                await self._send_item_result(client, False, "drop", "Drop position is out of bounds.", item.id)
                return
            item.carrierId = None
            item.x = packet.x
            item.y = packet.y
            item.updatedAt = self.item_service.now_ms()
            await self._broadcast_item(item)
            self.item_service.save_state()
            await self._send_item_result(client, True, "drop", f"Dropped {item.title}.", item.id)
            return

        if isinstance(packet, ItemDeletePacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "delete", "Item not found.")
                return
            if item.carrierId and item.carrierId != client.id:
                await self._send_item_result(client, False, "delete", "Item is being carried by another user.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "delete", "Item is not on your square.", item.id)
                return
            LOGGER.info(
                "item deleted by=%s item_id=%s type=%s title=%s",
                client.nickname,
                item.id,
                item.type,
                item.title,
            )
            self.item_service.remove_item(item.id)
            self.item_last_use_ms.pop(item.id, None)
            await self._broadcast(ItemRemovePacket(type="item_remove", itemId=item.id))
            self.item_service.save_state()
            await self._send_item_result(client, True, "delete", f"Deleted {item.title}.", item.id)
            return

        if isinstance(packet, ItemUsePacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "use", "Item not found.")
                return
            if item.carrierId not in (None, client.id):
                await self._send_item_result(client, False, "use", "Item is not available.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "use", "Item is not on your square.", item.id)
                return
            handler = get_item_type_handler(item.type)
            now_ms = self.item_service.now_ms()
            cooldown_ms = get_item_use_cooldown_ms(item.type)
            last_use_ms = self.item_last_use_ms.get(item.id)
            if last_use_ms is not None and now_ms - last_use_ms < cooldown_ms:
                remaining_ms = cooldown_ms - (now_ms - last_use_ms)
                remaining_seconds = max(0.1, round(remaining_ms / 1000, 1))
                await self._send_item_result(
                    client,
                    False,
                    "use",
                    f"{item.title} is on cooldown for {remaining_seconds:.1f} s.",
                    item.id,
                )
                return
            try:
                use_result = handler.use(item, client.nickname, self._format_clock_display_time)
            except ValueError as exc:
                await self._send_item_result(client, False, "use", str(exc), item.id)
                return

            if use_result.updated_params is not None:
                item.params = use_result.updated_params
                item.updatedAt = now_ms
                self.item_service.save_state()
                await self._broadcast_item(item)

            self.item_last_use_ms[item.id] = now_ms
            await self._broadcast(
                BroadcastChatMessagePacket(type="chat_message", message=use_result.others_message, system=True),
                exclude=client.websocket,
            )
            if item.useSound:
                await self._broadcast(
                    ItemUseSoundPacket(
                        type="item_use_sound",
                        itemId=item.id,
                        sound=item.useSound,
                        x=item.x,
                        y=item.y,
                    )
                )
            await self._send_item_result(client, True, "use", use_result.self_message, item.id)
            if use_result.delayed_self_message is not None and use_result.delayed_others_message is not None:
                asyncio.create_task(
                    self._broadcast_wheel_result_after_delay(
                        client=client,
                        self_message=use_result.delayed_self_message,
                        others_message=use_result.delayed_others_message,
                    )
                )
            return

        if isinstance(packet, ItemUpdatePacket):
            item = self.items.get(packet.itemId)
            if not item:
                await self._send_item_result(client, False, "update", "Item not found.")
                return
            if item.carrierId not in (None, client.id):
                await self._send_item_result(client, False, "update", "Item is not available for editing.", item.id)
                return
            if item.carrierId is None and (item.x != client.x or item.y != client.y):
                await self._send_item_result(client, False, "update", "Item is not on your square.", item.id)
                return
            if packet.title is not None:
                title = packet.title.strip()
                if not title:
                    await self._send_item_result(client, False, "update", "Title cannot be empty.", item.id)
                    return
                item.title = title[:80]
            if packet.params:
                next_params = {**item.params, **packet.params}
                handler = get_item_type_handler(item.type)
                try:
                    next_params = handler.validate_update(item, next_params)
                except ValueError as exc:
                    await self._send_item_result(client, False, "update", str(exc), item.id)
                    return
                item.params = next_params
            item.updatedAt = self.item_service.now_ms()
            item.version += 1
            await self._broadcast_item(item)
            self.item_service.save_state()
            await self._send_item_result(client, True, "update", f"Updated {item.title}.", item.id)
            return

        target = self._find_by_id(packet.targetId)
        if not target:
            PACKET_LOGGER.info("signal target not found sender=%s target=%s", client.id, packet.targetId)
            return

        await self._send(
            target.websocket,
            ForwardSignalPacket(
                type="signal",
                senderId=client.id,
                senderNickname=client.nickname,
                x=client.x,
                y=client.y,
                sdp=packet.sdp,
                ice=packet.ice,
            ),
        )

    async def _broadcast(self, packet: object, exclude: ServerConnection | None = None) -> None:
        """Broadcast one packet to all clients except an optional websocket."""

        recipients = [websocket for websocket in self.clients if websocket is not exclude]
        if not recipients:
            return
        await asyncio.gather(*(self._send(websocket, packet) for websocket in recipients))

    async def _send(self, websocket: ServerConnection, packet: object) -> None:
        """Send one packet to one websocket, swallowing per-client send failures."""

        try:
            if hasattr(packet, "model_dump"):
                data = packet.model_dump(exclude_none=True)
            else:
                data = packet
            await websocket.send(json.dumps(data))
        except Exception as exc:  # intentionally broad to keep server alive per client error
            LOGGER.debug("send failure: %s", exc)

    def _find_by_id(self, client_id: str) -> ClientConnection | None:
        """Resolve a client id to an active connection."""

        for client in self.clients.values():
            if client.id == client_id:
                return client
        return None

    @staticmethod
    def _build_ssl_context(cert: str | None, key: str | None) -> ssl.SSLContext | None:
        """Create TLS server context when cert/key are configured."""

        if not cert or not key:
            return None
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=Path(cert), keyfile=Path(key))
        return context


def run() -> None:
    """CLI entrypoint for running the signaling server process."""

    parser = argparse.ArgumentParser(description="chgrid signaling server")
    parser.add_argument("--config", default="config.toml")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--ssl-cert", default=None)
    parser.add_argument("--ssl-key", default=None)
    parser.add_argument("--allow-insecure-ws", action="store_true", default=None)
    args = parser.parse_args()

    config_path = Path(args.config) if args.config else None
    if config_path and not config_path.exists() and args.config == "config.toml":
        config_path = None
    config = load_config(config_path)

    host = args.host or config.server.bind_ip
    port = args.port or config.server.port
    allow_insecure_ws = config.network.allow_insecure_ws
    if args.allow_insecure_ws is True:
        allow_insecure_ws = True

    ssl_cert = args.ssl_cert if args.ssl_cert is not None else config.tls.cert_file or None
    ssl_key = args.ssl_key if args.ssl_key is not None else config.tls.key_file or None
    state_file_value = config.storage.state_file.strip()
    state_file: Path | None = None
    if state_file_value:
        base_dir = config_path.parent if config_path is not None else Path.cwd()
        state_file = Path(state_file_value)
        if not state_file.is_absolute():
            state_file = base_dir / state_file

    if not allow_insecure_ws and (not ssl_cert or not ssl_key):
        raise SystemExit(
            "TLS is required when insecure ws is disabled. Set tls.cert_file/tls.key_file in config.toml."
        )

    logging.basicConfig(
        level=getattr(logging, config.logging.level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    server = SignalingServer(
        host,
        port,
        ssl_cert,
        ssl_key,
        max_message_size=config.network.max_message_bytes,
        state_file=state_file,
        grid_size=config.world.grid_size,
    )
    asyncio.run(server.start())
