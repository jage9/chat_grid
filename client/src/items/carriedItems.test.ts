import { describe, expect, it } from 'vitest';
import type { WorldItem } from '../state/gameState';
import {
  describeHeldItems,
  formatCarryingSuffix,
  getCarriedItems,
} from './carriedItems';

function item(id: string, title: string, carrierId: string | null = null): WorldItem {
  return {
    id,
    type: 'test-item',
    title,
    x: 1,
    y: 1,
    z: 0,
    createdBy: 'creator',
    updatedBy: 'creator',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: [],
    params: {},
    carrierId,
    occupiedOffsets: [{ x: 0, y: 0 }],
  };
}

describe('carried item display helpers', () => {
  it('treats a null carrier as holding nothing', () => {
    const items = [item('one', 'Lantern', 'self')];

    expect(getCarriedItems(items, null)).toEqual([]);
    expect(formatCarryingSuffix(items, null)).toBe('');
    expect(describeHeldItems(items, null)).toBe('You are holding nothing.');
  });

  it('selects only items carried by the requested player', () => {
    const items = [
      item('self-item', 'Lantern', 'self'),
      item('other-item', 'Map', 'other'),
      item('floor-item', 'Key'),
    ];

    expect(getCarriedItems(items, 'self').map(({ id }) => id)).toEqual(['self-item']);
    expect(formatCarryingSuffix(items, 'self')).toBe(', carrying Lantern');
    expect(formatCarryingSuffix(items, 'other')).toBe(', carrying Map');
  });

  it('reflects pickup and drop changes in a mutable item map', () => {
    const items = new Map([
      ['lantern', item('lantern', 'Lantern')],
      ['map', item('map', 'Map', 'other')],
    ]);

    expect(describeHeldItems(items.values(), 'self')).toBe('You are holding nothing.');

    items.get('lantern')!.carrierId = 'self';
    expect(describeHeldItems(items.values(), 'self')).toBe('You are holding Lantern.');

    items.get('lantern')!.carrierId = null;
    expect(describeHeldItems(items.values(), 'self')).toBe('You are holding nothing.');
  });

  it('joins multiple carried titles naturally in stable order', () => {
    const items = [
      item('lantern', 'Lantern', 'self'),
      item('map', 'Map', 'self'),
      item('key', 'Key', 'self'),
    ];

    expect(formatCarryingSuffix(items, 'self')).toBe(', carrying Lantern, Map, and Key');
    expect(describeHeldItems(items, 'self')).toBe('You are holding Lantern, Map, and Key.');
  });
});
