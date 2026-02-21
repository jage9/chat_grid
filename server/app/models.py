from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class BasePacket(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: str


class SignalPacket(BasePacket):
    type: Literal["signal"]
    targetId: str
    sdp: dict | None = None
    ice: dict | None = None


class UpdatePositionPacket(BasePacket):
    type: Literal["update_position"]
    x: int
    y: int


class UpdateNicknamePacket(BasePacket):
    type: Literal["update_nickname"]
    nickname: str = Field(min_length=1, max_length=32)


class ChatMessagePacket(BasePacket):
    type: Literal["chat_message"]
    message: str = Field(min_length=1, max_length=500)


class PingPacket(BasePacket):
    type: Literal["ping"]
    clientSentAt: int


class ItemAddPacket(BasePacket):
    type: Literal["item_add"]
    itemType: Literal["radio_station", "dice", "wheel"]


class ItemPickupPacket(BasePacket):
    type: Literal["item_pickup"]
    itemId: str


class ItemDropPacket(BasePacket):
    type: Literal["item_drop"]
    itemId: str
    x: int
    y: int


class ItemDeletePacket(BasePacket):
    type: Literal["item_delete"]
    itemId: str


class ItemUsePacket(BasePacket):
    type: Literal["item_use"]
    itemId: str


class ItemUpdatePacket(BasePacket):
    type: Literal["item_update"]
    itemId: str
    title: str | None = Field(default=None, max_length=80)
    params: dict | None = None


ClientPacket = (
    SignalPacket
    | UpdatePositionPacket
    | UpdateNicknamePacket
    | ChatMessagePacket
    | PingPacket
    | ItemAddPacket
    | ItemPickupPacket
    | ItemDropPacket
    | ItemDeletePacket
    | ItemUsePacket
    | ItemUpdatePacket
)


class RemoteUser(BaseModel):
    id: str
    nickname: str
    x: int
    y: int


class WelcomePacket(BasePacket):
    type: Literal["welcome"]
    id: str
    users: list[RemoteUser]
    items: list[dict] | None = None


class UserLeftPacket(BasePacket):
    type: Literal["user_left"]
    id: str


class BroadcastPositionPacket(BasePacket):
    type: Literal["update_position"]
    id: str
    x: int
    y: int


class BroadcastNicknamePacket(BasePacket):
    type: Literal["update_nickname"]
    id: str
    nickname: str


class ForwardSignalPacket(BasePacket):
    type: Literal["signal"]
    senderId: str
    senderNickname: str
    x: int
    y: int
    sdp: dict | None = None
    ice: dict | None = None


class BroadcastChatMessagePacket(BasePacket):
    type: Literal["chat_message"]
    message: str
    senderId: str | None = None
    senderNickname: str | None = None
    system: bool = False


class PongPacket(BasePacket):
    type: Literal["pong"]
    clientSentAt: int


class NicknameResultPacket(BasePacket):
    type: Literal["nickname_result"]
    accepted: bool
    requestedNickname: str
    effectiveNickname: str
    reason: str | None = None


class WorldItem(BaseModel):
    id: str
    type: Literal["radio_station", "dice", "wheel"]
    title: str
    x: int
    y: int
    createdBy: str
    createdAt: int
    updatedAt: int
    version: int
    capabilities: list[str]
    useSound: str | None = None
    params: dict
    carrierId: str | None = None


class PersistedWorldItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    type: Literal["radio_station", "dice", "wheel"]
    title: str
    x: int
    y: int
    createdBy: str
    createdAt: int
    updatedAt: int
    version: int
    params: dict
    carrierId: str | None = None


class ItemUpsertPacket(BasePacket):
    type: Literal["item_upsert"]
    item: WorldItem


class ItemRemovePacket(BasePacket):
    type: Literal["item_remove"]
    itemId: str


class ItemActionResultPacket(BasePacket):
    type: Literal["item_action_result"]
    ok: bool
    action: Literal["add", "pickup", "drop", "delete", "use", "update"]
    message: str
    itemId: str | None = None


class ItemUseSoundPacket(BasePacket):
    type: Literal["item_use_sound"]
    itemId: str
    sound: str
    x: int
    y: int
