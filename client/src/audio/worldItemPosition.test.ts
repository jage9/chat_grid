import { describe, expect, it } from 'vitest';
import { type WorldItem } from '../state/gameState';
import { resolveWorldItemSourcePosition } from './worldItemPosition';

function item(overrides: Partial<WorldItem> = {}): WorldItem {
  return {
    id: 'item-1',
    type: 'elevator',
    title: 'Elevator',
    x: 10,
    y: 12,
    z: 0,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: [],
    params: { floorZs: [0, 40] },
    occupiedOffsets: [{ x: 0, y: 0 }],
    ...overrides,
  };
}

describe('resolveWorldItemSourcePosition', () => {
  it('anchors a floor-aware source to the listener landing', () => {
    expect(resolveWorldItemSourcePosition(item(), 40)).toEqual({ x: 10, y: 12, z: 40 });
  });

  it('keeps ordinary and carried sources at their synchronized world z', () => {
    expect(resolveWorldItemSourcePosition(item({ type: 'radio_station', params: {}, z: 40 }), 0))
      .toEqual({ x: 10, y: 12, z: 40 });
  });

  it('keeps an unserved listener floor at the item z', () => {
    expect(resolveWorldItemSourcePosition(item(), 20)).toEqual({ x: 10, y: 12, z: 0 });
  });
});
