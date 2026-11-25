import { incomingMessageSchema } from './protocol';
import { describe, expect, it, vi } from 'vitest';
import { createInitialState, type WorldItem } from '../state/gameState';
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
    facingDeg: 0,
    acousticZoneId: 'floor:0',
  });
  const playWorldSound = vi.fn();
  const updateStatus = vi.fn();
  const pushChatMessage = vi.fn();
  const audioUiConfirm = vi.fn();
  const audioUiCancel = vi.fn();
  const shouldAnnounceItemPropertyEcho = vi.fn(() => true);
  const peerManager = {
    ensurePeer: vi.fn(),
    setPeerPosition: vi.fn(),
    setListenerPosition: vi.fn(),
  };
  const provided = {
    state,
    peerManager,
    refreshAcousticModel: vi.fn(),
    randomFootstepUrl: (x: number, y: number, z: number) => (x === 5 && y === 4 && z === 0 ? '/sounds/steps/bridge/plank.ogg' : '/sounds/steps/default/step-1.ogg'),
    playWorldSound,
    updateStatus,
    pushChatMessage,
    audioUiConfirm,
    audioUiCancel,
    getItemPropertyValue: (item: WorldItem, key: string) => key === 'title' ? item.title : String(item.params[key]),
    shouldAnnounceItemPropertyEcho,
  };
  const deps = new Proxy(provided, {
    get(target, property, receiver) {
      return Reflect.has(target, property) ? Reflect.get(target, property, receiver) : vi.fn();
    },
  }) as unknown as Parameters<typeof createOnMessageHandler>[0];

  return {
    handler: createOnMessageHandler(deps),
    playWorldSound,
    updateStatus,
    pushChatMessage,
    audioUiConfirm,
    audioUiCancel,
    shouldAnnounceItemPropertyEcho,
    state,
    peerManager,
  };
}

describe('remote account identity', () => {
  it('learns newly joining accounts and preserves identity across ordinary movement', async () => {
    const { handler, state } = setupRemoteMovement();
    const position = { type: 'update_position' as const, id: 'new-session', x: 3, y: 3, z: 0, facingDeg: 0 as const, acousticZoneId: 'floor:0' };
    await handler(incomingMessageSchema.parse({ ...position, userId: 'speaker-account' }));
    expect(state.peers.get('new-session')?.userId).toBe('speaker-account');
    await handler(incomingMessageSchema.parse({ ...position, x: 4 }));
    expect(state.peers.get('new-session')?.userId).toBe('speaker-account');
    await handler(incomingMessageSchema.parse({ ...position, id: 'placeholder' }));
    expect(state.peers.get('placeholder')?.userId).toBeNull();
    await handler(incomingMessageSchema.parse({ ...position, id: 'placeholder', userId: 'late-account' }));
    expect(state.peers.get('placeholder')?.userId).toBe('late-account');
  });
});

describe('item property update announcements', () => {
  it('announces the new parked height with an accepted elevator stop list', async () => {
    const { handler, updateStatus, state } = setupRemoteMovement();
    const item: WorldItem = {
      id: 'elevator', type: 'elevator', title: 'Elevator', x: 4, y: 4, z: 0,
      createdBy: 'owner', updatedBy: 'owner', createdAt: 0, updatedAt: 0, version: 1,
      params: { floorZs: [0, 40], currentZ: 0 }, capabilities: [], occupiedOffsets: [{ x: 0, y: 0 }],
    };
    state.items.set(item.id, item);
    state.selectedItemId = item.id;
    state.mode = 'itemProperties';
    state.itemPropertyKeys = ['floorZs'];
    state.itemPropertyIndex = 0;
    await handler({ type: 'item_upsert', item: { ...item, params: { floorZs: [20, 40], currentZ: 20 } } });
    expect(updateStatus).toHaveBeenLastCalledWith('20,40. Car parked at height 20.');
  });

  it('replaces the authored world after a restore and drops stale selection', async () => {
    const { handler, state } = setupRemoteMovement();
    state.mode = 'itemProperties';
    state.selectedItemId = 'gone';
    state.itemPropertyKeys = ['title'];
    state.elevatorItemId = 'gone';
    state.regions.set('gone', { id: 'gone', name: 'Removed', floorZ: 0, startX: 0, startY: 0, endX: 0, endY: 0 });
    await handler(incomingMessageSchema.parse({ type: 'world_restored', items: [], structures: [], ambiances: [], regions: [{ id: 'new', name: 'Studio', floorZ: 0, startX: 1, startY: 1, endX: 2, endY: 2 }] }));
    expect([...state.regions.keys()]).toEqual(['new']);
    expect(state.selectedItemId).toBeNull();
    expect(state.itemPropertyKeys).toEqual([]);
    expect(state.elevatorItemId).toBeNull();
    expect(state.mode).toBe('normal');
    expect(state.peers.has('peer-1')).toBe(true);
  });

  function selectedItem(): WorldItem {
    return {
      id: 'radio', type: 'radio_station', title: 'Studio radio',
      x: 0, y: 0, z: 0, createdBy: 'self', updatedBy: 'self',
      createdAt: 1, updatedAt: 1, version: 1,
      capabilities: [], carrierId: null, occupiedOffsets: [{ x: 0, y: 0 }],
      params: { volume: 50 },
    };
  }

  it('announces only the changed selected value and ignores unrelated property updates', async () => {
    const { handler, updateStatus, state } = setupRemoteMovement();
    const item = selectedItem();
    state.items.set(item.id, item);
    state.selectedItemId = item.id;
    state.mode = 'itemProperties';
    state.itemPropertyKeys = ['volume'];
    state.itemPropertyIndex = 0;

    await handler({ type: 'item_upsert', item: { ...item, title: 'Renamed radio', version: 2 } });
    expect(updateStatus).not.toHaveBeenCalled();
    await handler({ type: 'item_upsert', item: { ...item, version: 3, params: { volume: 55 } } });
    expect(updateStatus.mock.calls).toEqual([['55']]);
  });

  it('honors local arrow feedback suppression when the server confirms a changed value', async () => {
    const { handler, updateStatus, state, shouldAnnounceItemPropertyEcho } = setupRemoteMovement();
    const item = selectedItem();
    state.items.set(item.id, item);
    state.selectedItemId = item.id;
    state.mode = 'itemProperties';
    state.itemPropertyKeys = ['volume'];
    state.itemPropertyIndex = 0;
    shouldAnnounceItemPropertyEcho.mockReturnValue(false);

    await handler({ type: 'item_upsert', item: { ...item, version: 2, params: { volume: 55 } } });
    expect(updateStatus).not.toHaveBeenCalled();
    expect(state.items.get(item.id)?.params.volume).toBe(55);
  });
});

describe('item duplication results', () => {
  it('announces success once through the usual message flow and stays in normal mode', async () => {
    const { handler, pushChatMessage, audioUiConfirm, audioUiCancel, state } = setupRemoteMovement();
    const message = 'You duplicated Piano (piano) here.';

    await handler({ type: 'item_action_result', action: 'duplicate', ok: true, itemId: 'copy', message });

    expect(pushChatMessage).toHaveBeenCalledOnce();
    expect(pushChatMessage).toHaveBeenCalledWith(message);
    expect(audioUiConfirm).toHaveBeenCalledOnce();
    expect(audioUiCancel).not.toHaveBeenCalled();
    expect(state.mode).toBe('normal');
    expect(state.selectedItemId).toBeNull();
  });

  it('announces duplication failure through the usual error flow', async () => {
    const { handler, pushChatMessage, audioUiConfirm, audioUiCancel, state } = setupRemoteMovement();
    const message = 'You already own the maximum of 500 items.';

    await handler({ type: 'item_action_result', action: 'duplicate', ok: false, message });

    expect(pushChatMessage).toHaveBeenCalledOnce();
    expect(pushChatMessage).toHaveBeenCalledWith(message);
    expect(audioUiCancel).toHaveBeenCalledOnce();
    expect(audioUiConfirm).not.toHaveBeenCalled();
    expect(state.mode).toBe('normal');
  });
});

describe('local facing announcements', () => {
  it('updates listener position for every confirmed local xyz movement', async () => {
    const { handler, peerManager } = setupRemoteMovement();
    await handler({
      type: 'update_position', id: 'self', x: 9, y: 13, z: 25,
      facingDeg: 0, acousticZoneId: 'cabin:1',
    });
    expect(peerManager.setListenerPosition).toHaveBeenCalledWith(9, 13, 25);
  });

  it('announces a confirmed local facing change as the compass direction', async () => {
    const { handler, updateStatus } = setupRemoteMovement();

    await handler({
      type: 'update_position',
      id: 'self',
      x: 4,
      y: 4,
      z: 0,
      facingDeg: 90,
      acousticZoneId: 'elevator:car-1',
    });

    expect(updateStatus).toHaveBeenCalledWith('east');
  });

  it('does not announce unchanged local facing or remote facing updates', async () => {
    const { handler, updateStatus } = setupRemoteMovement();

    await handler({
      type: 'update_position',
      id: 'self',
      x: 4,
      y: 4,
      z: 0,
      facingDeg: 0,
      acousticZoneId: 'elevator:car-1',
    });
    await handler({
      type: 'update_position',
      id: 'peer-1',
      x: 4,
      y: 4,
      z: 0,
      facingDeg: 90,
      acousticZoneId: 'floor:0',
    });

    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe('remote movement audio', () => {
  it('routes footsteps with the authoritative peer acoustic zone', async () => {
    const { handler, playWorldSound, state } = setupRemoteMovement();

    await handler({
      type: 'update_position',
      id: 'peer-1',
      x: 5,
      y: 4,
      z: 0,
      facingDeg: 90,
      acousticZoneId: 'floor:0',
    });

    expect(playWorldSound).toHaveBeenCalledWith('/sounds/steps/bridge/plank.ogg', {
      x: 5,
      y: 4,
      z: 0,
      acousticZoneId: 'floor:0',
      gain: 0.7,
    });
    expect(state.peers.get('peer-1')?.facingDeg).toBe(90);
  });

  it('does not play a footstep for a facing-only presence update', async () => {
    const { handler, playWorldSound } = setupRemoteMovement();

    await handler({
      type: 'update_position',
      id: 'peer-1',
      x: 4,
      y: 4,
      z: 0,
      facingDeg: 135,
      acousticZoneId: 'floor:0',
    });

    expect(playWorldSound).not.toHaveBeenCalled();
  });
});

describe('item target message routing', () => {
  it('preserves elevator landing and cabin cue positions instead of moving them to the listener floor', async () => {
    const state = createInitialState();
    state.player.z = 40;
    state.player.acousticZoneId = 'floor:40';
    const elevator: WorldItem = {
      id: 'car', type: 'elevator', title: 'Elevator', x: 4, y: 4, z: 0,
      createdBy: 'owner', updatedBy: 'owner', createdAt: 0, updatedAt: 0, version: 1,
      params: { floorZs: [0, 20, 40], currentZ: 0 }, capabilities: [], occupiedOffsets: [{ x: 0, y: 0 }],
    };
    state.items.set(elevator.id, elevator);
    const playWorldSound = vi.fn();
    const handler = createOnMessageHandler({
      state, playWorldSound, resolveIncomingSoundUrl: (url: string) => url,
    } as unknown as Parameters<typeof createOnMessageHandler>[0]);
    for (const acousticZoneId of ['floor:0', 'elevator:car']) {
      const packet = {
        type: 'item_use_sound' as const, itemId: 'car', sound: '/sounds/elevator_up.ogg',
        x: 4, y: 4, z: 0, acousticZoneId, range: 15,
      };
      await handler(packet);
      expect(playWorldSound).toHaveBeenLastCalledWith(packet.sound, packet);
    }
  });

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

it('validates and forwards each fresh LiveKit token to the voice connection', async () => {
  const connectToLiveKit = vi.fn();
  const handler = createOnMessageHandler({
    connectToLiveKit,
  } as unknown as Parameters<typeof createOnMessageHandler>[0]);

  for (const token of ['initial-token', 'fresh-token']) {
    await handler(incomingMessageSchema.parse({ type: 'livekit_token', url: 'wss://voice.test', token }));
  }

  expect(connectToLiveKit.mock.calls).toEqual([
    ['wss://voice.test', 'initial-token'],
    ['wss://voice.test', 'fresh-token'],
  ]);
});
