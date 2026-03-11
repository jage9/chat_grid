import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalTrack,
  LocalAudioTrack,
  type AudioCaptureOptions,
} from 'livekit-client';
import { AudioEngine, type SpatialPeerRuntime } from '../audio/audioEngine';
import type { RemoteUser } from '../network/protocol';

export type PeerRuntime = SpatialPeerRuntime & {
  id: string;
  remoteStream?: MediaStream;
};

type StatusHandler = (message: string) => void;

export class PeerManager {
  private readonly peers = new Map<string, PeerRuntime>();
  private outputDeviceId = '';
  private room: Room | null = null;
  private localTrack: LocalAudioTrack | null = null;

  constructor(
    private readonly audio: AudioEngine,
    private readonly status: StatusHandler,
  ) {}

  getPeer(id: string): PeerRuntime | undefined {
    return this.peers.get(id);
  }

  getPeers(): Iterable<PeerRuntime> {
    return this.peers.values();
  }

  /** Connect to a LiveKit room using the provided token and URL. */
  async connectToRoom(url: string, token: string): Promise<void> {
    if (this.room) {
      await this.room.disconnect();
    }

    const room = new Room({
      audioCaptureDefaults: {
        sampleRate: 48000,
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } as AudioCaptureOptions,
      audioOutput: {
        deviceId: this.outputDeviceId || undefined,
      },
      publishDefaults: {
        audioPreset: {
          maxBitrate: 128_000,
        },
        dtx: false,
        red: true,
        stopMicTrackOnMute: false,
      },
    });

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      void this.handleRemoteTrackSubscribed(participant, track);
    });

    room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      const peer = this.peers.get(participant.identity);
      if (peer) {
        this.audio.cleanupPeerAudio(peer);
        peer.remoteStream = undefined;
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      const peer = this.peers.get(participant.identity);
      if (peer) {
        this.audio.cleanupPeerAudio(peer);
        peer.remoteStream = undefined;
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      this.status('LiveKit disconnected.');
    });

    room.on(RoomEvent.Reconnecting, () => {
      this.status('LiveKit reconnecting...');
    });

    room.on(RoomEvent.Reconnected, () => {
      this.status('LiveKit reconnected.');
    });

    await room.connect(url, token);
    this.room = room;
  }

  /** Ensure a peer entry exists for a given user (called when roster arrives). */
  ensurePeer(targetId: string, userData: Partial<RemoteUser>): PeerRuntime {
    const existing = this.peers.get(targetId);
    if (existing) return existing;

    const peer: PeerRuntime = {
      id: targetId,
      nickname: userData.nickname ?? 'user...',
      x: userData.x ?? 20,
      y: userData.y ?? 20,
      listenGain: 1,
    };

    this.peers.set(targetId, peer);
    return peer;
  }

  /** Publish a local audio stream to the LiveKit room. */
  async replaceOutgoingTrack(stream: MediaStream): Promise<void> {
    const newTrack = stream.getAudioTracks()[0];
    if (!newTrack) return;

    if (!this.room) return;

    if (this.localTrack) {
      // Replace the underlying MediaStreamTrack on the existing LiveKit track.
      await this.localTrack.replaceTrack(newTrack);
    } else {
      const localAudioTrack = new LocalAudioTrack(newTrack, undefined, false);
      await this.room.localParticipant.publishTrack(localAudioTrack, {
        audioPreset: {
          maxBitrate: 128_000,
        },
        dtx: false,
        red: true,
        stopMicTrackOnMute: false,
      });
      this.localTrack = localAudioTrack;
    }
  }

  removePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.audio.cleanupPeerAudio(peer);
    this.peers.delete(id);
  }

  cleanupAll(): void {
    for (const id of this.peers.keys()) {
      this.removePeer(id);
    }
    if (this.room) {
      void this.room.disconnect();
      this.room = null;
    }
    this.localTrack = null;
  }

  setPeerPosition(id: string, x: number, y: number): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.x = x;
    peer.y = y;
  }

  setPeerNickname(id: string, nickname: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.nickname = nickname;
  }

  setPeerListenGain(id: string, gain: number): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.listenGain = gain;
  }

  getPeerListenGain(id: string): number {
    const peer = this.peers.get(id);
    if (!peer) return 1;
    return Number.isFinite(peer.listenGain) ? Math.max(0, peer.listenGain as number) : 1;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    for (const peer of this.peers.values()) {
      if (!peer.audioElement) continue;
      const sinkTarget = peer.audioElement as HTMLMediaElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      await sinkTarget.setSinkId?.(deviceId).catch(() => undefined);
    }
  }

  suspendRemoteAudio(): void {
    for (const peer of this.peers.values()) {
      this.audio.cleanupPeerAudio(peer);
    }
  }

  async resumeRemoteAudio(): Promise<void> {
    for (const peer of this.peers.values()) {
      if (!peer.remoteStream) continue;
      await this.audio.attachRemoteStream(peer, peer.remoteStream, this.outputDeviceId);
    }
  }

  private async handleRemoteTrackSubscribed(participant: RemoteParticipant, track: RemoteTrack): Promise<void> {
    const mediaStreamTrack = track.mediaStreamTrack;
    if (!mediaStreamTrack) return;

    const stream = new MediaStream([mediaStreamTrack]);
    const peer = this.peers.get(participant.identity);
    if (!peer) return;

    peer.remoteStream = stream;
    if (this.audio.isVoiceLayerEnabled()) {
      await this.audio.attachRemoteStream(peer, stream, this.outputDeviceId);
    } else {
      this.audio.cleanupPeerAudio(peer);
    }
  }
}
