import { describe, expect, it, vi } from 'vitest';
import type { GameMode, SelectionContext, WorldItem } from '../state/gameState';
import { createItemInteractionController } from './itemInteractionController';

const PLAYER_ID = 'player-1';
const ITEM_TITLE = 'Test item (test)';

function item(id: string, carrierId: string | null = null, capabilities = ['carryable']): WorldItem {
  return {
    id,
    type: 'test-item',
    title: 'Test item',
    x: 1,
    y: 1,
    z: 0,
    createdBy: 'player-1',
    updatedBy: 'player-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities,
    params: { title: 'Test item' },
    carrierId,
    occupiedOffsets: [{ x: 0, y: 0 }],
  };
}

function createFixture() {
  const held = item('held', PLAYER_ID);
  const ground = item('ground');
  const items = new Map<string, WorldItem>([
    [held.id, held],
    [ground.id, ground],
  ]);
  const state = {
    mode: 'normal' as GameMode,
    selectionContext: null as SelectionContext,
    selectedItemIds: [] as string[],
    selectedItemIndex: 0,
    selectedItemId: null as string | null,
    itemPropertyKeys: [] as string[],
    itemPropertyIndex: 0,
    editingPropertyKey: null as string | null,
    items,
    peers: new Map<string, unknown>(),
    player: { id: PLAYER_ID },
  };
  const deps = {
    state,
    signalingSend: vi.fn(),
    announceMenuEntry: vi.fn(),
    updateStatus: vi.fn(),
    sfxUiBlip: vi.fn(),
    sfxUiCancel: vi.fn(),
    hasPermission: vi.fn(() => true),
    getAuthUserId: vi.fn(() => PLAYER_ID),
    getItemManagementActionMetadata: vi.fn((action: 'delete' | 'transfer' | 'hand') => ({
      label: action === 'delete' ? 'Delete item' : action === 'transfer' ? 'Transfer ownership' : 'Hand to user',
      anyPermission: action === 'hand' ? 'item.pickup_drop.any' : undefined,
      ownPermission: action === 'hand' ? 'item.pickup_drop.own' : `item.${action}.own`,
    })),
    itemLabel: vi.fn(() => ITEM_TITLE),
    getEditableItemPropertyKeys: vi.fn(() => ['title']),
    getInspectItemPropertyKeys: vi.fn(() => ['title']),
    getItemPropertyValue: vi.fn(() => 'Test item'),
    itemPropertyLabel: vi.fn((key: string) => key),
    useItem: vi.fn(),
    secondaryUseItem: vi.fn(),
    pickupDropItem: vi.fn(),
    openConfirmation: vi.fn(),
  };
  return { controller: createItemInteractionController(deps), deps, held, ground };
}

describe('item interaction controller', () => {
  it('keeps held items distinguishable while selecting use, secondary use, edit, inspect, and manage actions', () => {
    const contexts: Array<{
      context: Exclude<SelectionContext, null>;
      expectedMode: GameMode;
      onSelect?: (fixture: ReturnType<typeof createFixture>) => void;
    }> = [
      { context: 'use', expectedMode: 'normal', onSelect: ({ deps }) => expect(deps.useItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'held' })) },
      { context: 'secondaryUse', expectedMode: 'normal', onSelect: ({ deps }) => expect(deps.secondaryUseItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'held' })) },
      { context: 'edit', expectedMode: 'itemProperties' },
      { context: 'inspect', expectedMode: 'itemProperties' },
      { context: 'manage', expectedMode: 'itemManageOptions' },
    ];

    for (const { context, expectedMode, onSelect } of contexts) {
      const fixture = createFixture();
      fixture.controller.beginItemSelection(context, [fixture.held, fixture.ground]);

      expect(fixture.deps.announceMenuEntry).toHaveBeenLastCalledWith('Select item', `${ITEM_TITLE}, held`);
      fixture.controller.handleSelectItemModeInput('Enter', 'Enter');
      expect(fixture.deps.state.mode).toBe(expectedMode);
      onSelect?.(fixture);
    }
  });

  it('announces pickup and drop labels while matching initials against the base item label', () => {
    const fixture = createFixture();
    fixture.controller.beginItemSelection('pickupDrop', [fixture.held, fixture.ground]);

    expect(fixture.deps.announceMenuEntry).toHaveBeenLastCalledWith('Select item', `Drop ${ITEM_TITLE}, held`);
    fixture.controller.handleSelectItemModeInput('KeyT', 't');
    expect(fixture.deps.updateStatus).toHaveBeenLastCalledWith(`Pick up ${ITEM_TITLE}`);
    fixture.controller.handleSelectItemModeInput('Enter', 'Enter');
    expect(fixture.deps.pickupDropItem).toHaveBeenCalledOnce();
    expect(fixture.deps.pickupDropItem).toHaveBeenCalledWith(fixture.ground);

    fixture.controller.beginItemSelection('pickupDrop', [fixture.held, fixture.ground]);
    fixture.controller.handleSelectItemModeInput('Enter', 'Enter');
    expect(fixture.deps.pickupDropItem).toHaveBeenLastCalledWith(fixture.held);
  });

  it('acts on the selected second held item without selecting the first or a ground item', () => {
    const fixture = createFixture();
    const secondHeld = item('second-held', PLAYER_ID);
    fixture.deps.state.items.set(secondHeld.id, secondHeld);
    const candidates = [fixture.held, secondHeld, fixture.ground];

    fixture.controller.beginItemSelection('use', candidates);
    fixture.controller.handleSelectItemModeInput('ArrowDown', 'ArrowDown');
    expect(fixture.deps.updateStatus).toHaveBeenLastCalledWith(`${ITEM_TITLE}, held`);
    fixture.controller.handleSelectItemModeInput('Enter', 'Enter');
    expect(fixture.deps.useItem).toHaveBeenCalledWith(secondHeld);

    fixture.controller.beginItemSelection('pickupDrop', candidates);
    fixture.controller.handleSelectItemModeInput('ArrowDown', 'ArrowDown');
    expect(fixture.deps.updateStatus).toHaveBeenLastCalledWith(`Drop ${ITEM_TITLE}, held`);
    fixture.controller.handleSelectItemModeInput('Enter', 'Enter');
    expect(fixture.deps.pickupDropItem).toHaveBeenCalledWith(secondHeld);

    fixture.controller.beginItemSelection('inspect', candidates);
    fixture.controller.handleSelectItemModeInput('ArrowDown', 'ArrowDown');
    fixture.controller.handleSelectItemModeInput('Enter', 'Enter');
    expect(fixture.deps.state.selectedItemId).toBe(secondHeld.id);
  });

  it('offers ownership transfer for ground items and handoff for locally held items', () => {
    const fixture = createFixture();

    expect(fixture.controller.getManagementOptions(fixture.held)).toEqual([
      { action: 'hand', label: 'Hand to user', tooltip: undefined },
      { action: 'delete', label: 'Delete item', tooltip: undefined },
    ]);
    const otherHeld = item('other-held', 'other-player');
    expect(fixture.controller.getManagementOptions(otherHeld).map((option) => option.action)).not.toContain('hand');
    expect(fixture.controller.getManagementOptions(fixture.ground)).toEqual([
      { action: 'transfer', label: 'Transfer ownership', tooltip: undefined },
      { action: 'delete', label: 'Delete item', tooltip: undefined },
    ]);
  });

  it('allows handoff based on pickup permission even when the holder is not the owner', () => {
    const fixture = createFixture();
    fixture.held.createdBy = 'another-owner';

    expect(fixture.controller.getManagementOptions(fixture.held).map((option) => option.action)).toContain('hand');
  });

  it('does not offer handoff for held items without the carryable capability', () => {
    const fixture = createFixture();
    const nonCarryable = item('non-carryable', PLAYER_ID, []);

    expect(fixture.controller.getManagementOptions(nonCarryable).map((option) => option.action)).not.toContain('hand');
  });

  it('routes ownership transfer through confirmation and handoff directly after target selection', () => {
    const fixture = createFixture();

    fixture.controller.beginItemManagement(fixture.ground);
    fixture.controller.handleItemManageOptionsModeInput('Enter', 'Enter');
    expect(fixture.deps.signalingSend).toHaveBeenLastCalledWith({ type: 'item_transfer_targets', itemId: fixture.ground.id });
    fixture.controller.handleItemTransferTargets({
      type: 'item_transfer_targets',
      itemId: fixture.ground.id,
      targets: [{ userId: 'target', username: 'Target', online: false }],
    });
    fixture.controller.handleItemManageTransferUserModeInput('Enter', 'Enter');
    expect(fixture.deps.openConfirmation).toHaveBeenCalledOnce();
    const transferConfirmation = fixture.deps.openConfirmation.mock.calls[0][0];
    transferConfirmation.onConfirm();
    expect(fixture.deps.signalingSend).toHaveBeenLastCalledWith({
      type: 'item_transfer',
      itemId: fixture.ground.id,
      targetUserId: 'target',
    });

    fixture.controller.beginItemManagement(fixture.held);
    fixture.controller.handleItemManageOptionsModeInput('Enter', 'Enter');
    expect(fixture.deps.signalingSend).toHaveBeenLastCalledWith({ type: 'item_hand_targets', itemId: fixture.held.id });
    fixture.controller.handleItemHandTargets({
      type: 'item_hand_targets',
      itemId: fixture.held.id,
      targets: [{ userId: 'nearby', username: 'Nearby', online: true }],
    });
    fixture.controller.handleItemManageTransferUserModeInput('Enter', 'Enter');
    expect(fixture.deps.openConfirmation).toHaveBeenCalledOnce();
    expect(fixture.deps.signalingSend).toHaveBeenLastCalledWith({
      type: 'item_hand',
      itemId: fixture.held.id,
      targetUserId: 'nearby',
    });
  });

  it('ignores stale target replies and clears a cancelled target selection', () => {
    const fixture = createFixture();
    fixture.controller.beginItemManagement(fixture.held);
    fixture.controller.handleItemManageOptionsModeInput('Enter', 'Enter');
    fixture.controller.handleItemTransferTargets({
      type: 'item_transfer_targets',
      itemId: fixture.held.id,
      targets: [{ userId: 'wrong', username: 'Wrong', online: true }],
    });
    expect(fixture.deps.state.mode).toBe('itemManageOptions');

    fixture.controller.handleItemHandTargets({
      type: 'item_hand_targets',
      itemId: fixture.held.id,
      targets: [{ userId: 'nearby', username: 'Nearby', online: true }],
    });
    expect(fixture.deps.state.mode).toBe('itemManageTransferUser');
    fixture.controller.handleItemManageTransferUserModeInput('Escape', 'Escape');
    expect(fixture.deps.state.mode).toBe('itemManageOptions');
    fixture.controller.handleItemHandTargets({
      type: 'item_hand_targets',
      itemId: fixture.held.id,
      targets: [{ userId: 'late', username: 'Late', online: true }],
    });
    expect(fixture.deps.state.mode).toBe('itemManageOptions');
  });
});
