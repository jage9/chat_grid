"""Single source of truth for item-type module registration."""

from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Callable, Protocol

from ..item_types import ItemUseResult
from ..models import WorldItem


class ItemModule(Protocol):
    """Shape required by item modules consumed by catalog/handlers."""

    LABEL: str
    TOOLTIP: str
    EDITABLE_PROPERTIES: tuple[str, ...]
    CAPABILITIES: tuple[str, ...]
    USE_SOUND: str | None
    EMIT_SOUND: str | None
    USE_COOLDOWN_MS: int
    EMIT_RANGE: int
    DIRECTIONAL: bool
    DEFAULT_TITLE: str
    DEFAULT_PARAMS: dict
    PROPERTY_METADATA: dict[str, dict[str, object]]
    validate_update: Callable[[WorldItem, dict], dict]
    use_item: Callable[[WorldItem, str, Callable[[dict], str]], ItemUseResult]
    secondary_use_item: Callable[[WorldItem, str, Callable[[dict], str]], ItemUseResult] | None


@dataclass(frozen=True)
class ItemTypePlugin:
    """Runtime-loaded item type plugin metadata."""

    type: str
    order: int
    module: ItemModule


def _load_item_type_plugins() -> list[ItemTypePlugin]:
    """Discover and load item-type plugins from `items/types/*/plugin.py`."""

    base_dir = Path(__file__).resolve().parent / "types"
    plugins: list[ItemTypePlugin] = []
    if not base_dir.exists():
        raise RuntimeError(f"item type plugin directory missing: {base_dir}")

    for entry in sorted(base_dir.iterdir(), key=lambda path: path.name):
        if not entry.is_dir():
            continue
        if entry.name.startswith("__"):
            continue
        plugin_file = entry / "plugin.py"
        if not plugin_file.exists():
            # Ignore stale/partial directories (for example, leftover cache folders).
            continue
        plugin_module = import_module(f"{__package__}.types.{entry.name}.plugin")
        raw_plugin = getattr(plugin_module, "ITEM_TYPE_PLUGIN", None)
        if not isinstance(raw_plugin, dict):
            raise RuntimeError(f"invalid ITEM_TYPE_PLUGIN in {plugin_module.__name__}")
        type_id = raw_plugin.get("type")
        order = raw_plugin.get("order")
        module = raw_plugin.get("module")
        if not isinstance(type_id, str) or not type_id.strip():
            raise RuntimeError(f"plugin {plugin_module.__name__} missing string 'type'")
        if not isinstance(order, int):
            raise RuntimeError(f"plugin {plugin_module.__name__} missing int 'order'")
        if module is None:
            raise RuntimeError(f"plugin {plugin_module.__name__} missing 'module'")
        plugins.append(ItemTypePlugin(type=type_id.strip(), order=order, module=module))

    if not plugins:
        raise RuntimeError("no item type plugins discovered")

    seen: set[str] = set()
    for plugin in plugins:
        if plugin.type in seen:
            raise RuntimeError(f"duplicate item type plugin registered: {plugin.type}")
        seen.add(plugin.type)

    plugins.sort(key=lambda plugin: (plugin.order, plugin.type))
    return plugins


ITEM_PLUGINS: tuple[ItemTypePlugin, ...] = tuple(_load_item_type_plugins())
ITEM_TYPE_ORDER: tuple[str, ...] = tuple(plugin.type for plugin in ITEM_PLUGINS)
ITEM_MODULES: dict[str, ItemModule] = {plugin.type: plugin.module for plugin in ITEM_PLUGINS}
