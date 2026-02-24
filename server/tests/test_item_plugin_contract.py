from __future__ import annotations

from pathlib import Path

from app.items.registry import ITEM_PLUGINS


def test_item_plugins_expose_expected_contract() -> None:
    for plugin in ITEM_PLUGINS:
        module = plugin.module
        assert isinstance(plugin.type, str) and plugin.type
        assert isinstance(plugin.order, int)
        assert callable(getattr(module, "validate_update", None))
        assert callable(getattr(module, "use_item", None))
        assert isinstance(getattr(module, "LABEL", ""), str)
        assert isinstance(getattr(module, "TOOLTIP", ""), str)
        assert isinstance(getattr(module, "EDITABLE_PROPERTIES", ()), tuple)
        assert isinstance(getattr(module, "CAPABILITIES", ()), tuple)
        assert isinstance(getattr(module, "DEFAULT_PARAMS", {}), dict)
        assert isinstance(getattr(module, "PROPERTY_METADATA", {}), dict)


def test_item_plugin_folders_have_required_files() -> None:
    base_dir = Path(__file__).resolve().parents[1] / "app" / "items" / "types"
    for plugin in ITEM_PLUGINS:
        type_dir = base_dir / plugin.type
        assert type_dir.is_dir()
        assert (type_dir / "definition.py").is_file()
        assert (type_dir / "validator.py").is_file()
        assert (type_dir / "actions.py").is_file()
        assert (type_dir / "plugin.py").is_file()
