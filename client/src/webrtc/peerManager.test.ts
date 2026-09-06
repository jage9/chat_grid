import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState, RoomEvent } from 'livekit-client';
import type { AudioEngine } from '../audio/audioEngine';
import { PeerManager } from './peerManager';

const livekit = vi.hoisted(() => {
  class MockRoom {
    static instances: MockRoom[] = [];
    handlers = new Map<string, () => void>();
    state = 'disconnected';
    remoteParticipants = new Map<string, unknown>();
    localParticipant = { publishTrack: vi.fn(async () => undefined) };
    connect = vi.fn(async (_url: string, _token: string) => { this.state = 'connected'; });
    disconnect = vi.fn(async (_stopTracks?: boolean) => {
      this.state = 'disconnected';
      this.emit('disconnected');
    });
    removeAllListeners = vi.fn(() => { this.handlers.clear(); });
    constructor() { MockRoom.instances.push(this); }
    on(event: string, handler: () => void) { this.handlers.set(event, handler); }
    emit(event: string) { this.handlers.get(event)?.(); }
  }
  return { MockRoom };
});

vi.mock('livekit-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('livekit-client')>();
  return {
    ...original,
    Room: livekit.MockRoom,
    LocalAudioTrack: class {
      constructor(readonly mediaStreamTrack: MediaStreamTrack) {}
    },
  };
});

function setup() {
  let running = true;
  const status = vi.fn();
  const requestToken = vi.fn();
  const audio = { cleanupPeerAudio: vi.fn() } as unknown as AudioEngine;
  const manager = new PeerManager(audio, status, {
    isSessionRunning: () => running,
    requestToken,
  });
  return { manager, status, requestToken, stopGrid: () => { running = false; } };
}

function latestRoom() {
  return livekit.MockRoom.instances[livekit.MockRoom.instances.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  livekit.MockRoom.instances = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('LiveKit voice recovery', () => {
  it('requests fresh credentials with capped backoff without reusing the old token', async () => {
    const { manager, status, requestToken } = setup();
    await manager.connectToRoom('wss://voice.test', 'old-token');
    const room = latestRoom();
    room.emit(RoomEvent.Disconnected);
    room.emit(RoomEvent.Disconnected);
    expect(status).toHaveBeenCalledWith('Voice reconnecting...');
    expect(requestToken).not.toHaveBeenCalled();
    for (const [index, delay] of [2000, 4000, 8000, 16000, 30000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(requestToken).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestToken).toHaveBeenCalledTimes(index + 1);
    }
    expect(room.connect).toHaveBeenCalledTimes(1);
    expect(livekit.MockRoom.instances).toHaveLength(1);
    manager.cleanupAll();
  });

  it('cancels token retries and republishes the existing outbound track on a fresh join', async () => {
    const { manager, status, requestToken } = setup();
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    await manager.replaceOutgoingTrack({ getAudioTracks: () => [track] } as MediaStream);
    const peer = manager.ensurePeer('peer', { nickname: 'Other user' });
    await manager.connectToRoom('wss://voice.test', 'old-token');
    latestRoom().emit(RoomEvent.Disconnected);
    await vi.advanceTimersByTimeAsync(2000);
    await manager.connectToRoom('wss://voice.test', 'fresh-token');
    const room = latestRoom();
    expect(room.connect).toHaveBeenCalledWith('wss://voice.test', 'fresh-token');
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(expect.objectContaining({ mediaStreamTrack: track }));
    expect(manager.ensurePeer('peer', {})).toBe(peer);
    expect(status).toHaveBeenLastCalledWith('Voice reconnected.');
    await vi.advanceTimersByTimeAsync(60000);
    expect(requestToken).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
    manager.cleanupAll();
  });

  it('does not recover during intentional room replacement or cleanup', async () => {
    const { manager, status, requestToken } = setup();
    await manager.connectToRoom('wss://voice.test', 'first-token');
    const oldRoom = latestRoom();
    await manager.connectToRoom('wss://voice.test', 'second-token');
    expect(oldRoom.disconnect).toHaveBeenCalledWith(false);
    manager.cleanupAll();
    oldRoom.emit(RoomEvent.Disconnected);
    await vi.advanceTimersByTimeAsync(60000);
    expect(requestToken).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it.each(['cleanup', 'grid stopped'])('stops pending retries after %s', async (action) => {
    const { manager, requestToken, stopGrid } = setup();
    await manager.connectToRoom('wss://voice.test', 'token');
    latestRoom().emit(RoomEvent.Disconnected);
    if (action === 'cleanup') manager.cleanupAll();
    else stopGrid();
    await vi.advanceTimersByTimeAsync(60000);
    expect(requestToken).not.toHaveBeenCalled();
    manager.cleanupAll();
  });

  it('requests another fresh token if the join fails', async () => {
    const { manager, status, requestToken } = setup();
    await manager.connectToRoom('wss://voice.test', 'old-token');
    latestRoom().emit(RoomEvent.Disconnected);
    await vi.advanceTimersByTimeAsync(2000);
    const originalConnect = livekit.MockRoom.prototype.on;
    const on = vi.spyOn(livekit.MockRoom.prototype, 'on').mockImplementation(function (this: InstanceType<typeof livekit.MockRoom>, event, handler) {
      this.connect.mockRejectedValue(new Error('voice unavailable'));
      return originalConnect.call(this, event, handler);
    });
    await expect(manager.connectToRoom('wss://voice.test', 'fresh-token')).rejects.toThrow('voice unavailable');
    on.mockRestore();
    await vi.advanceTimersByTimeAsync(4000);
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(status).not.toHaveBeenCalledWith('Voice reconnected.');
    manager.cleanupAll();
  });

  it('does not revive a pending join after cleanup', async () => {
    const { manager, status, requestToken } = setup();
    let finishConnect = () => {};
    const originalOn = livekit.MockRoom.prototype.on;
    const on = vi.spyOn(livekit.MockRoom.prototype, 'on').mockImplementation(function (this: InstanceType<typeof livekit.MockRoom>, event, handler) {
      this.connect.mockImplementation(() => new Promise<void>((resolve) => { finishConnect = resolve; }));
      return originalOn.call(this, event, handler);
    });
    const connecting = manager.connectToRoom('wss://voice.test', 'token');
    const room = latestRoom();
    manager.cleanupAll();
    room.state = ConnectionState.Connected;
    finishConnect();
    expect(await connecting).toBe(false);
    expect(room.state).toBe(ConnectionState.Disconnected);
    on.mockRestore();
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(requestToken).not.toHaveBeenCalled();
  });
});
