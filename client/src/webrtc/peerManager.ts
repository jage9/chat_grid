import {
  ConnectionState,
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

const RECOVERY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
const RECOVERY_FAILURE_STATUS = 'Voice unavailable. Disconnect and connect to retry.';

/** Owns the LiveKit room and maps its audio tracks to grid participants. */
export class PeerManager {
  private readonly peers = new Map<string, PeerRuntime>();
  private readonly pendingRemoteStreams = new Map<string, MediaStream>();
  private outputDeviceId = '';
  private room: Room | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private outboundTrack: MediaStreamTrack | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAttempts = 0;
  private recoveryFailureReported = false;
  private recovering = false;
  private listenerZ = 0;
  private subscriptionResolver: (peer: PeerRuntime) => boolean = (peer) => peer.z === this.listenerZ;

  constructor(
    private readonly audio: AudioEngine,
    private readonly status: StatusHandler,
    private readonly recovery: {
      isSessionRunning: () => boolean;
      requestToken: () => void;
    },
  ) {}

  getPeer(id: string): PeerRuntime | undefined {
    return this.peers.get(id);
  }

  getPeers(): Iterable<PeerRuntime> {
    return this.peers.values();
  }

  /** Join with fresh credentials; return false if cleanup or another join supersedes it. */
  async connectToRoom(url: string, token: string): Promise<boolean> {
    this.clearRecoveryTimer();
    if (!this.recovery.isSessionRunning()) return false;
    this.releaseRoom();

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
    room.on(RoomEvent.Reconnected, async () => {
      if (this.room !== room || !this.recovery.isSessionRunning()) return;
      try {
        await this.publishOutboundTrack();
        if (this.room === room && this.recovery.isSessionRunning()) {
          this.status('Voice reconnected.');
        }
      } catch {
        if (this.room !== room || !this.recovery.isSessionRunning()) return;
        this.releaseRoom();
        this.scheduleRecovery();
      }
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room !== room) return;
      this.releaseRoom();
      this.scheduleRecovery();
    });

    this.room = room;
    try {
      await room.connect(url, token);
      if (this.room !== room) {
        void room.disconnect(false);
        return false;
      }
      this.syncFloorSubscriptions();
      await this.publishOutboundTrack();
      if (this.room !== room) return false;
      if (this.recovering) this.status('Voice reconnected.');
      this.recovering = false;
      this.recoveryAttempts = 0;
      this.recoveryFailureReported = false;
      return true;
    } catch (error) {
      if (this.room !== room) return false;
      this.releaseRoom();
      this.scheduleRecovery();
      throw error;
    }
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
    this.clearRecoveryTimer();
    this.recovering = false;
    this.recoveryAttempts = 0;
    this.recoveryFailureReported = false;
    this.releaseRoom();
    for (const id of Array.from(this.peers.keys())) this.removePeer(id);
    this.pendingRemoteStreams.clear();
    this.outboundTrack = null;
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private scheduleRecovery(): void {
    if (!this.recovery.isSessionRunning()) return;
    if (!this.recovering) {
      this.status('Voice reconnecting...');
      this.recovering = true;
      this.recoveryAttempts = 0;
      this.recoveryFailureReported = false;
    }
    if (this.recoveryTimer !== null || this.recoveryFailureReported) return;
    if (this.recoveryAttempts >= RECOVERY_DELAYS_MS.length) {
      this.reportRecoveryFailure();
      return;
    }

    const delayMs = RECOVERY_DELAYS_MS[this.recoveryAttempts];
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.recovery.isSessionRunning()) return;
      if (!this.recovering || this.recoveryAttempts >= RECOVERY_DELAYS_MS.length) return;
      this.recoveryAttempts += 1;
      if (this.recoveryAttempts < RECOVERY_DELAYS_MS.length) {
        this.scheduleRecovery();
      } else {
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          if (this.recovery.isSessionRunning() && this.recovering) this.reportRecoveryFailure();
        }, RECOVERY_DELAYS_MS[RECOVERY_DELAYS_MS.length - 1]);
      }
      this.recovery.requestToken();
    }, delayMs);
  }

  private reportRecoveryFailure(): void {
    if (this.recoveryFailureReported || !this.recovering) return;
    this.recoveryFailureReported = true;
    this.status(RECOVERY_FAILURE_STATUS);
  }

  /** Detach the room while keeping the processed microphone track available for rejoin. */
  private releaseRoom(): void {
    const room = this.room;
    this.room = null;
    this.localTrack = null;
    room?.removeAllListeners();
    void room?.disconnect(false);
    this.pendingRemoteStreams.clear();
    for (const id of this.peers.keys()) this.clearRemoteStream(id);
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
    await this.audio.setOutputDevice(deviceId).catch(() => {
      this.status('Could not switch audio output. Check your output device.');
    });
    await this.room?.switchActiveDevice('audiooutput', deviceId).catch(() => undefined);
  }

  suspendRemoteAudio(): void {
    for (const peer of this.peers.values()) this.audio.cleanupPeerAudio(peer);
  }

  async resumeRemoteAudio(): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.remoteStream) await this.audio.attachRemoteStream(peer, peer.remoteStream);
    }
  }

  private async publishOutboundTrack(): Promise<void> {
    if (this.room?.state !== ConnectionState.Connected || !this.outboundTrack) return;
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
      void this.audio.attachRemoteStream(peer, stream);
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
