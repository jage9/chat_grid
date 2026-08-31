import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../state/gameState';
import { createOnMessageHandler } from './messageHandlers';

function setupRemoteMovement(acousticTransmission: number) {
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
  const playRemoteFootstep = vi.fn();
  const getPeerAcousticTransmission = vi.fn(() => acousticTransmission);
  const peerManager = {
    ensurePeer: vi.fn(),
    setPeerPosition: vi.fn(),
  };
  const provided = {
    state,
    peerManager,
    refreshAcousticModel: vi.fn(),
    getPeerAcousticTransmission,
    getAudioLayers: () => ({ world: true, item: true }),
    randomFootstepUrl: () => '/sounds/step-1.ogg',
    playRemoteFootstep,
  };
  const deps = new Proxy(provided, {
    get(target, property, receiver) {
      return Reflect.has(target, property) ? Reflect.get(target, property, receiver) : vi.fn();
    },
  }) as unknown as Parameters<typeof createOnMessageHandler>[0];

  return {
    getPeerAcousticTransmission,
    handler: createOnMessageHandler(deps),
    playRemoteFootstep,
  };
}

describe('remote movement audio', () => {
  it('suppresses footsteps across isolated acoustic zones', async () => {
    const { getPeerAcousticTransmission, handler, playRemoteFootstep } = setupRemoteMovement(0);

    await handler({
      type: 'update_position',
      id: 'peer-1',
      x: 5,
      y: 4,
      z: 0,
      acousticZoneId: 'floor:0',
    });

    expect(getPeerAcousticTransmission).toHaveBeenCalledWith('floor:0');
    expect(playRemoteFootstep).not.toHaveBeenCalled();
  });

  it('applies door transmission to audible remote footsteps', async () => {
    const { handler, playRemoteFootstep } = setupRemoteMovement(0.4);

    await handler({
      type: 'update_position',
      id: 'peer-1',
      x: 5,
      y: 4,
      z: 0,
      acousticZoneId: 'floor:0',
    });

    expect(playRemoteFootstep).toHaveBeenCalledWith(
      '/sounds/step-1.ogg',
      5,
      4,
      0,
      0.4,
    );
  });
});
