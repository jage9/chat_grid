import { describe, expect, it, vi } from 'vitest';
import { createItemPropertyEditor } from './itemPropertyEditor';
import { createItemPropertyPresentation } from './itemPropertyPresentation';
import { applyServerItemUiDefinitions, getItemPropertyMetadata, itemPropertyLabel } from './itemRegistry';
import type { WorldItem } from '../state/gameState';

function setup() {
  applyServerItemUiDefinitions({
    itemTypes: [
      {
        type: 'elevator',
        editableProperties: ['speed', 'enabled', 'doorOpenSeconds'],
        propertyMetadata: {
          enabled: { valueType: 'boolean' },
          speed: { valueType: 'number', range: { min: 0.1, max: 1000, step: 0.1 } },
          doorOpenSeconds: { valueType: 'number', range: { min: 0.1, max: 1000, step: 0.1 } },
        },
      },
      {
        type: 'widget',
        editableProperties: ['width', 'depth', 'height'],
        propertyMetadata: Object.fromEntries([
          ['width', 'Width', 'east'],
          ['depth', 'Depth', 'north'],
          ['height', 'Height', 'up'],
        ].map(([key, label, direction]) => [key, {
          label,
          valueType: 'number',
          range: { min: 1, max: 1000, step: 1 },
          tooltip: `Size in squares, expanding ${direction} from the current square.`,
        }])),
      },
    ],
  });
  const presentation = createItemPropertyPresentation();
  const item: WorldItem = {
    id: 'car', type: 'elevator', title: 'Studio elevator',
    x: 0, y: 0, z: 0, createdBy: 'self', updatedBy: 'self',
    createdAt: 1, updatedAt: 1, version: 1,
    capabilities: [], carrierId: null, occupiedOffsets: [{ x: 0, y: 0 }],
    params: { speed: 10, enabled: true, doorOpenSeconds: 5 },
  };
  const state = {
    mode: 'itemProperties', selectedItemId: item.id, editingPropertyKey: null as string | null,
    itemPropertyKeys: ['speed', 'enabled', 'doorOpenSeconds'], itemPropertyIndex: 0, nicknameInput: '', cursorPos: 0,
    items: new Map([[item.id, item]]),
  };
  const signalingSend = vi.fn();
  const updateStatus = vi.fn();
  const sfxUiCancel = vi.fn();
  const sfxUiBlip = vi.fn();
  const editor = createItemPropertyEditor({
    state, signalingSend, updateStatus, sfxUiCancel, sfxUiBlip,
    ...presentation,
    itemPropertyLabel,
    getItemPropertyOptionValues: () => undefined,
    openOptionSelector: vi.fn(),
    getItemPropertyMetadata,
    applyTextInputEdit: vi.fn(), setReplaceTextOnNextType: vi.fn(),
  });
  function reply(ok = true, params: Record<string, unknown> = {}, message = 'Updated.') {
    Object.assign(item.params, params);
    const request = signalingSend.mock.lastCall![0];
    editor.handleActionResult({ type: 'item_action_result', action: 'update', ok, message, itemId: item.id, requestId: request.requestId });
  }
  return { item, state, signalingSend, updateStatus, sfxUiCancel, sfxUiBlip, editor, reply };
}

describe('accepted item property feedback', () => {
  it('reads property help through the shared Space control', () => {
    const { editor, updateStatus, signalingSend, sfxUiBlip } = setup();
    editor.handleItemPropertiesModeInput('Space', ' ');
    expect(updateStatus).toHaveBeenLastCalledWith(expect.stringContaining('speed'));
    expect(sfxUiBlip).toHaveBeenCalledOnce();
    expect(signalingSend).not.toHaveBeenCalled();
  });

  it('waits for confirmation before speaking an Enter toggle and suppresses the upsert echo', () => {
    const { state, editor, updateStatus, signalingSend, reply } = setup();
    state.itemPropertyIndex = 1;
    editor.handleItemPropertiesModeInput('Enter', 'Enter');
    expect(updateStatus).not.toHaveBeenCalled();
    expect(signalingSend.mock.lastCall![0].params).toEqual({ enabled: false });
    expect(editor.shouldAnnounceEcho('car')).toBe(false);
    reply(true, { enabled: false });
    expect(updateStatus.mock.calls).toEqual([['off']]);
    expect(editor.shouldAnnounceEcho('car')).toBe(true);
  });

  it('accumulates rapid presses using each server-accepted value', () => {
    const { editor, signalingSend, updateStatus, reply } = setup();
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    expect(signalingSend).toHaveBeenCalledTimes(1);
    expect(updateStatus).not.toHaveBeenCalled();
    reply(true, { speed: 10.1 });
    expect(signalingSend.mock.lastCall![0].params).toEqual({ speed: 10.2 });
    reply(true, { speed: 10.2 });
    expect(updateStatus.mock.calls).toEqual([['10.1'], ['10.2']]);
  });

  it('drops subsequent requests after rejection and speaks the reason', () => {
    const { editor, signalingSend, updateStatus, sfxUiCancel, reply } = setup();
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    reply(false, {}, 'The item footprint does not fit on the platforms.');
    expect(signalingSend).toHaveBeenCalledTimes(1);
    expect(updateStatus.mock.calls).toEqual([['The item footprint does not fit on the platforms.']]);
    expect(sfxUiCancel).toHaveBeenCalledOnce();
  });

  it('retains adjustments to another row without announcing the previous row on acknowledgement', () => {
    const { editor, state, signalingSend, updateStatus, reply } = setup();
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    editor.handleItemPropertiesModeInput('ArrowDown', 'ArrowDown');
    editor.handleItemPropertiesModeInput('Enter', 'Enter');
    updateStatus.mockClear();
    reply(true, { speed: 10.1 });
    expect(updateStatus).not.toHaveBeenCalled();
    expect(signalingSend.mock.lastCall![0].params).toEqual({ enabled: false });
    reply(true, { enabled: false });
    expect(state.itemPropertyIndex).toBe(1);
    expect(updateStatus.mock.calls).toEqual([['off']]);
  });

  it('reads widget sizes through shared presentation and drops rejected repeated changes', () => {
    const { item, state, editor, signalingSend, updateStatus, reply } = setup();
    item.type = 'widget';
    item.x = 40;
    item.display = { width: '1', depth: '1', height: '1' };
    state.itemPropertyKeys = ['width', 'depth', 'height'];
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    expect(signalingSend.mock.lastCall![0].params).toEqual({ width: 2 });
    expect(updateStatus).not.toHaveBeenCalled();
    reply(false, {}, 'The item footprint does not fit on the platforms.');
    expect(signalingSend).toHaveBeenCalledTimes(1);
    expect(updateStatus.mock.calls).toEqual([['The item footprint does not fit on the platforms.']]);
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    item.endX = 41;
    item.display.width = '2';
    reply(true);
    expect(updateStatus).toHaveBeenLastCalledWith('2');
    expect(signalingSend.mock.lastCall![0].params).toEqual({ width: 3 });
    item.endX = 42;
    item.display.width = '3';
    reply(true);
    expect(updateStatus).toHaveBeenLastCalledWith('3');
  });

  it('ignores late results after an editor session closes', () => {
    const { editor, signalingSend, updateStatus, reply } = setup();
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    editor.handleItemPropertiesModeInput('Escape', 'Escape');
    updateStatus.mockClear();
    reply(false, {}, 'An old rejection.');
    expect(updateStatus).not.toHaveBeenCalled();
    expect(signalingSend).toHaveBeenCalledTimes(1);
  });

  it('continues another property after a rejected adjustment', () => {
    const { editor, state, signalingSend, updateStatus, reply } = setup();
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    state.itemPropertyIndex = 2;
    editor.handleItemPropertiesModeInput('ArrowRight', 'ArrowRight');
    reply(false, {}, 'Speed rejected.');
    expect(signalingSend).toHaveBeenCalledTimes(2);
    expect(signalingSend.mock.lastCall![0].params).toEqual({ doorOpenSeconds: 5.1 });
    reply(true, { doorOpenSeconds: 5.1 });
    expect(updateStatus.mock.calls).toEqual([['Speed rejected.'], ['5.1']]);
  });

  it('submits typed values through the same acknowledgement path', () => {
    const { editor, state, signalingSend, updateStatus, reply } = setup();
    editor.handleItemPropertiesModeInput('Enter', 'Enter');
    state.nicknameInput = '12.3';
    updateStatus.mockClear();
    editor.handleItemPropertyEditModeInput('Enter', 'Enter', false);
    expect(signalingSend.mock.lastCall![0].params).toEqual({ speed: 12.3 });
    expect(updateStatus).not.toHaveBeenCalled();
    reply(true, { speed: 12.3 });
    expect(updateStatus.mock.calls).toEqual([['12.3']]);
  });

  it('uses the size for navigation, Space help, typed editing and confirmation', () => {
    const { item, state, editor, signalingSend, updateStatus, reply } = setup();
    item.type = 'widget';
    item.x = 40;
    item.y = -10;
    item.endX = 45;
    item.display = { width: '6', depth: '1', height: '1' };
    state.itemPropertyKeys = ['width', 'depth', 'height'];
    editor.handleItemPropertiesModeInput('ArrowDown', 'ArrowDown');
    expect(updateStatus).toHaveBeenLastCalledWith('Depth: 1');
    editor.handleItemPropertiesModeInput('Space', ' ');
    expect(updateStatus).toHaveBeenLastCalledWith(expect.stringContaining('expanding north'));
    editor.handleItemPropertiesModeInput('ArrowUp', 'ArrowUp');
    editor.handleItemPropertiesModeInput('Enter', 'Enter');
    expect(state.nicknameInput).toBe('6');
    editor.handleItemPropertyEditModeInput('ArrowUp', 'ArrowUp', false);
    expect(state.nicknameInput).toBe('7');
    expect(signalingSend).not.toHaveBeenCalled();
    state.nicknameInput = '8';
    updateStatus.mockClear();
    editor.handleItemPropertyEditModeInput('Enter', 'Enter', false);
    expect(signalingSend.mock.lastCall![0].params).toEqual({ width: 8 });
    expect(updateStatus).not.toHaveBeenCalled();
    item.endX = 47;
    item.display.width = '8';
    reply(true);
    expect(updateStatus.mock.calls).toEqual([['8']]);
  });

  it('keeps widget dimensions within the shared numeric editor range', () => {
    const { item, state, editor, signalingSend, updateStatus, sfxUiCancel } = setup();
    item.type = 'widget';
    item.display = { width: '1', depth: '1', height: '1' };
    state.itemPropertyKeys = ['height'];
    editor.handleItemPropertiesModeInput('ArrowLeft', 'ArrowLeft');
    expect(sfxUiCancel).toHaveBeenCalledOnce();
    expect(signalingSend).not.toHaveBeenCalled();
    editor.handleItemPropertiesModeInput('Enter', 'Enter');
    state.nicknameInput = '0';
    editor.handleItemPropertyEditModeInput('Enter', 'Enter', false);
    expect(updateStatus).toHaveBeenLastCalledWith(expect.stringContaining('between 1 and 1000'));
    expect(signalingSend).not.toHaveBeenCalled();
  });
});
