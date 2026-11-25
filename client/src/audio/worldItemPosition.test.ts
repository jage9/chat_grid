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
  it('places a wide tall widget at the closest point of its volume', () => {
    const widget = item({ type: 'widget', params: {}, endX: 30, endY: 20, endZ: 40 });
    expect(resolveWorldItemSourcePosition(widget, 40, 32, 16)).toEqual({ x: 30, y: 16, z: 40 });
    expect(resolveWorldItemSourcePosition(widget, 60, 11, 16)).toEqual({ x: 11, y: 16, z: 40 });
  });

  it('resolves bounded continuous emitters to the nearest point in 3D', () => {
    const radio = item({ type: 'radio_station', params: {}, x: 10, y: 12, z: 0, endX: 30, endY: 20, endZ: 40 });
    expect(resolveWorldItemSourcePosition(radio, 60, 32, 16)).toEqual({ x: 30, y: 16, z: 40 });
    expect(resolveWorldItemSourcePosition(radio, 20, 11, 16)).toEqual({ x: 11, y: 16, z: 20 });
  });
  it('anchors a floor-aware source to the listener landing', () => {
    expect(resolveWorldItemSourcePosition(item(), 40)).toEqual({ x: 10, y: 12, z: 40 });
    expect(resolveWorldItemSourcePosition(item(), 15)).toEqual({ x: 10, y: 12, z: 0 });
    expect(resolveWorldItemSourcePosition(item(), 30)).toEqual({ x: 10, y: 12, z: 40 });
  });

  it('keeps ordinary and carried sources at their synchronized world z', () => {
    expect(resolveWorldItemSourcePosition(item({ type: 'radio_station', params: {}, z: 40 }), 0))
      .toEqual({ x: 10, y: 12, z: 40 });
  });

  it('keeps an unserved listener floor at the item z', () => {
    expect(resolveWorldItemSourcePosition(item(), 20)).toEqual({ x: 10, y: 12, z: 0 });
  });
});
