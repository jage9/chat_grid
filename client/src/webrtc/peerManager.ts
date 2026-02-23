import { AudioEngine, type SpatialPeerRuntime } from '../audio/audioEngine';
import type { RemoteUser } from '../network/protocol';

export type PeerRuntime = SpatialPeerRuntime & {
  id: string;
  pc: RTCPeerConnection;
  remoteStream?: MediaStream;
};

type SendSignal = (targetId: string, payload: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit }) => void;

type StatusHandler = (message: string) => void;

export class PeerManager {
  private readonly peers = new Map<string, PeerRuntime>();
  private outputDeviceId = '';

  constructor(
    private readonly audio: AudioEngine,
    private readonly sendSignal: SendSignal,
    private readonly getLocalStream: () => MediaStream | null,
    private readonly status: StatusHandler,
  ) {}

  getPeer(id: string): PeerRuntime | undefined {
    return this.peers.get(id);
  }

  getPeers(): Iterable<PeerRuntime> {
    return this.peers.values();
  }

  async createOrGetPeer(targetId: string, isInitiator: boolean, userData: Partial<RemoteUser>): Promise<PeerRuntime> {
    const existing = this.peers.get(targetId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    const peer: PeerRuntime = {
      id: targetId,
      nickname: userData.nickname ?? 'user...',
      x: userData.x ?? 20,
      y: userData.y ?? 20,
      listenGain: 1,
      pc,
    };

    this.peers.set(targetId, peer);

    const stream = this.getLocalStream();
    if (stream) {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(targetId, { ice: event.candidate.toJSON() });
      }
    };

    pc.ontrack = async (event) => {
      peer.remoteStream = event.streams[0];
      if (this.audio.isVoiceLayerEnabled()) {
        await this.audio.attachRemoteStream(peer, event.streams[0], this.outputDeviceId);
      } else {
        this.audio.cleanupPeerAudio(peer);
      }
    };

    if (isInitiator) {
      let offer = await pc.createOffer();
      offer = this.tuneOpus(offer);
      await pc.setLocalDescription(offer);
      this.sendSignal(targetId, { sdp: pc.localDescription ?? undefined });
    }

    return peer;
  }

  async handleSignal(data: {
    senderId: string;
    senderNickname?: string;
    x?: number;
    y?: number;
    sdp?: RTCSessionDescriptionInit;
    ice?: RTCIceCandidateInit;
  }): Promise<PeerRuntime> {
    const peer = await this.createOrGetPeer(data.senderId, false, {
      id: data.senderId,
      nickname: data.senderNickname,
      x: data.x,
      y: data.y,
    });

    if (data.sdp) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === 'offer') {
        let answer = await peer.pc.createAnswer();
        answer = this.tuneOpus(answer);
        await peer.pc.setLocalDescription(answer);
        this.sendSignal(data.senderId, { sdp: peer.pc.localDescription ?? undefined });
      }
    }

    if (data.ice) {
      await peer.pc.addIceCandidate(new RTCIceCandidate(data.ice)).catch(() => undefined);
    }

    return peer;
  }

  async replaceOutgoingTrack(stream: MediaStream): Promise<void> {
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((candidate) => candidate.track?.kind === 'audio');
      const newTrack = stream.getAudioTracks()[0];
      if (sender && newTrack) {
        await sender.replaceTrack(newTrack);
      }
    }
  }

  removePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.audio.cleanupPeerAudio(peer);
    this.peers.delete(id);
  }

  cleanupAll(): void {
    for (const id of this.peers.keys()) {
      this.removePeer(id);
    }
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

  private tuneOpus(desc: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    if (!desc.sdp) return desc;
    const lines = desc.sdp.split('\r\n');
    let opusPayload: string | undefined;
    for (const line of lines) {
      if (line.includes('opus/48000')) {
        const match = line.match(/(\d+) opus\/48000/);
        if (match) opusPayload = match[1];
      }
    }
    if (opusPayload) {
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes(`a=fmtp:${opusPayload}`)) {
          lines[index] += ';maxaveragebitrate=128000;stereo=1;sprop-stereo=1;useinbandfec=1;usedtx=0';
          break;
        }
      }
    }
    return { ...desc, sdp: lines.join('\r\n') };
  }
}
