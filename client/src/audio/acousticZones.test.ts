import { describe, expect, it } from 'vitest';
import type { WorldItem } from '../state/gameState';
import {
  AcousticZoneRuntime,
  elevatorAcousticZoneId,
  floorAcousticZoneId,
  worldItemAcousticZoneId,
} from './acousticZones';

function elevator(state: string, currentZ = 0): WorldItem {
  return {
    id: 'car-1',
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
    params: { state, currentZ },
    occupiedOffsets: [{ x: 0, y: 0 }],
  };
}

describe('AcousticZoneRuntime', () => {
  it('connects outdoor elevations for voice, emitters and one-shots while isolating a moving cabin', () => {
    const runtime = new AcousticZoneRuntime();
    const items = new Map([['car-1', elevator('moving', 0)]]);
    runtime.sync(items.values(), 0);

    const ground = floorAcousticZoneId(0);
    const above = floorAcousticZoneId(1);
    expect(runtime.transmission(ground, above, items, 1000)).toBe(1);
    expect(runtime.couldConnect(above, ground, items)).toBe(true);
    expect(runtime.canTransmit(ground, above, items)).toBe(true);
    expect(runtime.transmission(above, elevatorAcousticZoneId('car-1'), items)).toBe(0);
    expect(runtime.transmission(elevatorAcousticZoneId('car-1'), elevatorAcousticZoneId('car-1'), items, 1000)).toBe(1);
  });

  it('ramps transmission in while opening and out while closing', () => {
    const runtime = new AcousticZoneRuntime();
    const opening = elevator('opening');
    const items = new Map([['car-1', opening]]);
    runtime.sync(items.values(), 0);

    const cabin = elevatorAcousticZoneId('car-1');
    const floor = floorAcousticZoneId(0);
    expect(runtime.transmission(cabin, floor, items, 0)).toBe(0);
    expect(runtime.transmission(cabin, floor, items, 1300)).toBeGreaterThan(0.5);

    opening.params.state = 'closing';
    runtime.sync(items.values(), 3000);
    expect(runtime.transmission(cabin, floor, items, 3000)).toBe(1);
    expect(runtime.transmission(cabin, floor, items, 7000)).toBe(0);
  });

  it('keeps a closed landed cabin subscribed but disconnects it while moving', () => {
    const runtime = new AcousticZoneRuntime();
    const item = elevator('idle', 40);
    const items = new Map([['car-1', item]]);
    const cabin = elevatorAcousticZoneId('car-1');

    expect(runtime.couldConnect(cabin, floorAcousticZoneId(40), items)).toBe(true);
    item.params.state = 'moving';
    expect(runtime.couldConnect(cabin, floorAcousticZoneId(40), items)).toBe(false);
  });

  it('admits one-shots during door transitions but not while landed closed', () => {
    const runtime = new AcousticZoneRuntime();
    const item = elevator('idle');
    const items = new Map([['car-1', item]]);
    const cabin = elevatorAcousticZoneId('car-1');
    const floor = floorAcousticZoneId(0);

    expect(runtime.canTransmit(cabin, floor, items)).toBe(false);
    item.params.state = 'opening';
    expect(runtime.canTransmit(cabin, floor, items)).toBe(true);
    item.params.state = 'moving';
    expect(runtime.canTransmit(cabin, floor, items)).toBe(false);
  });

  it('places a multi-floor item on the listener-connected landing', () => {
    const car = elevator('door_open', 40);
    car.params.floorZs = [0, 40];
    const state = { player: { id: 'local', z: 40, acousticZoneId: 'floor:40' }, peers: new Map() };
    expect(worldItemAcousticZoneId(car, state)).toBe('floor:40');
    const carried = { ...car, carrierId: 'rider' };
    state.peers.set('rider', { acousticZoneId: 'elevator:other' });
    expect(worldItemAcousticZoneId(carried, state)).toBe('elevator:other');
  });
});
