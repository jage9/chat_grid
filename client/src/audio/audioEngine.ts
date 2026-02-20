import { HEARING_RADIUS } from '../state/gameState';
import {
  EFFECT_SEQUENCE,
  clampEffectLevel,
  connectEffectChain,
  disconnectEffectRuntime,
  type EffectId,
  type EffectRuntime,
} from './effects';

export type SpatialPeerRuntime = {
  nickname: string;
  x: number;
  y: number;
  gain?: GainNode;
  panner?: StereoPannerNode;
  audioElement?: HTMLAudioElement;
};

type SoundSpec = {
  freq: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
  sourcePosition?: { x: number; y: number };
  delay?: number;
};

type OutputMode = 'stereo' | 'mono';

export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private sfxGainNode: GainNode | null = null;
  private readonly sampleCache = new Map<string, AudioBuffer>();
  private readonly sampleLoaders = new Map<string, Promise<AudioBuffer>>();

  private outboundSource: MediaStreamAudioSourceNode | null = null;
  private outboundInputGain: GainNode | null = null;
  private outboundDestination: MediaStreamAudioDestinationNode | null = null;
  private outboundEffectRuntime: EffectRuntime | null = null;
  private outputMode: OutputMode = 'stereo';
  private effectIndex = EFFECT_SEQUENCE.findIndex((effect) => effect.id === 'off');
  private readonly effectValues: Record<EffectId, number> = {
    reverb: 50,
    echo: 50,
    flanger: 50,
    high_pass: 50,
    low_pass: 50,
    off: 0,
  };

  async ensureContext(): Promise<void> {
    if (!this.audioCtx) {
      const Ctor =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.audioCtx = new Ctor();
      this.sfxGainNode = this.audioCtx.createGain();
      this.sfxGainNode.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  get context(): AudioContext | null {
    return this.audioCtx;
  }

  supportsStereoPanner(): boolean {
    return !!this.audioCtx && typeof this.audioCtx.createStereoPanner === 'function';
  }

  supportsSinkId(element: HTMLMediaElement): boolean {
    return (
      typeof (element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId ===
      'function'
    );
  }

  async configureOutboundStream(inputStream: MediaStream): Promise<MediaStream> {
    await this.ensureContext();
    if (!this.audioCtx) {
      return inputStream;
    }

    if (this.outboundSource) {
      this.outboundSource.disconnect();
    }

    this.outboundSource = this.audioCtx.createMediaStreamSource(inputStream);
    if (!this.outboundInputGain) {
      this.outboundInputGain = this.audioCtx.createGain();
    }
    if (!this.outboundDestination) {
      this.outboundDestination = this.audioCtx.createMediaStreamDestination();
    }

    this.outboundSource.connect(this.outboundInputGain);
    this.rebuildOutboundEffectGraph();

    return this.outboundDestination.stream;
  }

  cycleOutboundEffect(): { id: EffectId; label: string } {
    this.effectIndex = (this.effectIndex + 1) % EFFECT_SEQUENCE.length;
    this.rebuildOutboundEffectGraph();
    return EFFECT_SEQUENCE[this.effectIndex];
  }

  getCurrentEffect(): { id: EffectId; label: string; value: number; defaultValue: number } {
    const effect = EFFECT_SEQUENCE[this.effectIndex];
    return {
      id: effect.id,
      label: effect.label,
      value: this.effectValues[effect.id],
      defaultValue: effect.defaultValue,
    };
  }

  adjustCurrentEffectLevel(step: number): { id: EffectId; label: string; value: number; defaultValue: number } | null {
    const effect = EFFECT_SEQUENCE[this.effectIndex];
    if (effect.id === 'off') {
      return null;
    }

    const next = this.clampLevel(this.effectValues[effect.id] + step);
    this.effectValues[effect.id] = next;
    this.rebuildOutboundEffectGraph();

    return {
      id: effect.id,
      label: effect.label,
      value: next,
      defaultValue: effect.defaultValue,
    };
  }

  setEffectLevels(levels: Partial<Record<EffectId, number>>): void {
    for (const effect of EFFECT_SEQUENCE) {
      if (effect.id === 'off') continue;
      const value = levels[effect.id];
      if (typeof value !== 'number') continue;
      this.effectValues[effect.id] = this.clampLevel(value);
    }
    this.rebuildOutboundEffectGraph();
  }

  getEffectLevels(): Record<EffectId, number> {
    return { ...this.effectValues };
  }

  setOutputMode(mode: OutputMode): void {
    this.outputMode = mode;
  }

  toggleOutputMode(): OutputMode {
    this.outputMode = this.outputMode === 'stereo' ? 'mono' : 'stereo';
    return this.outputMode;
  }

  async attachRemoteStream(
    peer: SpatialPeerRuntime,
    stream: MediaStream,
    outputDeviceId: string,
  ): Promise<void> {
    await this.ensureContext();
    if (!this.audioCtx) return;

    const audioElement = new Audio();
    audioElement.srcObject = stream;
    audioElement.muted = true;

    if (outputDeviceId && this.supportsSinkId(audioElement)) {
      const sinkTarget = audioElement as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      await sinkTarget.setSinkId?.(outputDeviceId);
    }

    await audioElement.play().catch(() => undefined);
    document.body.appendChild(audioElement);

    const sourceNode = this.audioCtx.createMediaStreamSource(stream);
    const gainNode = this.audioCtx.createGain();
    sourceNode.connect(gainNode);

    let pannerNode: StereoPannerNode | undefined;
    if (this.supportsStereoPanner()) {
      pannerNode = this.audioCtx.createStereoPanner();
      gainNode.connect(pannerNode).connect(this.audioCtx.destination);
    } else {
      gainNode.connect(this.audioCtx.destination);
    }

    peer.audioElement = audioElement;
    peer.gain = gainNode;
    peer.panner = pannerNode;
  }

  updateSpatialAudio(peers: Iterable<SpatialPeerRuntime>, playerPosition: { x: number; y: number }): void {
    if (!this.audioCtx) return;

    for (const peer of peers) {
      if (!peer.gain) continue;
      const dist = Math.hypot(peer.x - playerPosition.x, peer.y - playerPosition.y);
      let gainValue = 0;
      let panValue = 0;
      if (dist < HEARING_RADIUS) {
        gainValue = Math.pow(1 - dist / HEARING_RADIUS, 2);
        panValue = Math.sin(((peer.x - playerPosition.x) / HEARING_RADIUS) * (Math.PI / 2));
      }
      if (dist < 1.5) gainValue = 1;
      peer.gain.gain.linearRampToValueAtTime(gainValue, this.audioCtx.currentTime + 0.1);
      if (peer.panner) {
        const resolvedPan = this.outputMode === 'mono' ? 0 : Math.max(-1, Math.min(1, panValue));
        peer.panner.pan.setValueAtTime(resolvedPan, this.audioCtx.currentTime);
      }
    }
  }

  sfxMove(player: { x: number; y: number }): void {
    void player;
    this.playSound({ freq: 165, duration: 0.05, type: 'triangle', gain: 0.13 });
  }

  sfxPeerMove(peer: { x: number; y: number }): void {
    this.playSound({ freq: 330, duration: 0.05, type: 'triangle', gain: 0.12, sourcePosition: peer });
  }

  sfxLocate(peer: { x: number; y: number }): void {
    this.playSound({ freq: 880, duration: 0.2, type: 'sine', gain: 0.5, sourcePosition: peer });
  }

  sfxUiConfirm(): void {
    this.playSound({ freq: 880, duration: 0.1, gain: 0.5 });
  }

  sfxUiCancel(): void {
    this.playSound({ freq: 440, duration: 0.1, type: 'sawtooth', gain: 0.3 });
  }

  sfxUiBlip(): void {
    this.playSound({ freq: 660, duration: 0.05, type: 'triangle', gain: 0.35 });
  }

  sfxEffectLevel(isDefault: boolean): void {
    this.playSound({ freq: isDefault ? 659.25 : 440, duration: 0.1, type: 'sine', gain: 0.35 });
  }

  sfxTileOccupantPing(): void {
    this.playSound({ freq: 1320, duration: 0.12, type: 'sine', gain: 0.45 });
  }

  async playSpatialSample(url: string, sourcePosition: { x: number; y: number }, gain = 1): Promise<void> {
    await this.ensureContext();
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode) return;

    const resolved = this.resolveSpatialMix(sourcePosition, gain);
    if (!resolved) return;

    try {
      const buffer = await this.getSampleBuffer(url);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = resolved.gain;
      source.connect(gainNode);
      if (resolved.pan !== undefined && this.supportsStereoPanner() && this.outputMode === 'stereo') {
        const panner = audioCtx.createStereoPanner();
        panner.pan.setValueAtTime(resolved.pan, audioCtx.currentTime);
        gainNode.connect(panner).connect(sfxGainNode);
      } else {
        gainNode.connect(sfxGainNode);
      }
      source.start();
    } catch {
      // Ignore sample decode/load errors.
    }
  }

  async playSample(url: string, gain = 1): Promise<void> {
    await this.ensureContext();
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode) return;
    if (gain <= 0) return;

    try {
      const buffer = await this.getSampleBuffer(url);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = gain;
      source.connect(gainNode).connect(sfxGainNode);
      source.start();
    } catch {
      // Ignore sample decode/load errors.
    }
  }

  cleanupPeerAudio(peer: SpatialPeerRuntime): void {
    peer.audioElement?.remove();
    peer.gain?.disconnect();
    peer.panner?.disconnect();
  }

  private rebuildOutboundEffectGraph(): void {
    if (!this.audioCtx || !this.outboundInputGain || !this.outboundDestination) {
      return;
    }

    disconnectEffectRuntime(this.outboundEffectRuntime);
    this.outboundEffectRuntime = null;
    this.outboundInputGain.disconnect();

    const effect = EFFECT_SEQUENCE[this.effectIndex].id;
    this.outboundEffectRuntime = connectEffectChain(
      this.audioCtx,
      this.outboundInputGain,
      this.outboundDestination,
      effect,
      this.effectValues[effect],
    );
  }

  private clampLevel(value: number): number {
    return clampEffectLevel(value);
  }

  private playSound(spec: SoundSpec): void {
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode) return;

    const baseGain = spec.gain ?? 1;
    const resolved = this.resolveSpatialMix(spec.sourcePosition, baseGain);
    if (!resolved) return;
    const finalGain = resolved.gain;
    const panValue = resolved.pan;

    if (finalGain <= 0) return;

    const startTime = audioCtx.currentTime + (spec.delay ?? 0);
    const oscillator = audioCtx.createOscillator();
    oscillator.type = spec.type ?? 'sine';
    oscillator.frequency.setValueAtTime(spec.freq, startTime);

    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(finalGain, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + spec.duration);

    oscillator.connect(gainNode);
    if (panValue !== undefined && this.supportsStereoPanner() && this.outputMode === 'stereo') {
      const panner = audioCtx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, panValue)), startTime);
      gainNode.connect(panner).connect(sfxGainNode);
    } else {
      gainNode.connect(sfxGainNode);
    }

    oscillator.start(startTime);
    oscillator.stop(startTime + spec.duration);
  }

  private resolveSpatialMix(
    sourcePosition: { x: number; y: number } | undefined,
    baseGain: number,
  ): { gain: number; pan?: number } | null {
    if (!sourcePosition) {
      return { gain: baseGain };
    }
    const distance = Math.hypot(sourcePosition.x, sourcePosition.y);
    if (distance > HEARING_RADIUS) {
      return null;
    }
    const volumeRatio = Math.max(0, 1 - distance / HEARING_RADIUS);
    const finalGain = baseGain * Math.pow(volumeRatio, 2);
    const clampedX = Math.max(-HEARING_RADIUS, Math.min(HEARING_RADIUS, sourcePosition.x));
    const pan = Math.sin((clampedX / HEARING_RADIUS) * (Math.PI / 2));
    return { gain: finalGain, pan };
  }

  private async getSampleBuffer(url: string): Promise<AudioBuffer> {
    if (!this.audioCtx) {
      throw new Error('Audio context not initialized');
    }
    if (this.sampleCache.has(url)) {
      return this.sampleCache.get(url)!;
    }
    if (!this.sampleLoaders.has(url)) {
      this.sampleLoaders.set(
        url,
        fetch(url)
          .then((response) => {
            if (!response.ok) throw new Error(`Failed to fetch sample: ${url}`);
            return response.arrayBuffer();
          })
          .then((data) => this.audioCtx!.decodeAudioData(data))
          .then((buffer) => {
            this.sampleCache.set(url, buffer);
            this.sampleLoaders.delete(url);
            return buffer;
          })
          .catch((error) => {
            this.sampleLoaders.delete(url);
            throw error;
          }),
      );
    }
    return this.sampleLoaders.get(url)!;
  }
}
