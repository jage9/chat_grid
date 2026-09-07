import { handleListControlKey } from '../input/listController';
import type { ConfirmationRequest } from '../input/confirmationController';
import type { IncomingMessage, OutgoingMessage } from '../network/protocol';
import type { GameMode, SelectionContext, WorldItem } from '../state/gameState';

type ItemManagementAction = 'delete' | 'transfer';

export type ItemManagementOption = {
  action: ItemManagementAction;
  label: string;
  tooltip?: string;
};

type ItemManagementConfirmContext = {
  itemId: string;
  action: ItemManagementAction;
  prompt: string;
  targetUserId?: string;
};

export type ItemTransferTarget = {
  userId: string;
  username: string;
  online: boolean;
};

type ItemControllerDeps = {
  state: {
    mode: GameMode;
    selectionContext: SelectionContext;
    selectedItemIds: string[];
    selectedItemIndex: number;
    selectedItemId: string | null;
    itemPropertyKeys: string[];
    itemPropertyIndex: number;
    editingPropertyKey: string | null;
    items: Map<string, WorldItem>;
    peers: Map<string, unknown>;
    player: { id: string | null };
  };
  signalingSend: (message: OutgoingMessage) => void;
  announceMenuEntry: (title: string, firstOption: string) => void;
  updateStatus: (message: string) => void;
  sfxUiBlip: () => void;
  sfxUiCancel: () => void;
  hasPermission: (key: string) => boolean;
  getAuthUserId: () => string;
  getItemManagementActionMetadata: (
    action: ItemManagementAction,
  ) =>
    | {
        label?: string;
        tooltip?: string;
        anyPermission?: string;
        ownPermission?: string;
      }
    | undefined;
  itemLabel: (item: WorldItem) => string;
  getEditableItemPropertyKeys: (item: WorldItem) => string[];
  getInspectItemPropertyKeys: (item: WorldItem) => string[];
  getItemPropertyValue: (item: WorldItem, key: string) => string;
  itemPropertyLabel: (key: string) => string;
  useItem: (item: WorldItem) => void;
  secondaryUseItem: (item: WorldItem) => void;
  pickupDropItem: (item: WorldItem) => void;
  openConfirmation: (request: ConfirmationRequest) => void;
};

/**
 * Creates the shared item selection/management/property flow controller.
 */
export function createItemInteractionController(deps: ItemControllerDeps): {
  reset: () => void;
  beginItemSelection: (context: Exclude<SelectionContext, null>, items: WorldItem[]) => void;
  beginItemManagement: (item: WorldItem) => void;
  beginItemProperties: (item: WorldItem, showAll?: boolean) => void;
  recomputeActiveItemPropertyKeys: (itemId: string) => void;
  getManagementOptions: (item: WorldItem) => ItemManagementOption[];
  handleItemTransferTargets: (message: Extract<IncomingMessage, { type: 'item_transfer_targets' }>) => void;
  handleSelectItemModeInput: (code: string, key: string) => void;
  handleItemManageOptionsModeInput: (code: string, key: string) => void;
  handleItemManageTransferUserModeInput: (code: string, key: string) => void;
} {
  let itemManagementSelectedItemId: string | null = null;
  let itemManagementOptions: ItemManagementOption[] = [];
  let itemManagementOptionIndex = 0;
  let itemManagementTargetUserIndex = 0;
  let itemManagementTransferTargets: ItemTransferTarget[] = [];
  let itemPropertiesShowAll = false;

  function canManageDeleteItem(item: WorldItem): boolean {
    const metadata = deps.getItemManagementActionMetadata('delete');
    if (metadata?.anyPermission && deps.hasPermission(metadata.anyPermission)) return true;
    return !!metadata?.ownPermission && deps.hasPermission(metadata.ownPermission) && deps.getAuthUserId().length > 0 && item.createdBy === deps.getAuthUserId();
  }

  function canManageTransferItem(item: WorldItem): boolean {
    if (item.carrierId !== undefined && item.carrierId !== null) return false;
    const metadata = deps.getItemManagementActionMetadata('transfer');
    if (metadata?.anyPermission && deps.hasPermission(metadata.anyPermission)) return true;
    return !!metadata?.ownPermission && deps.hasPermission(metadata.ownPermission) && deps.getAuthUserId().length > 0 && item.createdBy === deps.getAuthUserId();
  }

  function getManagementOptions(item: WorldItem): ItemManagementOption[] {
    const options: ItemManagementOption[] = [];
    const transferMetadata = deps.getItemManagementActionMetadata('transfer');
    if (canManageTransferItem(item) && (deps.state.player.id !== null || deps.state.peers.size > 0)) {
      options.push({
        action: 'transfer',
        label: transferMetadata?.label ?? 'Transfer item',
        tooltip: transferMetadata?.tooltip,
      });
    }
    const deleteMetadata = deps.getItemManagementActionMetadata('delete');
    if (canManageDeleteItem(item)) {
      options.push({
        action: 'delete',
        label: deleteMetadata?.label ?? 'Delete item',
        tooltip: deleteMetadata?.tooltip,
      });
    }
    return options;
  }

  function transferTargetLabel(target: ItemTransferTarget): string {
    return target.online ? `${target.username}, online` : `${target.username}, offline`;
  }

  function resetItemManagementState(): void {
    itemManagementSelectedItemId = null;
    itemManagementOptions = [];
    itemManagementOptionIndex = 0;
    itemManagementTransferTargets = [];
    itemManagementTargetUserIndex = 0;
  }

  function openItemManagementConfirm(context: ItemManagementConfirmContext): void {
    deps.openConfirmation({
      prompt: context.prompt,
      onConfirm: () => {
        deps.state.mode = 'normal';
        if (context.action === 'delete') {
          deps.signalingSend({ type: 'item_delete', itemId: context.itemId });
        } else if (context.targetUserId) {
          deps.signalingSend({
            type: 'item_transfer',
            itemId: context.itemId,
            targetUserId: context.targetUserId,
          });
        }
        resetItemManagementState();
      },
      onCancel: () => {
        deps.state.mode = 'itemManageOptions';
        deps.updateStatus(itemManagementOptions[itemManagementOptionIndex]?.label ?? 'Item management.');
      },
    });
  }

  function selectionItemLabel(item: WorldItem, context: Exclude<SelectionContext, null>): string {
    const baseLabel = deps.itemLabel(item);
    const carriedByPlayer = deps.state.player.id !== null && item.carrierId === deps.state.player.id;
    const label = carriedByPlayer ? `${baseLabel}, held` : baseLabel;
    if (context === 'pickupDrop') {
      return `${carriedByPlayer ? 'Drop' : 'Pick up'} ${label}`;
    }
    return label;
  }

  function beginItemSelection(context: Exclude<SelectionContext, null>, items: WorldItem[]): void {
    if (items.length === 0) {
      deps.updateStatus('No items available.');
      deps.sfxUiCancel();
      return;
    }
    deps.state.mode = 'selectItem';
    deps.state.selectionContext = context;
    deps.state.selectedItemIds = items.map((item) => item.id);
    deps.state.selectedItemIndex = 0;
    deps.announceMenuEntry('Select item', selectionItemLabel(items[0], context));
  }

  function beginItemManagement(item: WorldItem): void {
    const options = getManagementOptions(item);
    if (options.length === 0) {
      deps.updateStatus('No item management actions available.');
      deps.sfxUiCancel();
      return;
    }
    itemManagementSelectedItemId = item.id;
    itemManagementOptions = options;
    itemManagementOptionIndex = 0;
    deps.state.mode = 'itemManageOptions';
    deps.announceMenuEntry('Items', itemManagementOptions[0].label);
  }

  function beginItemProperties(item: WorldItem, showAll = false): void {
    itemPropertiesShowAll = showAll;
    deps.state.selectedItemId = item.id;
    deps.state.mode = 'itemProperties';
    deps.state.editingPropertyKey = null;
    deps.state.itemPropertyKeys = showAll ? deps.getInspectItemPropertyKeys(item) : deps.getEditableItemPropertyKeys(item);
    deps.state.itemPropertyIndex = 0;
    if (deps.state.itemPropertyKeys.length === 0) {
      deps.updateStatus('No properties available.');
      deps.sfxUiCancel();
      deps.state.mode = 'normal';
      deps.state.selectedItemId = null;
      return;
    }
    const key = deps.state.itemPropertyKeys[0];
    const value = deps.getItemPropertyValue(item, key);
    deps.updateStatus(`${deps.itemPropertyLabel(key)}: ${value}`);
    deps.sfxUiBlip();
  }

  function recomputeActiveItemPropertyKeys(itemId: string): void {
    if (deps.state.mode !== 'itemProperties' || deps.state.selectedItemId !== itemId) {
      return;
    }
    const item = deps.state.items.get(itemId);
    if (!item) {
      return;
    }
    const previousKey = deps.state.itemPropertyKeys[deps.state.itemPropertyIndex] ?? null;
    const nextKeys = itemPropertiesShowAll ? deps.getInspectItemPropertyKeys(item) : deps.getEditableItemPropertyKeys(item);
    deps.state.itemPropertyKeys = nextKeys;
    if (nextKeys.length === 0) {
      deps.state.itemPropertyIndex = 0;
      return;
    }
    if (previousKey && nextKeys.includes(previousKey)) {
      deps.state.itemPropertyIndex = nextKeys.indexOf(previousKey);
      return;
    }
    deps.state.itemPropertyIndex = Math.max(0, Math.min(deps.state.itemPropertyIndex, nextKeys.length - 1));
  }

  function handleItemTransferTargets(message: Extract<IncomingMessage, { type: 'item_transfer_targets' }>): void {
    if (itemManagementSelectedItemId !== message.itemId) return;
    itemManagementTransferTargets = [...message.targets].sort((a, b) =>
      a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }),
    );
    if (itemManagementTransferTargets.length === 0) {
      deps.state.mode = 'itemManageOptions';
      deps.updateStatus('No users available to transfer to.');
      deps.sfxUiCancel();
      return;
    }
    itemManagementTargetUserIndex = 0;
    deps.state.mode = 'itemManageTransferUser';
    deps.announceMenuEntry('Users', transferTargetLabel(itemManagementTransferTargets[0]));
  }

  function handleSelectItemModeInput(code: string, key: string): void {
    if (deps.state.selectedItemIds.length === 0) {
      deps.state.mode = 'normal';
      deps.state.selectionContext = null;
      return;
    }
    const control = handleListControlKey(code, key, deps.state.selectedItemIds, deps.state.selectedItemIndex, (itemId) => {
      const item = deps.state.items.get(itemId);
      return item ? deps.itemLabel(item) : '';
    });
    if (control.type === 'move') {
      deps.state.selectedItemIndex = control.index;
      const current = deps.state.items.get(deps.state.selectedItemIds[deps.state.selectedItemIndex]);
      const context = deps.state.selectionContext;
      if (current && context) {
        deps.updateStatus(selectionItemLabel(current, context));
        deps.sfxUiBlip();
      }
      return;
    }
    if (control.type === 'select') {
      const selected = deps.state.items.get(deps.state.selectedItemIds[deps.state.selectedItemIndex]);
      if (!selected) {
        deps.state.mode = 'normal';
        deps.state.selectionContext = null;
        return;
      }
      const context = deps.state.selectionContext;
      deps.state.mode = 'normal';
      deps.state.selectionContext = null;
      if (context === 'pickupDrop') {
        deps.pickupDropItem(selected);
        return;
      }
      if (context === 'delete') {
        deps.signalingSend({ type: 'item_delete', itemId: selected.id });
        return;
      }
      if (context === 'edit') {
        beginItemProperties(selected);
        return;
      }
      if (context === 'use') {
        deps.useItem(selected);
        return;
      }
      if (context === 'secondaryUse') {
        deps.secondaryUseItem(selected);
        return;
      }
      if (context === 'inspect') {
        beginItemProperties(selected, true);
        return;
      }
      if (context === 'manage') {
        beginItemManagement(selected);
      }
      return;
    }
    if (control.type === 'cancel') {
      deps.state.mode = 'normal';
      deps.state.selectionContext = null;
      deps.updateStatus('Cancelled.');
      deps.sfxUiCancel();
    }
  }

  function handleItemManageOptionsModeInput(code: string, key: string): void {
    if (!itemManagementSelectedItemId) {
      deps.state.mode = 'normal';
      resetItemManagementState();
      return;
    }
    const item = deps.state.items.get(itemManagementSelectedItemId);
    if (!item) {
      deps.state.mode = 'normal';
      resetItemManagementState();
      deps.updateStatus('Item no longer exists.');
      deps.sfxUiCancel();
      return;
    }
    itemManagementOptions = getManagementOptions(item);
    if (itemManagementOptions.length === 0) {
      deps.state.mode = 'normal';
      resetItemManagementState();
      deps.updateStatus('No item management actions available.');
      deps.sfxUiCancel();
      return;
    }
    itemManagementOptionIndex = Math.max(0, Math.min(itemManagementOptionIndex, itemManagementOptions.length - 1));
    const control = handleListControlKey(code, key, itemManagementOptions, itemManagementOptionIndex, (entry) => entry.label);
    if (control.type === 'move') {
      itemManagementOptionIndex = control.index;
      deps.updateStatus(itemManagementOptions[itemManagementOptionIndex].label);
      deps.sfxUiBlip();
      return;
    }
    if (code === 'Space') {
      deps.updateStatus(itemManagementOptions[itemManagementOptionIndex]?.tooltip ?? 'No tooltip available.');
      deps.sfxUiBlip();
      return;
    }
    if (control.type === 'select') {
      const option = itemManagementOptions[itemManagementOptionIndex];
      if (option.action === 'delete') {
        openItemManagementConfirm({
          itemId: item.id,
          action: 'delete',
          prompt: `Delete ${deps.itemLabel(item)}?`,
        });
        return;
      }
      itemManagementTransferTargets = [];
      itemManagementTargetUserIndex = 0;
      deps.signalingSend({ type: 'item_transfer_targets', itemId: item.id });
      deps.updateStatus('Loading users...');
      deps.sfxUiBlip();
      return;
    }
    if (control.type === 'cancel') {
      deps.state.mode = 'normal';
      resetItemManagementState();
      deps.updateStatus('Cancelled.');
      deps.sfxUiCancel();
    }
  }

  function handleItemManageTransferUserModeInput(code: string, key: string): void {
    if (!itemManagementSelectedItemId || itemManagementTransferTargets.length === 0) {
      deps.state.mode = 'itemManageOptions';
      return;
    }
    const control = handleListControlKey(
      code,
      key,
      itemManagementTransferTargets,
      itemManagementTargetUserIndex,
      (target) => transferTargetLabel(target),
    );
    if (control.type === 'move') {
      itemManagementTargetUserIndex = control.index;
      const label = transferTargetLabel(itemManagementTransferTargets[itemManagementTargetUserIndex]);
      deps.updateStatus(label);
      deps.sfxUiBlip();
      return;
    }
    if (control.type === 'select') {
      const item = deps.state.items.get(itemManagementSelectedItemId);
      const target = itemManagementTransferTargets[itemManagementTargetUserIndex];
      if (!item || !target) {
        deps.state.mode = 'itemManageOptions';
        deps.sfxUiCancel();
        return;
      }
      openItemManagementConfirm({
        itemId: item.id,
        action: 'transfer',
        prompt: `Transfer ${deps.itemLabel(item)} to ${target.username}?`,
        targetUserId: target.userId,
      });
      return;
    }
    if (control.type === 'cancel') {
      deps.state.mode = 'itemManageOptions';
      deps.updateStatus(itemManagementOptions[itemManagementOptionIndex]?.label ?? 'Item management.');
      deps.sfxUiCancel();
    }
  }

  return {
    reset: resetItemManagementState,
    beginItemSelection,
    beginItemManagement,
    beginItemProperties,
    recomputeActiveItemPropertyKeys,
    getManagementOptions,
    handleItemTransferTargets,
    handleSelectItemModeInput,
    handleItemManageOptionsModeInput,
    handleItemManageTransferUserModeInput,
  };
}
