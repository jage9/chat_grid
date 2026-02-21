from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import ssl
import uuid
from pathlib import Path
from typing import Literal

from pydantic import ValidationError, TypeAdapter
from websockets.asyncio.server import ServerConnection, serve

from .client import ClientConnection
from .config import load_config
from .item_catalog import get_item_use_cooldown_ms
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
RADIO_EFFECT_IDS = {"reverb", "echo", "flanger", "high_pass", "low_pass", "off"}


class SignalingServer:
    def __init__(
        self,
        host: str,
        port: int,
        ssl_cert: str | None,
        ssl_key: str | None,
        max_message_size: int = 2_000_000,
        state_file: Path | None = None,
    ):
        self.host = host
        self.port = port
        self.max_message_size = max_message_size
        self._ssl_context = self._build_ssl_context(ssl_cert, ssl_key)
        self.clients: dict[ServerConnection, ClientConnection] = {}
        self.item_service = ItemService(state_file=state_file)
        self.item_last_use_ms: dict[str, int] = {}

    @property
    def items(self) -> dict[str, WorldItem]:
        return self.item_service.items

    def _nickname_key(self, nickname: str) -> str:
        return nickname.casefold()

    def _is_nickname_taken(self, nickname: str, exclude_client_id: str | None = None) -> bool:
        wanted = self._nickname_key(nickname)
        for other in self.clients.values():
            if exclude_client_id is not None and other.id == exclude_client_id:
                continue
            if self._nickname_key(other.nickname) == wanted:
                return True
        return False

    @staticmethod
    def _item_type_label(item: WorldItem) -> str:
        return "radio" if item.type == "radio_station" else item.type

    async def _send_item_result(
        self,
        client: ClientConnection,
        ok: bool,
        action: Literal["add", "pickup", "drop", "delete", "use", "update"],
        message: str,
        item_id: str | None = None,
    ) -> None:
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
        await self._broadcast(ItemUpsertPacket(type="item_upsert", item=item))

    async def start(self) -> None:
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
                LOGGER.info("client disconnected id=%s total=%d", disconnected.id, len(self.clients))
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
        )
        await self._send(client.websocket, packet)

    async def _broadcast_wheel_result_after_delay(
        self,
        client: ClientConnection,
        self_message: str,
        others_message: str,
        delay_seconds: float = 3.0,
    ) -> None:
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
            if item.type not in {"radio_station", "dice", "wheel"}:
                await self._send_item_result(client, False, "use", "This item cannot be used yet.", item.id)
                return
            now_ms = self.item_service.now_ms()
            cooldown_ms = get_item_use_cooldown_ms(item.type)
            last_use_ms = self.item_last_use_ms.get(item.id)
            if last_use_ms is not None and now_ms - last_use_ms < cooldown_ms:
                remaining_ms = cooldown_ms - (now_ms - last_use_ms)
                await self._send_item_result(
                    client,
                    False,
                    "use",
                    f"{item.title} is on cooldown for {max(1, remaining_ms)} ms.",
                    item.id,
                )
                return
            self.item_last_use_ms[item.id] = now_ms
            delayed_wheel_self_result: str | None = None
            delayed_wheel_others_result: str | None = None
            if item.type == "radio_station":
                enabled_value = item.params.get("enabled", True)
                if isinstance(enabled_value, bool):
                    currently_enabled = enabled_value
                elif isinstance(enabled_value, (int, float)):
                    currently_enabled = bool(enabled_value)
                elif isinstance(enabled_value, str):
                    currently_enabled = enabled_value.strip().lower() in {"on", "true", "1", "yes"}
                else:
                    currently_enabled = True
                next_enabled = not currently_enabled
                item.params = {**item.params, "enabled": next_enabled}
                item.updatedAt = now_ms
                self.item_service.save_state()
                await self._broadcast_item(item)
                state_text = "on" if next_enabled else "off"
                others_message = f"{client.nickname} turns {state_text} {item.title}."
                self_message = f"You turn {state_text} {item.title}."
            elif item.type == "dice":
                try:
                    sides = max(1, min(100, int(item.params.get("sides", 6))))
                    number = max(1, min(100, int(item.params.get("number", 2))))
                except (TypeError, ValueError):
                    sides = 6
                    number = 2
                rolls = [random.randint(1, sides) for _ in range(number)]
                total = sum(rolls)
                others_message = (
                    f"{client.nickname} rolled {item.title}: {', '.join(str(value) for value in rolls)} (total {total})."
                )
                self_message = f"You rolled {item.title}: {', '.join(str(value) for value in rolls)} (total {total})."
            else:
                spaces_raw = item.params.get("spaces", "")
                if isinstance(spaces_raw, str):
                    spaces = [token.strip() for token in spaces_raw.split(",") if token.strip()]
                elif isinstance(spaces_raw, list):
                    spaces = [str(token).strip() for token in spaces_raw if str(token).strip()]
                else:
                    spaces = []
                if not spaces:
                    await self._send_item_result(
                        client,
                        False,
                        "use",
                        "wheel spaces must contain at least one comma-delimited value.",
                        item.id,
                    )
                    return
                landed = random.choice(spaces)
                others_message = f"{client.nickname} spins {item.title}."
                self_message = f"You spin {item.title}."
                delayed_wheel_self_result = str(landed)
                delayed_wheel_others_result = f"{client.nickname}: {landed}"
            await self._broadcast(
                BroadcastChatMessagePacket(type="chat_message", message=others_message, system=True),
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
            await self._send_item_result(client, True, "use", self_message, item.id)
            if delayed_wheel_self_result is not None and delayed_wheel_others_result is not None:
                asyncio.create_task(
                    self._broadcast_wheel_result_after_delay(
                        client=client,
                        self_message=delayed_wheel_self_result,
                        others_message=delayed_wheel_others_result,
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
                if item.type == "dice":
                    try:
                        sides = int(next_params.get("sides", 6))
                        number = int(next_params.get("number", 2))
                    except (TypeError, ValueError):
                        await self._send_item_result(client, False, "update", "Dice values must be numbers.", item.id)
                        return
                    if not (1 <= sides <= 100 and 1 <= number <= 100):
                        await self._send_item_result(
                            client, False, "update", "Dice sides and number must be between 1 and 100.", item.id
                        )
                        return
                    next_params["sides"] = sides
                    next_params["number"] = number
                if item.type == "wheel":
                    spaces_raw = next_params.get("spaces", "")
                    if not isinstance(spaces_raw, str):
                        await self._send_item_result(
                            client, False, "update", "spaces must be a comma-delimited string.", item.id
                        )
                        return
                    spaces = [token.strip() for token in spaces_raw.split(",") if token.strip()]
                    if not spaces:
                        await self._send_item_result(
                            client,
                            False,
                            "update",
                            "spaces must include at least one value, separated by commas.",
                            item.id,
                        )
                        return
                    if len(spaces) > 100:
                        await self._send_item_result(client, False, "update", "spaces supports up to 100 values.", item.id)
                        return
                    if any(len(token) > 80 for token in spaces):
                        await self._send_item_result(client, False, "update", "each space must be 80 chars or less.", item.id)
                        return
                    next_params["spaces"] = ", ".join(spaces)
                if item.type == "radio_station":
                    stream_url = str(next_params.get("streamUrl", "")).strip()
                    previous_stream_url = str(item.params.get("streamUrl", "")).strip()
                    next_params["streamUrl"] = stream_url
                    enabled_value = next_params.get("enabled", True)
                    if isinstance(enabled_value, bool):
                        enabled = enabled_value
                    elif isinstance(enabled_value, (int, float)):
                        enabled = bool(enabled_value)
                    elif isinstance(enabled_value, str):
                        token = enabled_value.strip().lower()
                        if token in {"on", "true", "1", "yes"}:
                            enabled = True
                        elif token in {"off", "false", "0", "no"}:
                            enabled = False
                        else:
                            await self._send_item_result(
                                client, False, "update", "enabled must be true/false or on/off.", item.id
                            )
                            return
                    else:
                        await self._send_item_result(
                            client, False, "update", "enabled must be true/false or on/off.", item.id
                        )
                        return
                    if stream_url and stream_url != previous_stream_url:
                        enabled = True
                    if not stream_url:
                        enabled = False
                    next_params["enabled"] = enabled

                    try:
                        volume = int(next_params.get("volume", 50))
                    except (TypeError, ValueError):
                        await self._send_item_result(client, False, "update", "volume must be a number.", item.id)
                        return
                    if not (0 <= volume <= 100):
                        await self._send_item_result(
                            client, False, "update", "volume must be between 0 and 100.", item.id
                        )
                        return
                    next_params["volume"] = volume

                    effect = str(next_params.get("effect", "off")).strip().lower()
                    if effect not in RADIO_EFFECT_IDS:
                        await self._send_item_result(
                            client,
                            False,
                            "update",
                            "effect must be one of reverb, echo, flanger, high_pass, low_pass, off.",
                            item.id,
                        )
                        return
                    next_params["effect"] = effect

                    try:
                        effect_value = int(next_params.get("effectValue", 50))
                    except (TypeError, ValueError):
                        await self._send_item_result(client, False, "update", "effectValue must be a number.", item.id)
                        return
                    if not (0 <= effect_value <= 100):
                        await self._send_item_result(
                            client, False, "update", "effectValue must be between 0 and 100.", item.id
                        )
                        return
                    next_params["effectValue"] = round(effect_value / 5) * 5
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
        for websocket in list(self.clients.keys()):
            if websocket is exclude:
                continue
            await self._send(websocket, packet)

    async def _send(self, websocket: ServerConnection, packet: object) -> None:
        try:
            if hasattr(packet, "model_dump"):
                data = packet.model_dump(exclude_none=True)
            else:
                data = packet
            await websocket.send(json.dumps(data))
        except Exception as exc:  # intentionally broad to keep server alive per client error
            LOGGER.debug("send failure: %s", exc)

    def _find_by_id(self, client_id: str) -> ClientConnection | None:
        for client in self.clients.values():
            if client.id == client_id:
                return client
        return None

    @staticmethod
    def _build_ssl_context(cert: str | None, key: str | None) -> ssl.SSLContext | None:
        if not cert or not key:
            return None
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=Path(cert), keyfile=Path(key))
        return context


def run() -> None:
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
    )
    asyncio.run(server.start())
