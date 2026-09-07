import { describe, expect, it } from 'vitest';
import type { WorldItem } from '../state/gameState';
import { getInteractionItems } from './itemTargets';

function item(
  id: string,
  overrides: Partial<WorldItem> = {},
): WorldItem {
  return {
    id,
    type: 'test-item',
    title: id,
    x: 5,
    y: 6,
    z: 0,
    createdBy: 'creator',
    updatedBy: 'creator',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: [],
    params: {},
    carrierId: null,
    occupiedOffsets: [{ x: 0, y: 0 }],
    ...overrides,
  };
}

const player = { id: 'self', x: 5, y: 6, z: 0 };

describe('getInteractionItems', () => {
  it('returns all self-held items before items on the current square', () => {
    const heldOne = item('held-one', { carrierId: 'self', x: 100, y: 100, z: 40 });
    const heldTwo = item('held-two', { carrierId: 'self', x: -20, y: -20, z: -1 });
    const floorItem = item('floor-item');

    expect(getInteractionItems([floorItem, heldOne, heldTwo], player).map(({ id }) => id)).toEqual([
      'held-one',
      'held-two',
      'floor-item',
    ]);
  });

  it('excludes other users items, items on other floors, and items elsewhere', () => {
    const currentFloor = item('current-floor');
    const otherCarrier = item('other-carrier', { carrierId: 'other' });
    const otherFloor = item('other-floor', { z: 1 });
    const elsewhere = item('elsewhere', { x: 6 });

    expect(getInteractionItems([currentFloor, otherCarrier, otherFloor, elsewhere], player).map(({ id }) => id)).toEqual([
      'current-floor',
    ]);
  });

  it('uses the full item footprint when finding floor targets', () => {
    const multiCell = item('multi-cell', {
      x: 4,
      y: 5,
      occupiedOffsets: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    });

    expect(getInteractionItems([multiCell], player).map(({ id }) => id)).toEqual(['multi-cell']);
  });

  it('still finds floor targets when the local player id is null', () => {
    const currentFloor = item('current-floor');
    const otherCarrier = item('other-carrier', { carrierId: 'other' });

    expect(getInteractionItems([currentFloor, otherCarrier], { ...player, id: null }).map(({ id }) => id)).toEqual([
      'current-floor',
    ]);
  });

  it('does not return an item id more than once', () => {
    const held = item('same-item', { carrierId: 'self' });
    const duplicate = item('same-item');

    expect(getInteractionItems([held, duplicate], player).map(({ id }) => id)).toEqual(['same-item']);
  });
});
