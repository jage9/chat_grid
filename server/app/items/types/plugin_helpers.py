"""Helpers for composing item plugin module surfaces."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from ..emit_validation import (
    EMIT_EFFECT_OPTIONS,
    validate_emit_direction,
    validate_emit_properties,
)


SHARED_EMIT_EDITABLE_PROPERTIES: tuple[str, ...] = (
    "emitSound",
    "emitVolume",
    "emitRange",
    "emitSoundSpeed",
    "emitSoundTempo",
    "emitInitialDelay",
    "emitLoopDelay",
    "emitEffect",
    "emitEffectValue",
    "directional",
    "facing",
)
SHARED_EMIT_PARAM_KEYS: tuple[str, ...] = SHARED_EMIT_EDITABLE_PROPERTIES


def _shared_emit_metadata() -> dict[str, dict[str, object]]:
    """Return metadata for the standard editable emitter controls."""

    sound_condition = {"emitSound": "!"}
    return {
        "emitSound": {
            "valueType": "sound",
            "label": "Emitted sound",
            "tooltip": "Looping sound emitted by this item. Filename assumes sounds folder, or use a full URL.",
            "maxLength": 2048,
        },
        "emitVolume": {
            "valueType": "number",
            "tooltip": "Emitted sound volume percent.",
            "range": {"min": 0, "max": 100, "step": 1},
            "visibleWhen": sound_condition,
        },
        "emitRange": {
            "valueType": "number",
            "tooltip": "Maximum distance in squares where emitted sound can be heard.",
            "range": {"min": 1, "max": 20, "step": 1},
            "visibleWhen": sound_condition,
        },
        "emitSoundSpeed": {
            "valueType": "number",
            "tooltip": "Playback speed and pitch percent for emitted sound. 50 is normal.",
            "range": {"min": 0, "max": 100, "step": 0.1},
            "visibleWhen": sound_condition,
        },
        "emitSoundTempo": {
            "valueType": "number",
            "tooltip": "Playback tempo percent for emitted sound. 50 is normal.",
            "range": {"min": 0, "max": 100, "step": 0.1},
            "visibleWhen": sound_condition,
        },
        "emitInitialDelay": {
            "valueType": "number",
            "tooltip": "Delay in seconds before emitted audio starts.",
            "range": {"min": 0, "max": 300, "step": 0.1},
            "visibleWhen": sound_condition,
        },
        "emitLoopDelay": {
            "valueType": "number",
            "tooltip": "Delay in seconds between each playing of emitted audio.",
            "range": {"min": 0, "max": 300, "step": 0.1},
            "visibleWhen": sound_condition,
        },
        "emitEffect": {
            "valueType": "list",
            "tooltip": "Effect applied to emitted sound.",
            "options": list(EMIT_EFFECT_OPTIONS),
            "visibleWhen": sound_condition,
        },
        "emitEffectValue": {
            "valueType": "number",
            "tooltip": "Amount for the selected emitted sound effect.",
            "range": {"min": 0, "max": 100, "step": 0.1},
            "visibleWhen": {"emitSound": "!", "emitEffect": "!off"},
        },
        "directional": {
            "valueType": "boolean",
            "tooltip": "Whether emitted sound favors the item's facing direction.",
            "visibleWhen": sound_condition,
        },
        "facing": {
            "valueType": "number",
            "tooltip": "Facing direction in degrees used when directional sound is on.",
            "range": {"min": 0, "max": 360, "step": 1},
            "visibleWhen": {"emitSound": "!", "directional": True},
        },
    }


def _merge_unique(*groups: tuple[str, ...]) -> tuple[str, ...]:
    """Merge ordered string groups without introducing duplicate property keys."""

    merged: list[str] = []
    for group in groups:
        for key in group:
            if key not in merged:
                merged.append(key)
    return tuple(merged)


def _compose_shared_emit_metadata(
    authored_metadata: dict[str, dict[str, object]],
    *,
    always_visible_keys: tuple[str, ...] = (),
) -> dict[str, dict[str, object]]:
    """Merge shared metadata while preserving authored labels, ranges, and copy."""

    metadata = {key: dict(value) for key, value in _shared_emit_metadata().items()}
    metadata.update({key: dict(value) for key, value in authored_metadata.items()})

    # Authored widget/elevator metadata predates the shared sound visibility rule.
    # Add that rule here so every eligible plugin exposes the same control behavior.
    dependent_keys = set(SHARED_EMIT_EDITABLE_PROPERTIES) - {"emitSound"}
    for key in dependent_keys:
        value = dict(metadata[key])
        raw_visible_when = value.get("visibleWhen")
        visible_when = (
            dict(raw_visible_when) if isinstance(raw_visible_when, dict) else {}
        )
        if key in always_visible_keys:
            visible_when.pop("emitSound", None)
            if visible_when:
                value["visibleWhen"] = visible_when
            else:
                value.pop("visibleWhen", None)
            metadata[key] = value
            continue
        visible_when["emitSound"] = "!"
        if key == "facing":
            visible_when["directional"] = True
        elif key == "emitEffectValue":
            visible_when["emitEffect"] = "!off"
        value["visibleWhen"] = visible_when
        metadata[key] = value
    return metadata


def build_item_module(
    definition: Any,
    *,
    validate_update: Any,
    use_item: Any,
    secondary_use_item: Any = None,
    include_emit_controls: bool = True,
    validate_shared_emit: bool = True,
    always_visible_emit_keys: tuple[str, ...] = (),
) -> Any:
    """Compose a plugin module-like object from split definition/validator/actions files."""

    exports: dict[str, Any] = {
        name: getattr(definition, name) for name in dir(definition) if name.isupper()
    }
    exports["validate_update"] = validate_update
    exports["use_item"] = use_item
    if secondary_use_item is not None:
        exports["secondary_use_item"] = secondary_use_item

    if include_emit_controls:
        authored_defaults = dict(getattr(definition, "DEFAULT_PARAMS", {}))
        shared_defaults = {
            "directional": bool(getattr(definition, "DIRECTIONAL", False)),
            "facing": 0,
            "emitRange": getattr(definition, "EMIT_RANGE", 15),
            "emitVolume": 100,
            "emitSoundSpeed": 50,
            "emitSoundTempo": 50,
            "emitInitialDelay": 0,
            "emitLoopDelay": 0,
            "emitEffect": "off",
            "emitEffectValue": 50,
            "emitSound": getattr(definition, "EMIT_SOUND", None) or "",
        }
        shared_defaults.update(authored_defaults)
        exports["DEFAULT_PARAMS"] = shared_defaults
        exports["PARAM_KEYS"] = _merge_unique(
            tuple(getattr(definition, "PARAM_KEYS", ())), SHARED_EMIT_PARAM_KEYS
        )
        exports["EDITABLE_PROPERTIES"] = _merge_unique(
            tuple(
                key
                for key in getattr(definition, "EDITABLE_PROPERTIES", ())
                if key not in SHARED_EMIT_EDITABLE_PROPERTIES
            ),
            SHARED_EMIT_EDITABLE_PROPERTIES,
        )
        exports["PROPERTY_METADATA"] = _compose_shared_emit_metadata(
            getattr(definition, "PROPERTY_METADATA", {}),
            always_visible_keys=always_visible_emit_keys,
        )

        if validate_shared_emit:
            authored_validate_update = exports["validate_update"]

            def validate_with_shared_emit(item: Any, next_params: dict) -> dict:
                """Validate shared emitter fields before an item-specific validator."""

                emit_params = {}
                emit_params.update(validate_emit_direction(item.params, next_params))
                emit_params.update(validate_emit_properties(item.params, next_params))
                composed_params = {**next_params, **emit_params}
                validated = authored_validate_update(item, composed_params)
                # Item validators may have captured their original PARAM_KEYS tuple;
                # merge shared fields back after their item-specific filtering.
                return {**validated, **emit_params}

            exports["validate_update"] = validate_with_shared_emit
    return SimpleNamespace(**exports)
