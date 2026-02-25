"""Radio item static metadata and defaults."""

from __future__ import annotations

LABEL = "radio"
TOOLTIP = "Can play stations from the Internet. Tune multiple to the same station and they will sync up."
EDITABLE_PROPERTIES: tuple[str, ...] = (
    "title",
    "streamUrl",
    "enabled",
    "mediaVolume",
    "mediaChannel",
    "mediaEffect",
    "mediaEffectValue",
    "facing",
    "emitRange",
)
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 10
DIRECTIONAL = True
DEFAULT_TITLE = "radio"
DEFAULT_PARAMS: dict = {
    "streamUrl": "",
    "enabled": True,
    "mediaVolume": 50,
    "mediaChannel": "stereo",
    "mediaEffect": "off",
    "mediaEffectValue": 50,
    "stationName": "",
    "nowPlaying": "",
    "facing": 0,
    "emitRange": 10,
}
PARAM_KEYS: tuple[str, ...] = (
    "streamUrl",
    "enabled",
    "mediaVolume",
    "mediaChannel",
    "mediaEffect",
    "mediaEffectValue",
    "stationName",
    "nowPlaying",
    "facing",
    "emitRange",
)

CHANNEL_OPTIONS: tuple[str, ...] = ("stereo", "mono", "left", "right")
EFFECT_OPTIONS: tuple[str, ...] = ("reverb", "echo", "flanger", "high_pass", "low_pass", "off")

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item.", "maxLength": 80},
    "streamUrl": {"valueType": "text", "tooltip": "Audio stream URL used by this radio.", "maxLength": 2048},
    "enabled": {"valueType": "boolean", "tooltip": "Turns playback on or off for this radio."},
    "mediaVolume": {
        "valueType": "number",
        "tooltip": "Playback media volume percent for this radio.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "mediaChannel": {"valueType": "list", "tooltip": "Select how the station audio channels are rendered.", "options": list(CHANNEL_OPTIONS)},
    "mediaEffect": {"valueType": "list", "tooltip": "Select the active radio effect.", "options": list(EFFECT_OPTIONS)},
    "mediaEffectValue": {
        "valueType": "number",
        "tooltip": "Amount for the selected effect.",
        "range": {"min": 0, "max": 100, "step": 0.1},
        "visibleWhen": {"mediaEffect": "!off"},
    },
    "stationName": {"valueType": "text", "tooltip": "Detected station name from stream metadata."},
    "nowPlaying": {"valueType": "text", "tooltip": "Detected current track/title from stream metadata."},
    "facing": {
        "valueType": "number",
        "tooltip": "Facing direction in degrees used for directional emit.",
        "range": {"min": 0, "max": 360, "step": 1},
        "visibleWhen": {"directional": True},
    },
    "emitRange": {
        "valueType": "number",
        "tooltip": "Maximum distance in squares for this radio's emitted audio.",
        "range": {"min": 5, "max": 20, "step": 1},
    },
}
