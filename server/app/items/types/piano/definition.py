"""Piano item static metadata and defaults."""

from __future__ import annotations

LABEL = "piano"
TOOLTIP = "Playable keyboard instrument with multiple synth voices."
EDITABLE_PROPERTIES: tuple[str, ...] = (
    "title",
    "instrument",
    "voiceMode",
    "octave",
    "attack",
    "decay",
    "release",
    "brightness",
    "emitRange",
)
CAPABILITIES: tuple[str, ...] = ("editable", "carryable", "deletable", "usable")
USE_SOUND: str | None = None
EMIT_SOUND: str | None = None
USE_COOLDOWN_MS = 1000
EMIT_RANGE = 15
DIRECTIONAL = False
DEFAULT_TITLE = "piano"
DEFAULT_PARAMS: dict = {
    "instrument": "piano",
    "voiceMode": "poly",
    "octave": 0,
    "attack": 15,
    "decay": 45,
    "release": 35,
    "brightness": 55,
    "emitRange": 15,
    "songId": "unterlandersheimweh",
}
PARAM_KEYS: tuple[str, ...] = (
    "instrument",
    "voiceMode",
    "octave",
    "attack",
    "decay",
    "release",
    "brightness",
    "emitRange",
    "songId",
)

INSTRUMENT_OPTIONS: tuple[str, ...] = (
    "piano",
    "electric_piano",
    "guitar",
    "organ",
    "bass",
    "violin",
    "synth_lead",
    "brass",
    "nintendo",
    "drum_kit",
)
VOICE_MODE_OPTIONS: tuple[str, ...] = ("poly", "mono")

DEFAULT_ENVELOPE_BY_INSTRUMENT: dict[str, tuple[int, int, int, int, str, int]] = {
    "piano": (15, 45, 35, 55, "poly", 0),
    "electric_piano": (12, 40, 30, 62, "poly", 0),
    "guitar": (8, 35, 25, 50, "poly", 0),
    "organ": (25, 70, 45, 48, "poly", 0),
    "bass": (2, 24, 18, 34, "mono", -1),
    "violin": (22, 75, 55, 58, "mono", 0),
    "synth_lead": (6, 30, 22, 72, "poly", 0),
    "brass": (10, 45, 30, 60, "mono", 0),
    "nintendo": (1, 24, 15, 85, "poly", 0),
    "drum_kit": (1, 22, 12, 68, "poly", 0),
}

PROPERTY_METADATA: dict[str, dict[str, object]] = {
    "title": {
        "valueType": "text",
        "tooltip": "Display name spoken and shown for this item.",
        "maxLength": 80,
    },
    "songId": {
        "valueType": "text",
        "label": "Song id",
        "tooltip": "Server-managed reference for the piano's recorded or demonstration song.",
    },
    "instrument": {
        "valueType": "list",
        "tooltip": "Instrument voice used when playing this piano.",
        "options": list(INSTRUMENT_OPTIONS),
    },
    "voiceMode": {
        "valueType": "list",
        "tooltip": "Mono plays one note at a time; poly allows chords.",
        "options": list(VOICE_MODE_OPTIONS),
    },
    "octave": {
        "valueType": "number",
        "tooltip": "Shifts played notes in octaves. -1 is one octave down.",
        "range": {"min": -2, "max": 2, "step": 1},
    },
    "attack": {
        "valueType": "number",
        "tooltip": "How quickly notes ramp in. Lower is sharper; higher is softer.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "decay": {
        "valueType": "number",
        "tooltip": "How long notes ring out after the initial hit.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "release": {
        "valueType": "number",
        "tooltip": "How long notes continue after key release.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "brightness": {
        "valueType": "number",
        "tooltip": "Tone brightness; higher values sound brighter.",
        "range": {"min": 0, "max": 100, "step": 1},
    },
    "emitRange": {
        "valueType": "number",
        "tooltip": "Maximum distance in squares where this piano can be heard.",
        "range": {"min": 5, "max": 20, "step": 1},
    },
}
