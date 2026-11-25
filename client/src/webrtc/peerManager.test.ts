import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState, RoomEvent, Track, type LocalAudioTrack } from 'livekit-client';
import type { AudioEngine } from '../audio/audioEngine';
import { PeerManager, type PeerRuntime } from './peerManager';

const livekit = vi.hoisted(() => {
  class MockRoom {
    static instances: MockRoom[] = [];
    handlers = new Map<string, (...args: unknown[]) => void>();
    state = 'disconnected';
    remoteParticipants = new Map<string, unknown>();
    localParticipant = { publishTrack: vi.fn(async (_track: LocalAudioTrack): Promise<void> => undefined) };
    connect = vi.fn(async (_url: string, _token: string) => { this.state = 'connected'; });
    disconnect = vi.fn(async (_stopTracks?: boolean) => {
      this.state = 'disconnected';
      this.emit('disconnected');
    });
    removeAllListeners = vi.fn(() => { this.handlers.clear(); });
    constructor() { MockRoom.instances.push(this); }
    on(event: string, handler: (...args: unknown[]) => void) { this.handlers.set(event, handler); }
    emit(event: string, ...args: unknown[]) { this.handlers.get(event)?.(...args); }
  }
  return { MockRoom };
});

vi.mock('livekit-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('livekit-client')>();
  return {
    ...original,
    Room: livekit.MockRoom,
    LocalAudioTrack: class {
      constructor(public mediaStreamTrack: MediaStreamTrack) {}
      replaceTrack = vi.fn(async (track: MediaStreamTrack) => {
        this.mediaStreamTrack = track;
        return this;
      });
    },
  };
});

function setup() {
  let running = true;
  const status = vi.fn();
  const requestToken = vi.fn();
  const attachRemoteStream = vi.fn(async () => undefined);
  const audio = { cleanupPeerAudio: vi.fn(), isVoiceLayerEnabled: () => true, attachRemoteStream } as unknown as AudioEngine;
  const manager = new PeerManager(audio, status, {
    isSessionRunning: () => running,
    requestToken,
  });
  return { manager, status, requestToken, attachRemoteStream, stopGrid: () => { running = false; } };
}

function latestRoom() {
  return livekit.MockRoom.instances[livekit.MockRoom.instances.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  livekit.MockRoom.instances = [];
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('LiveKit voice recovery', () => {
  it('range-gates subscriptions in 3D while retaining the world connectivity resolver', async () => {
    const { manager } = setup();
    const connectedZones = vi.fn((peer: PeerRuntime) => peer.acousticZoneId === 'cabin-a');
    manager.setSubscriptionResolver(connectedZones);
    const peer = manager.ensurePeer('speaker', { x: 20, y: 0, z: 0, acousticZoneId: 'cabin-a' });
    const setSubscribed = vi.fn();
    const publication = { setSubscribed };
    await manager.connectToRoom('wss://voice.test', 'token');
    const room = latestRoom();
    room.remoteParticipants.set('speaker', { audioTrackPublications: new Map([['audio', publication]]) });

    manager.setPeerPosition(peer.id, 20, 0, 0, 'cabin-a');
    expect(setSubscribed).toHaveBeenLastCalledWith(true);
    manager.setPeerPosition(peer.id, 20, 0, 1, 'cabin-a');
    expect(setSubscribed).toHaveBeenLastCalledWith(false);
    manager.setPeerPosition(peer.id, 0, 0, 20, 'cabin-a');
    expect(setSubscribed).toHaveBeenLastCalledWith(true);
    manager.setListenerPosition(0, 0, -1);
    expect(setSubscribed).toHaveBeenLastCalledWith(false);
    manager.setListenerPosition(0, 0, 0);
    expect(setSubscribed).toHaveBeenLastCalledWith(true);
    manager.setPeerPosition(peer.id, 20, 0, 0, 'cabin-a');
    manager.setListenerPosition(-1, 0, 0);
    expect(setSubscribed).toHaveBeenLastCalledWith(false);
    manager.setListenerPosition(1, 0, 0);
    expect(setSubscribed).toHaveBeenLastCalledWith(true);
    manager.setPeerPosition(peer.id, 0, 0, 0, 'cabin-b');
    expect(setSubscribed).toHaveBeenLastCalledWith(false);
    expect(connectedZones).toHaveBeenCalled();
    manager.cleanupAll();
  });

  it.each([false, true])('waits for signaling identity when voice arrives first (placeholder %s)', async (placeholder) => {
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    const { manager, attachRemoteStream } = setup();
    manager.setVoiceMuteResolver((peer) => peer.userId === 'muted-account');
    if (placeholder) manager.ensurePeer('new-session', { nickname: 'user...', x: 0, y: 0, z: 0 });
    await manager.connectToRoom('wss://voice.test', 'token');
    latestRoom().emit(
      RoomEvent.TrackSubscribed,
      { kind: Track.Kind.Audio, mediaStreamTrack: {} },
      { setSubscribed: vi.fn() },
      { identity: 'new-session' },
    );
    expect(attachRemoteStream).not.toHaveBeenCalled();
    if (!placeholder) manager.ensurePeer('new-session', { nickname: 'user...' });
    expect(attachRemoteStream).not.toHaveBeenCalled();
    const peer = manager.ensurePeer('new-session', { userId: 'muted-account', x: 0, y: 0, z: 0 });
    expect(peer.voiceMuted).toBe(true);
    expect(attachRemoteStream).toHaveBeenCalledTimes(1);
    expect(attachRemoteStream).toHaveBeenCalledWith(expect.objectContaining({ voiceMuted: true }), expect.anything());
  });

  it('applies mute before a peer can attach audio and retains listen gain through refresh', () => {
    const { manager } = setup();
    let muted = true;
    manager.setVoiceMuteResolver((peer) => muted && peer.userId === 'speaker');
    const peer = manager.ensurePeer('session-1', { userId: 'speaker' });
    expect(peer.voiceMuted).toBe(true);
    manager.setPeerListenGain(peer.id, 0.4);
    const gain = { value: 0.4, cancelScheduledValues: vi.fn() };
    peer.gain = { gain } as unknown as GainNode;
    manager.refreshVoiceMutes();
    expect(gain.value).toBe(0);
    expect(manager.getPeerListenGain(peer.id)).toBe(0.4);
    muted = false;
    manager.refreshVoiceMutes();
    expect(peer.voiceMuted).toBe(false);
    expect(manager.getPeerListenGain(peer.id)).toBe(0.4);
    manager.ensurePeer('session-2', {});
    muted = true;
    expect(manager.ensurePeer('session-2', { userId: 'speaker' }).voiceMuted).toBe(true);
  });

  it('publishes the first microphone captured during an SDK reconnect', async () => {
    const { manager, status } = setup();
    await manager.connectToRoom('wss://voice.test', 'token');
    const room = latestRoom();
    room.state = ConnectionState.Reconnecting;
    room.emit(RoomEvent.Reconnecting);
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    await manager.replaceOutgoingTrack({ getAudioTracks: () => [track] } as MediaStream);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();

    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    await vi.advanceTimersByTimeAsync(0);

    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.objectContaining({ mediaStreamTrack: track }),
    );
    expect(status).toHaveBeenLastCalledWith('Voice reconnected.');
    manager.cleanupAll();
  });

  it('applies only the latest microphone replacement after an SDK reconnect', async () => {
    const { manager } = setup();
    const originalTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    await manager.replaceOutgoingTrack({ getAudioTracks: () => [originalTrack] } as MediaStream);
    await manager.connectToRoom('wss://voice.test', 'token');
    const room = latestRoom();
    const publishedTrack = room.localParticipant.publishTrack.mock.calls[0][0];
    room.state = ConnectionState.Reconnecting;
    room.emit(RoomEvent.Reconnecting);
    const replacedTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const latestTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    await manager.replaceOutgoingTrack({ getAudioTracks: () => [replacedTrack] } as MediaStream);
    await manager.replaceOutgoingTrack({ getAudioTracks: () => [latestTrack] } as MediaStream);
    expect(publishedTrack.mediaStreamTrack).toBe(originalTrack);

    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    await vi.advanceTimersByTimeAsync(0);

    expect(publishedTrack.mediaStreamTrack).toBe(latestTrack);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    manager.cleanupAll();
  });

  it('requests fresh credentials if microphone publication fails after an SDK reconnect', async () => {
    const { manager, status, requestToken } = setup();
    await manager.connectToRoom('wss://voice.test', 'token');
    const room = latestRoom();
    room.state = ConnectionState.Reconnecting;
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    await manager.replaceOutgoingTrack({ getAudioTracks: () => [track] } as MediaStream);
    room.localParticipant.publishTrack.mockRejectedValueOnce(new Error('publication failed'));

    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    await vi.advanceTimersByTimeAsync(2000);

    expect(status).not.toHaveBeenCalledWith('Voice reconnected.');
    expect(room.disconnect).toHaveBeenCalledWith(false);
    expect(requestToken).toHaveBeenCalledTimes(1);
    await manager.connectToRoom('wss://voice.test', 'fresh-token');
    expect(latestRoom().localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.objectContaining({ mediaStreamTrack: track }),
    );
    expect(status).toHaveBeenLastCalledWith('Voice reconnected.');
    manager.cleanupAll();
  });

  it.each([
    ['cleanup', 'success'],
    ['cleanup', 'failure'],
    ['room replacement', 'success'],
    ['room replacement', 'failure'],
  ])('ignores publication after %s followed by %s during SDK recovery', async (action, outcome) => {
    const { manager, status, requestToken } = setup();
    await manager.connectToRoom('wss://voice.test', 'token');
    const room = latestRoom();
    room.state = ConnectionState.Reconnecting;
    const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
    await manager.replaceOutgoingTrack({ getAudioTracks: () => [track] } as MediaStream);
    let finishPublication = () => {};
    room.localParticipant.publishTrack.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finishPublication = () => outcome === 'success' ? resolve() : reject(new Error('room closed'));
    }));

    room.state = ConnectionState.Connected;
    room.emit(RoomEvent.Reconnected);
    expect(status).not.toHaveBeenCalledWith('Voice reconnected.');
    if (action === 'cleanup') manager.cleanupAll();
    else await manager.connectToRoom('wss://voice.test', 'replacement-token');
    finishPublication();
    await vi.advanceTimersByTimeAsync(60000);

    expect(status).not.toHaveBeenCalled();
    expect(requestToken).not.toHaveBeenCalled();
    expect(livekit.MockRoom.instances).toHaveLength(action === 'cleanup' ? 1 : 2);
    if (action === 'room replacement') expect(latestRoom().state).toBe(ConnectionState.Connected);
    manager.cleanupAll();
  });

  it('requests at most three fresh credentials when no token response arrives', async () => {
    const { manager, status, requestToken } = setup();
    await manager.connectToRoom('wss://voice.test', 'old-token');
    const room = latestRoom();
    room.emit(RoomEvent.Disconnected);
    room.emit(RoomEvent.Disconnected);
    expect(status).toHaveBeenCalledWith('Voice reconnecting...');
    expect(requestToken).not.toHaveBeenCalled();
    for (const [index, delay] of [2000, 4000, 8000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(requestToken).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestToken).toHaveBeenCalledTimes(index + 1);
    }
    await vi.advanceTimersByTimeAsync(8000 - 1);
    expect(status).not.toHaveBeenCalledWith('Voice unavailable. Disconnect and connect to retry.');
    await vi.advanceTimersByTimeAsync(1);
    expect(status).toHaveBeenLastCalledWith('Voice unavailable. Disconnect and connect to retry.');
    await vi.advanceTimersByTimeAsync(60000);
    expect(requestToken).toHaveBeenCalledTimes(3);
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

  it('caps fresh-token retries when every join fails', async () => {
    const { manager, status, requestToken } = setup();
    await manager.connectToRoom('wss://voice.test', 'old-token');
    latestRoom().emit(RoomEvent.Disconnected);
    const originalConnect = livekit.MockRoom.prototype.on;
    const on = vi.spyOn(livekit.MockRoom.prototype, 'on').mockImplementation(function (this: InstanceType<typeof livekit.MockRoom>, event, handler) {
      this.connect.mockRejectedValue(new Error('voice unavailable'));
      return originalConnect.call(this, event, handler);
    });
    for (const [index, delay] of [2000, 4000, 8000].entries()) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(requestToken).toHaveBeenCalledTimes(index + 1);
      await expect(manager.connectToRoom('wss://voice.test', `fresh-token-${index + 1}`)).rejects.toThrow('voice unavailable');
    }
    on.mockRestore();
    await vi.advanceTimersByTimeAsync(60000);
    expect(requestToken).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenLastCalledWith('Voice unavailable. Disconnect and connect to retry.');
    expect(status).not.toHaveBeenCalledWith('Voice reconnected.');
    manager.cleanupAll();
  });

  it('resets the recovery budget after a successful rejoin', async () => {
    const { manager, requestToken } = setup();
    await manager.connectToRoom('wss://voice.test', 'old-token');
    latestRoom().emit(RoomEvent.Disconnected);
    await vi.advanceTimersByTimeAsync(2000);
    expect(requestToken).toHaveBeenCalledTimes(1);
    await manager.connectToRoom('wss://voice.test', 'fresh-token');

    latestRoom().emit(RoomEvent.Disconnected);
    await vi.advanceTimersByTimeAsync(2000);
    expect(requestToken).toHaveBeenCalledTimes(2);
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
