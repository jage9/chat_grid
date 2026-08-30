import { describe, expect, it } from 'vitest';
import { type WorldItem } from '../../../state/gameState';
import {
  resolveElevatorAmbienceStart,
  shouldPlayElevatorAmbience,
} from './runtime';

function elevator(params: Record<string, unknown>): WorldItem {
  return {
    id: 'elevator-1',
    type: 'elevator',
    title: 'Elevator',
    x: 10,
    y: 10,
    z: 0,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: [],
    params,
    occupiedOffsets: [{ x: 0, y: 0 }],
  };
}

describe('shouldPlayElevatorAmbience', () => {
  it('keeps cabin ambience for a passenger through closed and moving states', () => {
    const item = elevator({ currentZ: 0, state: 'moving', doorOpen: false });

    expect(shouldPlayElevatorAmbience(item, { x: 10, y: 10, z: 20 }, item.id, 15)).toBe(true);
  });

  it('keeps outside ambience loaded through opening and closing on the same landing', () => {
    const open = elevator({ currentZ: 40, state: 'door_open', doorOpen: true });
    const closing = elevator({ currentZ: 40, state: 'closing', doorOpen: false });

    expect(shouldPlayElevatorAmbience(open, { x: 25, y: 10, z: 40 }, null, 15)).toBe(true);
    expect(shouldPlayElevatorAmbience(open, { x: 10, y: 10, z: 0 }, null, 15)).toBe(false);
    expect(shouldPlayElevatorAmbience(closing, { x: 10, y: 10, z: 40 }, null, 15)).toBe(true);
  });
});

describe('resolveElevatorAmbienceStart', () => {
  it('always chooses a nonzero point within a finite file', () => {
    expect(resolveElevatorAmbienceStart(18, 0)).toBe(0.01);
    expect(resolveElevatorAmbienceStart(18, 0.5)).toBeGreaterThan(0);
    expect(resolveElevatorAmbienceStart(18, 1)).toBeLessThan(18);
  });
});
