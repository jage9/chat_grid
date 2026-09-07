"""Server-owned UI metadata for menus and server-backed command surfaces."""

from __future__ import annotations

from typing import TypedDict


class AdminMenuActionDefinition(TypedDict):
    """Server-authored metadata for one admin root action."""

    id: str
    label: str
    tooltip: str
    permission: str


class ItemManagementActionDefinition(TypedDict):
    """Server-authored metadata for one item-management action."""

    id: str
    label: str
    tooltip: str
    anyPermission: str
    ownPermission: str


class MainModeServerCommandDefinition(TypedDict):
    """Server-authored metadata for one server-backed main-mode command."""

    id: str
    label: str
    tooltip: str


ADMIN_MENU_ACTION_DEFINITIONS: tuple[AdminMenuActionDefinition, ...] = (
    {
        "id": "list_users",
        "label": "List users",
        "tooltip": "List registered users with role, status, and last-seen presence.",
        "permission": "user.list",
    },
    {
        "id": "manage_roles",
        "label": "Role management",
        "tooltip": "Manage roles and their permission sets.",
        "permission": "role.manage",
    },
    {
        "id": "change_user_role",
        "label": "Change user role",
        "tooltip": "Change a user's assigned role.",
        "permission": "user.change_role",
    },
    {
        "id": "ban_user",
        "label": "Ban user",
        "tooltip": "Disable a user account.",
        "permission": "user.ban_unban",
    },
    {
        "id": "unban_user",
        "label": "Unban user",
        "tooltip": "Re-enable a disabled user account.",
        "permission": "user.ban_unban",
    },
    {
        "id": "delete_account",
        "label": "Delete account",
        "tooltip": "Delete a user account permanently.",
        "permission": "account.delete.any",
    },
)

ITEM_MANAGEMENT_ACTION_DEFINITIONS: tuple[ItemManagementActionDefinition, ...] = (
    {
        "id": "transfer",
        "label": "Transfer item",
        "tooltip": "Transfer this item to another user.",
        "anyPermission": "item.transfer.any",
        "ownPermission": "item.transfer.own",
    },
    {
        "id": "delete",
        "label": "Delete item",
        "tooltip": "Delete this item from the world.",
        "anyPermission": "item.delete.any",
        "ownPermission": "item.delete.own",
    },
)

MAIN_MODE_SERVER_COMMAND_DEFINITIONS: tuple[MainModeServerCommandDefinition, ...] = (
    {
        "id": "openWorldBuilder",
        "label": "Open World Builder",
        "tooltip": "Create and manage world structures when permitted.",
    },
    {"id": "addItem", "label": "Add item", "tooltip": "Open the add-item menu."},
    {
        "id": "useItem",
        "label": "Use item",
        "tooltip": "Use item.",
    },
    {
        "id": "secondaryUseItem",
        "label": "Secondary item action",
        "tooltip": "Secondary item action.",
    },
    {
        "id": "pickupDropItem",
        "label": "Pick up or drop item",
        "tooltip": "Pick up or drop item.",
    },
    {
        "id": "openItemManagement",
        "label": "Manage items",
        "tooltip": "Manage items.",
    },
    {
        "id": "editItem",
        "label": "Edit item properties",
        "tooltip": "Edit item properties.",
    },
    {
        "id": "inspectItem",
        "label": "Inspect item properties",
        "tooltip": "Read all item properties.",
    },
)
