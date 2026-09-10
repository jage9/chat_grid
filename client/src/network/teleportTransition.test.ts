import { describe, expect, it, vi } from 'vitest';
import { incomingMessageSchema } from './protocol';
import { createOnMessageHandler } from './messageHandlers';
import { createInitialState } from '../state/gameState';

describe('server teleport transitions', () => {
  it('routes each phase without predicting a position or sending completion', async () => {
    const state = createInitialState();
    const original = { ...state.player };
    const handleTeleportTransition = vi.fn();
    const provided = { state, handleTeleportTransition };
    const deps = new Proxy(provided, {
      get(target, key, receiver) {
        return Reflect.has(target, key) ? Reflect.get(target, key, receiver) : vi.fn();
      },
    }) as unknown as Parameters<typeof createOnMessageHandler>[0];
    const handler = createOnMessageHandler(deps);
    for (const phase of ['start', 'arrive', 'complete', 'cancel']) {
      const packet = incomingMessageSchema.parse({
        type: 'teleport_transition', phase, x: 10, y: 20, z: 40, durationMs: 2000,
      });
      await handler(packet);
      expect(handleTeleportTransition).toHaveBeenLastCalledWith(packet);
      expect(state.player).toEqual(original);
    }
  });

  it('rejects malformed transition phases and coordinates', () => {
    const packet = { type: 'teleport_transition', phase: 'start', x: 10, y: 20, z: 40, durationMs: 2000 };
    for (const invalid of [{ phase: 'move' }, { x: 1.5 }, { durationMs: 0 }]) {
      expect(incomingMessageSchema.safeParse({ ...packet, ...invalid }).success).toBe(false);
    }
  });
});
