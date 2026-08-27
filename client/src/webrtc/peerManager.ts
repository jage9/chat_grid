import {
  LocalAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import { AudioEngine, type SpatialPeerRuntime } from '../audio/audioEngine';
import type { RemoteUser } from '../network/protocol';

export type PeerRuntime = SpatialPeerRuntime & {
  id: string;
  remoteStream?: MediaStream;
};

type StatusHandler = (message: string) => void;

/** Owns the LiveKit room and maps its audio tracks to grid participants. */
export class PeerManager {
  private readonly peers = new Map<string, PeerRuntime>();
  private readonly pendingRemoteStreams = new Map<string, MediaStream>();
  private outputDeviceId = '';
  private room: Room | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private outboundTrack: MediaStreamTrack | null = null;

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

  /** Connect to the authenticated LiveKit room. */
  async connectToRoom(url: string, token: string): Promise<void> {
    this.room?.disconnect();
    this.localTrack = null;

    const room = new Room({
      audioOutput: { deviceId: this.outputDeviceId || undefined },
      stopLocalTrackOnUnpublish: false,
    });
    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio || !track.mediaStreamTrack) return;
        this.setRemoteStream(participant.identity, new MediaStream([track.mediaStreamTrack]));
      },
    );
    room.on(
      RoomEvent.TrackUnsubscribed,
      (_track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        this.clearRemoteStream(participant.identity);
      },
    );
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      this.clearRemoteStream(participant.identity);
    });
    room.on(RoomEvent.Reconnecting, () => this.status('Voice reconnecting...'));
    room.on(RoomEvent.Reconnected, () => this.status('Voice reconnected.'));
    room.on(RoomEvent.Disconnected, () => this.status('Voice disconnected.'));

    await room.connect(url, token);
    this.room = room;
    await this.publishOutboundTrack();
  }

  /** Ensure a grid participant exists before attaching their LiveKit track. */
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
    const pending = this.pendingRemoteStreams.get(targetId);
    if (pending) {
      this.pendingRemoteStreams.delete(targetId);
      this.attachRemoteStream(peer, pending);
    }
    return peer;
  }

  /** Replace the processed microphone track published to LiveKit. */
  async replaceOutgoingTrack(stream: MediaStream): Promise<void> {
    this.outboundTrack = stream.getAudioTracks()[0] ?? null;
    await this.publishOutboundTrack();
  }

  removePeer(id: string): void {
    const peer = this.peers.get(id);
    if (peer) {
      this.audio.cleanupPeerAudio(peer);
      this.peers.delete(id);
    }
    this.pendingRemoteStreams.delete(id);
  }

  cleanupAll(): void {
    for (const id of Array.from(this.peers.keys())) this.removePeer(id);
    this.pendingRemoteStreams.clear();
    this.room?.disconnect();
    this.room = null;
    this.localTrack = null;
    this.outboundTrack = null;
  }

  setPeerPosition(id: string, x: number, y: number): void {
    const peer = this.peers.get(id);
    if (peer) {
      peer.x = x;
      peer.y = y;
    }
  }

  setPeerNickname(id: string, nickname: string): void {
    const peer = this.peers.get(id);
    if (peer) peer.nickname = nickname;
  }

  setPeerListenGain(id: string, gain: number): void {
    const peer = this.peers.get(id);
    if (peer) peer.listenGain = gain;
  }

  getPeerListenGain(id: string): number {
    const peer = this.peers.get(id);
    return peer && Number.isFinite(peer.listenGain) ? Math.max(0, peer.listenGain as number) : 1;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    await this.room?.switchActiveDevice('audiooutput', deviceId).catch(() => undefined);
    for (const peer of this.peers.values()) {
      const sinkTarget = peer.audioElement as (HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }) | undefined;
      await sinkTarget?.setSinkId?.(deviceId).catch(() => undefined);
    }
  }

  suspendRemoteAudio(): void {
    for (const peer of this.peers.values()) this.audio.cleanupPeerAudio(peer);
  }

  async resumeRemoteAudio(): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.remoteStream) await this.audio.attachRemoteStream(peer, peer.remoteStream, this.outputDeviceId);
    }
  }

  private async publishOutboundTrack(): Promise<void> {
    if (!this.room || !this.outboundTrack) return;
    if (this.localTrack) {
      await this.localTrack.replaceTrack(this.outboundTrack, true);
      return;
    }
    this.localTrack = new LocalAudioTrack(this.outboundTrack, undefined, true);
    await this.room.localParticipant.publishTrack(this.localTrack);
  }

  private setRemoteStream(participantId: string, stream: MediaStream): void {
    const peer = this.peers.get(participantId);
    if (!peer) {
      this.pendingRemoteStreams.set(participantId, stream);
      return;
    }
    this.attachRemoteStream(peer, stream);
  }

  private attachRemoteStream(peer: PeerRuntime, stream: MediaStream): void {
    this.audio.cleanupPeerAudio(peer);
    peer.remoteStream = stream;
    if (this.audio.isVoiceLayerEnabled()) {
      void this.audio.attachRemoteStream(peer, stream, this.outputDeviceId);
    }
  }

  private clearRemoteStream(participantId: string): void {
    this.pendingRemoteStreams.delete(participantId);
    const peer = this.peers.get(participantId);
    if (!peer) return;
    this.audio.cleanupPeerAudio(peer);
    peer.remoteStream = undefined;
  }
}
