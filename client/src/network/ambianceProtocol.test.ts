import { describe, expect, it, vi } from 'vitest';
import { createInitialState, type AmbianceRegion } from '../state/gameState';
import { createOnMessageHandler } from './messageHandlers';
import { incomingMessageSchema } from './protocol';

const ambiance: AmbianceRegion = {
  id: 'forest-region', name: 'Garden', soundId: 'forest', floorZ: 0,
  startX: 4, startY: 4, endX: 8, endY: 8, volume: 25, fadeDistance: 3,
};

function setup() {
  const state = createInitialState();
  const element = { classList: { add: vi.fn(), remove: vi.fn() }, focus: vi.fn() };
  const setAmbianceTypes = vi.fn();
  const handleAmbianceActionResult = vi.fn();
  const provided = {
    state, setAmbianceTypes, handleAmbianceActionResult,
    getWorldGridSize: () => 41,
    peerManager: { setListenerFloor: vi.fn() },
    dom: { connectButton: element, disconnectButton: element, focusGridButton: element, canvas: element, instructions: element },
  };
  const deps = new Proxy(provided, {
    get: (target, property, receiver) => Reflect.has(target, property) ? Reflect.get(target, property, receiver) : vi.fn(),
  }) as unknown as Parameters<typeof createOnMessageHandler>[0];
  return { state, setAmbianceTypes, handleAmbianceActionResult, handler: createOnMessageHandler(deps) };
}

describe('ambiance network state', () => {
  it('hydrates server catalog and replaces stale regions on welcome', async () => {
    const { state, handler, setAmbianceTypes } = setup();
    state.ambiances.set('old', { ...ambiance, id: 'old' });
    const types = [{ id: 'forest', title: 'Forest', url: '/sounds/ambiances/forest.ogg' }];
    await handler(incomingMessageSchema.parse({
      type: 'welcome', id: 'self', users: [], ambiances: [ambiance],
      player: { id: 'self', nickname: 'Builder', x: 4, y: 4, z: 0, facingDeg: 0, acousticZoneId: 'floor:0' },
      worldConfig: { gridSize: 41, floors: [], ambianceTypes: types },
    }));
    expect(setAmbianceTypes).toHaveBeenCalledWith(types);
    expect([...state.ambiances.values()]).toEqual([ambiance]);
  });

  it('applies authoritative updates before routing editor results and supports removal', async () => {
    const { state, handler, handleAmbianceActionResult } = setup();
    const updated = { ...ambiance, endX: 10, volume: 35 };
    await handler(incomingMessageSchema.parse({ type: 'ambiance_upsert', ambiance: updated }));
    handleAmbianceActionResult.mockImplementation(() => expect(state.ambiances.get(ambiance.id)).toEqual(updated));
    await handler(incomingMessageSchema.parse({ type: 'ambiance_action_result', ok: true, action: 'add', ambianceId: ambiance.id, message: 'Added Garden.' }));
    expect(handleAmbianceActionResult).toHaveBeenCalledOnce();
    await handler(incomingMessageSchema.parse({ type: 'ambiance_remove', ambianceId: ambiance.id }));
    expect(state.ambiances.size).toBe(0);
  });

  it('rejects invalid region audio values at the client protocol boundary', () => {
    for (const patch of [{ volume: 101 }, { fadeDistance: -1 }, { fadeDistance: Infinity }]) {
      expect(incomingMessageSchema.safeParse({ type: 'ambiance_upsert', ambiance: { ...ambiance, ...patch } }).success).toBe(false);
    }
  });
});
