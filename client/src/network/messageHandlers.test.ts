import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../state/gameState';
import { createOnMessageHandler } from './messageHandlers';

function setupRemoteMovement() {
  const state = createInitialState();
  state.player.id = 'self';
  state.player.acousticZoneId = 'elevator:car-1';
  state.peers.set('peer-1', {
    id: 'peer-1',
    nickname: 'Other user',
    x: 4,
    y: 4,
    z: 0,
    acousticZoneId: 'floor:0',
  });
  const playWorldSound = vi.fn();
  const peerManager = {
    ensurePeer: vi.fn(),
    setPeerPosition: vi.fn(),
  };
  const provided = {
    state,
    peerManager,
    refreshAcousticModel: vi.fn(),
    randomFootstepUrl: () => '/sounds/step-1.ogg',
    playWorldSound,
  };
  const deps = new Proxy(provided, {
    get(target, property, receiver) {
      return Reflect.has(target, property) ? Reflect.get(target, property, receiver) : vi.fn();
    },
  }) as unknown as Parameters<typeof createOnMessageHandler>[0];

  return {
    handler: createOnMessageHandler(deps),
    playWorldSound,
  };
}

describe('remote movement audio', () => {
  it('routes footsteps with the authoritative peer acoustic zone', async () => {
    const { handler, playWorldSound } = setupRemoteMovement();

    await handler({
      type: 'update_position',
      id: 'peer-1',
      x: 5,
      y: 4,
      z: 0,
      acousticZoneId: 'floor:0',
    });

    expect(playWorldSound).toHaveBeenCalledWith('/sounds/step-1.ogg', {
      x: 5,
      y: 4,
      z: 0,
      acousticZoneId: 'floor:0',
      gain: 0.7,
    });
  });
});

describe('item target message routing', () => {
  it('routes hand target responses separately from ownership transfer targets', async () => {
    const handleItemTransferTargets = vi.fn();
    const handleItemHandTargets = vi.fn();
    const provided = {
      state: createInitialState(),
      handleItemTransferTargets,
      handleItemHandTargets,
    };
    const deps = new Proxy(provided, {
      get(target, property, receiver) {
        return Reflect.has(target, property) ? Reflect.get(target, property, receiver) : vi.fn();
      },
    }) as unknown as Parameters<typeof createOnMessageHandler>[0];
    const handler = createOnMessageHandler(deps);

    await handler({
      type: 'item_hand_targets',
      itemId: 'held-item',
      targets: [{ userId: 'nearby-user', username: 'Nearby user', online: true }],
    });

    expect(handleItemHandTargets).toHaveBeenCalledOnce();
    expect(handleItemTransferTargets).not.toHaveBeenCalled();
  });
});
