import { describe, expect, it, vi } from 'vitest';
import { createInitialState, type NamedRegion } from '../state/gameState';
import { createOnMessageHandler } from './messageHandlers';
import { incomingMessageSchema } from './protocol';

describe('named region synchronization', () => {
  it('replaces stale regions on welcome and applies live updates before editor results', async () => {
    const region: NamedRegion = { id: 'studio', name: 'Studio', floorZ: 0, startX: 1, startY: 1, endX: 5, endY: 5 };
    const state = createInitialState();
    state.regions.set('stale', { ...region, id: 'stale' });
    const element = { classList: { add: vi.fn(), remove: vi.fn() }, focus: vi.fn() };
    const handleRegionActionResult = vi.fn();
    const provided = {
      state, handleRegionActionResult, getWorldGridSize: () => 41,
      peerManager: { setListenerPosition: vi.fn() },
      dom: { connectButton: element, disconnectButton: element, focusGridButton: element, canvas: element, instructions: element },
    };
    const deps = new Proxy(provided, {
      get: (target, key, receiver) => Reflect.has(target, key) ? Reflect.get(target, key, receiver) : vi.fn(),
    }) as unknown as Parameters<typeof createOnMessageHandler>[0];
    const handler = createOnMessageHandler(deps);
    await handler(incomingMessageSchema.parse({
      type: 'welcome', id: 'self', users: [], regions: [region],
      player: { id: 'self', nickname: 'Builder', x: 1, y: 1, z: 0, facingDeg: 0, acousticZoneId: 'floor:0' },
    }));
    expect([...state.regions.values()]).toEqual([region]);
    const renamed = { ...region, name: 'Theater' };
    await handler(incomingMessageSchema.parse({ type: 'region_upsert', region: renamed }));
    handleRegionActionResult.mockImplementation(() => expect(state.regions.get(region.id)).toEqual(renamed));
    await handler(incomingMessageSchema.parse({ type: 'region_action_result', ok: true, action: 'update', regionId: region.id, message: 'Theater' }));
    expect(handleRegionActionResult).toHaveBeenCalledOnce();
    await handler(incomingMessageSchema.parse({ type: 'region_remove', regionId: region.id }));
    expect(state.regions.size).toBe(0);
  });
});
