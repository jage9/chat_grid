import { describe, expect, it, vi } from 'vitest';
import { createInitialState, type StructurePreset, type WallStructure } from '../state/gameState';
import { createWorldBuilderController } from './worldBuilderController';

const brick: StructurePreset = {
  id: 'brick',
  title: 'Brick',
  movementBlocked: true,
  soundTransmission: 0,
  occlusionLowpassHz: 800,
  height: 40,
  contactSound: '/sounds/wall.ogg',
};
const curtain: StructurePreset = {
  ...brick,
  id: 'curtain',
  title: 'Curtain',
  movementBlocked: false,
  soundTransmission: 0.5,
};

function setup() {
  const state = createInitialState();
  state.player.x = 4;
  state.player.y = 4;
  const wall: WallStructure = {
    ...brick,
    id: 'wall-1',
    preset: brick.id,
    floorZ: 0,
    startX: 4,
    startY: 5,
    orientation: 'horizontal',
    length: 2,
  };
  state.structures.set(wall.id, wall);
  const send = vi.fn();
  const openOptionSelector = vi.fn();
  const updateStatus = vi.fn();
  const controller = createWorldBuilderController({
    state,
    hasPermission: () => true,
    send,
    updateStatus,
    announceMenuEntry: vi.fn(),
    blip: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    applyTextInputEdit: vi.fn(),
    setReplaceTextOnNextType: vi.fn(),
    openOptionSelector,
    openConfirmation: vi.fn(),
  });
  controller.setPresets([brick, curtain]);
  controller.open();
  controller.handleRoot('ArrowDown', 'ArrowDown');
  controller.handleRoot('Enter', 'Enter');
  controller.handleWallList('Enter', 'Enter');
  return { controller, openOptionSelector, send, state, updateStatus };
}

describe('World Builder wall controls', () => {
  it('cycles wall types directly and opens the shared option selector', () => {
    const { controller, openOptionSelector, send, state, updateStatus } = setup();
    controller.handleWallActions('Enter', 'Enter');

    controller.handlePropertyList('Space', ' ');
    expect(updateStatus).toHaveBeenLastCalledWith(
      expect.stringContaining('Type: list. Options: Brick, Curtain.'),
    );

    controller.handlePropertyList('ArrowRight', 'ArrowRight');
    expect(send).toHaveBeenLastCalledWith({
      type: 'structure_update_wall',
      structureId: 'wall-1',
      preset: 'curtain',
    });
    expect(state.structures.get('wall-1')?.preset).toBe('curtain');

    controller.handlePropertyList('Enter', 'Enter');
    expect(openOptionSelector).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Wall type',
      selectedId: 'curtain',
    }));
  });

  it('sends slide and anchored-orientation edits from wall actions', () => {
    const { controller, openOptionSelector, send } = setup();
    controller.handleWallActions('ArrowDown', 'ArrowDown');
    controller.handleWallActions('ArrowDown', 'ArrowDown');
    controller.handleWallActions('ArrowDown', 'ArrowDown');
    controller.handleWallActions('ArrowRight', 'ArrowRight');
    expect(send).toHaveBeenLastCalledWith({
      type: 'structure_slide_wall',
      structureId: 'wall-1',
      delta: 1,
    });

    controller.handleWallActions('ArrowDown', 'ArrowDown');
    controller.handleWallActions('ArrowRight', 'ArrowRight');
    expect(send).toHaveBeenLastCalledWith({
      type: 'structure_rotate_wall',
      structureId: 'wall-1',
      orientation: 'vertical',
    });
    controller.handleWallActions('Enter', 'Enter');
    const request = openOptionSelector.mock.calls.at(-1)?.[0];
    request.onSelect('vertical');
    expect(send).toHaveBeenLastCalledWith({
      type: 'structure_rotate_wall',
      structureId: 'wall-1',
      orientation: 'vertical',
    });
  });
});
