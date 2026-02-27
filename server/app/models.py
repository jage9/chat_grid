"""Pydantic packet and entity models shared across server message handling."""

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


class TeleportCompletePacket(BasePacket):
    type: Literal["teleport_complete"]
    x: int
    y: int


class UpdateNicknamePacket(BasePacket):
    type: Literal["update_nickname"]
    nickname: str = Field(min_length=1, max_length=32)


class ChatMessagePacket(BasePacket):
    type: Literal["chat_message"]
    message: str = Field(min_length=1, max_length=500)


class AuthRegisterPacket(BasePacket):
    type: Literal["auth_register"]
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)
    email: str | None = Field(default=None, max_length=320)


class AuthLoginPacket(BasePacket):
    type: Literal["auth_login"]
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=256)


class AuthResumePacket(BasePacket):
    type: Literal["auth_resume"]
    sessionToken: str = Field(min_length=1, max_length=512)


class AuthLogoutPacket(BasePacket):
    type: Literal["auth_logout"]


class PingPacket(BasePacket):
    type: Literal["ping"]
    clientSentAt: int


class ItemAddPacket(BasePacket):
    type: Literal["item_add"]
    itemType: str = Field(min_length=1)


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


class ItemSecondaryUsePacket(BasePacket):
    type: Literal["item_secondary_use"]
    itemId: str


class ItemPianoNotePacket(BasePacket):
    type: Literal["item_piano_note"]
    itemId: str
    keyId: str = Field(min_length=1, max_length=32)
    midi: int = Field(ge=0, le=127)
    on: bool


class ItemPianoRecordingPacket(BasePacket):
    type: Literal["item_piano_recording"]
    itemId: str
    action: Literal["toggle_record", "playback", "stop_playback", "stop_record"]


class ItemUpdatePacket(BasePacket):
    type: Literal["item_update"]
    itemId: str
    title: str | None = Field(default=None, max_length=80)
    params: dict | None = None


ClientPacket = (
    SignalPacket
    | UpdatePositionPacket
    | TeleportCompletePacket
    | UpdateNicknamePacket
    | ChatMessagePacket
    | AuthRegisterPacket
    | AuthLoginPacket
    | AuthResumePacket
    | AuthLogoutPacket
    | PingPacket
    | ItemAddPacket
    | ItemPickupPacket
    | ItemDropPacket
    | ItemDeletePacket
    | ItemUsePacket
    | ItemSecondaryUsePacket
    | ItemPianoNotePacket
    | ItemPianoRecordingPacket
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
    player: RemoteUser
    users: list[RemoteUser]
    items: list[dict] | None = None
    worldConfig: dict | None = None
    uiDefinitions: dict | None = None
    serverInfo: dict | None = None
    auth: dict | None = None


class AuthRequiredPacket(BasePacket):
    type: Literal["auth_required"]
    message: str
    authPolicy: dict | None = None


class AuthResultPacket(BasePacket):
    type: Literal["auth_result"]
    ok: bool
    message: str
    sessionToken: str | None = None
    username: str | None = None
    role: str | None = None
    nickname: str | None = None
    authPolicy: dict | None = None


class UserLeftPacket(BasePacket):
    type: Literal["user_left"]
    id: str


class BroadcastPositionPacket(BasePacket):
    type: Literal["update_position"]
    id: str
    x: int
    y: int


class BroadcastTeleportCompletePacket(BasePacket):
    type: Literal["teleport_complete"]
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
    type: str = Field(min_length=1)
    title: str
    x: int
    y: int
    createdBy: str
    createdAt: int
    updatedAt: int
    version: int
    capabilities: list[str]
    useSound: str | None = None
    emitSound: str | None = None
    params: dict
    carrierId: str | None = None


class PersistedWorldItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    type: str = Field(min_length=1)
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
    action: Literal["add", "pickup", "drop", "delete", "use", "secondary_use", "update"]
    message: str
    itemId: str | None = None


class ItemUseSoundPacket(BasePacket):
    type: Literal["item_use_sound"]
    itemId: str
    sound: str
    x: int
    y: int


class ItemClockAnnouncePacket(BasePacket):
    type: Literal["item_clock_announce"]
    itemId: str
    sounds: list[str]
    x: int
    y: int


class ItemPianoNoteBroadcastPacket(BasePacket):
    type: Literal["item_piano_note"]
    itemId: str
    senderId: str
    keyId: str
    midi: int
    on: bool
    instrument: str
    voiceMode: str
    octave: int
    attack: int
    decay: int
    release: int
    brightness: int
    x: int
    y: int
    emitRange: int


class ItemPianoStatusPacket(BasePacket):
    type: Literal["item_piano_status"]
    itemId: str
    event: Literal[
        "use_mode_entered",
        "record_started",
        "record_paused",
        "record_resumed",
        "record_stopped",
        "playback_started",
        "playback_stopped",
    ]
    recordingState: Literal["idle", "recording", "paused", "playback"] | None = None
