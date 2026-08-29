import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  getNearestItem,
  getNearestItemPosition,
  itemOccupiesPosition,
  type WorldItem,
} from './gameState';

function multiSquareItem(): WorldItem {
  return {
    id: 'large-item-1',
    type: 'test_large_item',
    title: 'Large item',
    x: 10,
    y: 10,
    z: 0,
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: ['usable'],
    params: {},
    occupiedOffsets: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
  };
}

describe('floor-aware item footprints', () => {
  it('occupies every declared cell only on its floor', () => {
    const item = multiSquareItem();

    expect(itemOccupiesPosition(item, 11, 11, 0)).toBe(true);
    expect(itemOccupiesPosition(item, 11, 11, 40)).toBe(false);
    expect(itemOccupiesPosition(item, 12, 11, 0)).toBe(false);
  });

  it('uses the nearest occupied cell for locating and distance', () => {
    const state = createInitialState();
    const item = multiSquareItem();
    state.player.x = 12;
    state.player.y = 11;
    state.items.set(item.id, item);

    expect(getNearestItemPosition(item, state.player.x, state.player.y)).toEqual({ x: 11, y: 11 });
    expect(getNearestItem(state)).toEqual({ itemId: item.id, distance: 1 });
  });
});
