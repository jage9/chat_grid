import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  getNearestItem,
  getNearestItemPosition,
  itemOccupiesPosition,
  type WorldItem,
} from './gameState';

function elevator(): WorldItem {
  return {
    id: 'elevator-1',
    type: 'elevator',
    title: 'Elevator',
    x: 10,
    y: 10,
    z: 0,
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: ['usable'],
    params: { floorZs: [0, 40] },
    occupiedOffsets: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
  };
}

describe('floor-aware item footprints', () => {
  it('occupies every shaft cell on each configured floor', () => {
    const item = elevator();

    expect(itemOccupiesPosition(item, 11, 11, 0)).toBe(true);
    expect(itemOccupiesPosition(item, 11, 11, 40)).toBe(true);
    expect(itemOccupiesPosition(item, 12, 11, 40)).toBe(false);
  });

  it('uses the nearest occupied cell for locating and distance', () => {
    const state = createInitialState();
    const item = elevator();
    state.player.x = 12;
    state.player.y = 11;
    state.items.set(item.id, item);

    expect(getNearestItemPosition(item, state.player.x, state.player.y)).toEqual({ x: 11, y: 11 });
    expect(getNearestItem(state)).toEqual({ itemId: item.id, distance: 1 });
  });
});
