import { describe, expect, it } from 'vitest';
import { formatLocationReadout } from './locationReadout';

describe('location readout', () => {
  const studio = { id: 'studio', name: 'Studio', floorZ: 0, startX: 0, endX: 8, startY: 0, endY: 8 };
  const closet = { ...studio, id: 'closet', name: 'Closet', startX: 4, endX: 4 };
  const regions = new Map([studio, closet].map(region => [region.id, region]));
  const floor = { id: 'main', name: 'Main floor', z: 0, startX: 0, endX: 10, startY: 0, endY: 10 };
  const platforms = new Map([[floor.id, floor]]);
  const state = { regions, platforms };

  it('reads the regions at the requested position smallest first, then the platform', () => {
    expect(formatLocationReadout(state, { x: 4, y: 7, z: 0 })).toBe('4, 7, 0, Closet, Studio, Main floor');
  });

  it('omits absent names and preserves fractional coordinates', () => {
    expect(formatLocationReadout(state, { x: 9.5, y: 7, z: 0 })).toBe('9.5, 7, 0, Main floor');
    expect(formatLocationReadout(state, { x: 4, y: 7, z: 1 })).toBe('4, 7, 1');
  });
});
