"""Piano item schema metadata and behavior."""

from __future__ import annotations

from typing import Callable

from ..item_types import ItemUseResult
from ..models import WorldItem

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
    "title": {"valueType": "text", "tooltip": "Display name spoken and shown for this item.", "maxLength": 80},
    "instrument": {"valueType": "list", "tooltip": "Instrument voice used when playing this piano."},
    "voiceMode": {"valueType": "list", "tooltip": "Mono plays one note at a time; poly allows chords."},
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


def validate_update(_item: WorldItem, next_params: dict) -> dict:
    """Validate and normalize piano params."""

    # Song references are server-managed and not directly editable from client updates.
    preserved_song_id = _item.params.get("songId")
    next_params.pop("songId", None)

    instrument = str(next_params.get("instrument", "piano")).strip().lower()
    if instrument not in INSTRUMENT_OPTIONS:
        raise ValueError(f"instrument must be one of: {', '.join(INSTRUMENT_OPTIONS)}.")
    previous_instrument = str(_item.params.get("instrument", "piano")).strip().lower()
    next_params["instrument"] = instrument

    voice_mode = str(next_params.get("voiceMode", _item.params.get("voiceMode", "poly"))).strip().lower()
    if voice_mode not in VOICE_MODE_OPTIONS:
        raise ValueError("voiceMode must be one of: poly, mono.")
    next_params["voiceMode"] = voice_mode

    try:
        octave = int(next_params.get("octave", _item.params.get("octave", 0)))
    except (TypeError, ValueError) as exc:
        raise ValueError("octave must be an integer between -2 and 2.") from exc
    if not (-2 <= octave <= 2):
        raise ValueError("octave must be between -2 and 2.")
    next_params["octave"] = octave

    try:
        attack = int(next_params.get("attack", 15))
    except (TypeError, ValueError) as exc:
        raise ValueError("attack must be an integer between 0 and 100.") from exc
    if not (0 <= attack <= 100):
        raise ValueError("attack must be between 0 and 100.")
    try:
        decay = int(next_params.get("decay", 45))
    except (TypeError, ValueError) as exc:
        raise ValueError("decay must be an integer between 0 and 100.") from exc
    if not (0 <= decay <= 100):
        raise ValueError("decay must be between 0 and 100.")

    try:
        release = int(next_params.get("release", 35))
    except (TypeError, ValueError) as exc:
        raise ValueError("release must be an integer between 0 and 100.") from exc
    if not (0 <= release <= 100):
        raise ValueError("release must be between 0 and 100.")

    try:
        brightness = int(next_params.get("brightness", 55))
    except (TypeError, ValueError) as exc:
        raise ValueError("brightness must be an integer between 0 and 100.") from exc
    if not (0 <= brightness <= 100):
        raise ValueError("brightness must be between 0 and 100.")

    # When instrument changes, reset envelope to instrument-appropriate defaults.
    if instrument != previous_instrument:
        attack, decay, release, brightness, voice_mode, octave = DEFAULT_ENVELOPE_BY_INSTRUMENT.get(
            instrument, (15, 45, 35, 55, "poly", 0)
        )
        next_params["voiceMode"] = voice_mode
        next_params["octave"] = octave
    next_params["attack"] = attack
    next_params["decay"] = decay
    next_params["release"] = release
    next_params["brightness"] = brightness

    try:
        emit_range = int(next_params.get("emitRange", 15))
    except (TypeError, ValueError) as exc:
        raise ValueError("emitRange must be an integer between 5 and 20.") from exc
    if not (5 <= emit_range <= 20):
        raise ValueError("emitRange must be between 5 and 20.")
    next_params["emitRange"] = emit_range

    if isinstance(preserved_song_id, str) and preserved_song_id.strip():
        next_params["songId"] = preserved_song_id.strip()

    return next_params


def use_item(item: WorldItem, nickname: str, _clock_formatter: Callable[[dict], str]) -> ItemUseResult:
    """Enter piano play mode for the user who used the item."""

    return ItemUseResult(
        self_message=f"You begin playing {item.title}.",
        others_message=f"{nickname} begins playing {item.title}.",
    )
