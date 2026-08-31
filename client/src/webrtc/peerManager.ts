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
  acousticZoneId: string;
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
  private listenerZ = 0;
  private subscriptionResolver: (peer: PeerRuntime) => boolean = (peer) => peer.z === this.listenerZ;

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
      (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio || !track.mediaStreamTrack) return;
        const peer = this.peers.get(participant.identity);
        if (peer && !this.shouldSubscribe(peer)) {
          publication.setSubscribed(false);
          return;
        }
        this.setRemoteStream(participant.identity, new MediaStream([track.mediaStreamTrack]));
      },
    );
    room.on(
      RoomEvent.TrackPublished,
      (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (publication.kind !== Track.Kind.Audio) return;
        const peer = this.peers.get(participant.identity);
        publication.setSubscribed(Boolean(peer && this.shouldSubscribe(peer)));
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
    this.syncFloorSubscriptions();
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
      z: userData.z ?? 0,
      acousticZoneId: userData.acousticZoneId ?? `floor:${userData.z ?? 0}`,
      acousticGain: 0,
      listenGain: 1,
    };
    this.peers.set(targetId, peer);
    const pending = this.pendingRemoteStreams.get(targetId);
    if (pending) {
      this.pendingRemoteStreams.delete(targetId);
      if (this.shouldSubscribe(peer)) {
        this.attachRemoteStream(peer, pending);
      }
    }
    this.syncParticipantFloorSubscription(targetId);
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

  setPeerPosition(id: string, x: number, y: number, z: number, acousticZoneId: string): void {
    const peer = this.peers.get(id);
    if (peer) {
      peer.x = x;
      peer.y = y;
      peer.z = z;
      peer.acousticZoneId = acousticZoneId;
    }
    this.syncParticipantFloorSubscription(id);
  }

  /** Unsubscribe from remote voice tracks outside the listener's floor. */
  setListenerFloor(z: number): void {
    if (this.listenerZ === z) return;
    this.listenerZ = z;
    this.syncFloorSubscriptions();
  }

  /** Apply the current world acoustic connectivity rule to LiveKit tracks. */
  setSubscriptionResolver(resolver: (peer: PeerRuntime) => boolean): void {
    this.subscriptionResolver = resolver;
    this.syncFloorSubscriptions();
  }

  setPeerAcousticGain(id: string, gain: number): void {
    const peer = this.peers.get(id);
    if (peer) peer.acousticGain = gain;
  }

  setPeerAcousticMix(id: string, gain: number, lowpassHz: number): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.acousticGain = gain;
    peer.occlusionLowpassHz = lowpassHz;
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
    if (peer && !this.shouldSubscribe(peer)) return;
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

  private syncFloorSubscriptions(): void {
    for (const participantId of this.peers.keys()) {
      this.syncParticipantFloorSubscription(participantId);
    }
  }

  private syncParticipantFloorSubscription(participantId: string): void {
    const peer = this.peers.get(participantId);
    const participant = this.room?.remoteParticipants.get(participantId);
    if (!peer || !participant) return;
    const subscribed = this.shouldSubscribe(peer);
    for (const publication of participant.audioTrackPublications.values()) {
      publication.setSubscribed(subscribed);
    }
    if (!subscribed) {
      this.clearRemoteStream(participantId);
    }
  }

  private shouldSubscribe(peer: PeerRuntime): boolean {
    return this.subscriptionResolver(peer);
  }
}
