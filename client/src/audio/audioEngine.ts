import { HEARING_RADIUS } from '../state/gameState';
import {
  EFFECT_SEQUENCE,
  clampEffectLevel,
  connectEffectChain,
  disconnectEffectRuntime,
  type EffectId,
  type EffectRuntime,
} from './effects';
import { applySpatialMixToNodes, resolveSpatialMix, SPATIAL_RAMP_SECONDS, SPATIAL_TIME_CONSTANT_SECONDS } from './spatial';

export type SpatialPeerRuntime = {
  nickname: string;
  x: number;
  y: number;
  listenGain?: number;
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
const ONE_SHOT_ATTACK_SECONDS = 0.02;
type ActiveSpatialSampleRuntime = {
  sourceX: number;
  sourceY: number;
  range: number;
  baseGain: number;
  gainNode: GainNode;
  pannerNode: StereoPannerNode | null;
  sourceNode: AudioBufferSourceNode;
};

export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private masterGainNode: GainNode | null = null;
  private sfxGainNode: GainNode | null = null;
  private readonly sampleCache = new Map<string, AudioBuffer>();
  private readonly sampleLoaders = new Map<string, Promise<AudioBuffer>>();
  private readonly activeSpatialSamples = new Set<ActiveSpatialSampleRuntime>();

  private previewSourceNode: AudioBufferSourceNode | null = null;
  private previewGainNode: GainNode | null = null;

  private outboundSource: MediaStreamAudioSourceNode | null = null;
  private outboundInputGain: GainNode | null = null;
  private outboundInputGainValue = 1;
  private outboundDestination: MediaStreamAudioDestinationNode | null = null;
  private outboundEffectRuntime: EffectRuntime | null = null;
  private loopbackEnabled = false;
  private loopbackRuntime: EffectRuntime | null = null;
  private outputMode: OutputMode = 'stereo';
  private masterVolume = 50;
  private voiceLayerEnabled = true;
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
      this.masterGainNode = this.audioCtx.createGain();
      this.masterGainNode.gain.value = this.masterVolume / 100;
      this.masterGainNode.connect(this.audioCtx.destination);
      this.sfxGainNode = this.audioCtx.createGain();
      this.sfxGainNode.connect(this.masterGainNode);
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  get context(): AudioContext | null {
    return this.audioCtx;
  }

  getOutputDestinationNode(): AudioNode | null {
    return this.masterGainNode ?? this.audioCtx?.destination ?? null;
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
    this.outboundInputGain.gain.value = this.outboundInputGainValue;
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

  setOutboundEffect(effectId: EffectId): { id: EffectId; label: string } {
    const nextIndex = EFFECT_SEQUENCE.findIndex((effect) => effect.id === effectId);
    this.effectIndex = nextIndex >= 0 ? nextIndex : this.effectIndex;
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

  setMasterVolume(value: number): number {
    const next = Math.max(0, Math.min(100, Number.isFinite(value) ? Math.round(value) : 50));
    this.masterVolume = next;
    if (this.masterGainNode && this.audioCtx) {
      this.masterGainNode.gain.setValueAtTime(next / 100, this.audioCtx.currentTime);
    }
    return this.masterVolume;
  }

  adjustMasterVolume(step: number): number {
    return this.setMasterVolume(this.masterVolume + step);
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  toggleOutputMode(): OutputMode {
    this.outputMode = this.outputMode === 'stereo' ? 'mono' : 'stereo';
    return this.outputMode;
  }

  getOutputMode(): OutputMode {
    return this.outputMode;
  }

  setVoiceLayerEnabled(enabled: boolean): void {
    this.voiceLayerEnabled = enabled;
  }

  isVoiceLayerEnabled(): boolean {
    return this.voiceLayerEnabled;
  }

  setOutboundInputGain(value: number): number {
    const next = Math.max(0.01, Number.isFinite(value) ? value : 1);
    this.outboundInputGainValue = next;
    if (this.outboundInputGain && this.audioCtx) {
      this.outboundInputGain.gain.setValueAtTime(next, this.audioCtx.currentTime);
    }
    return next;
  }

  getOutboundInputGain(): number {
    return this.outboundInputGainValue;
  }

  toggleLoopback(): boolean {
    this.loopbackEnabled = !this.loopbackEnabled;
    this.rebuildOutboundEffectGraph();
    return this.loopbackEnabled;
  }

  /** Returns current loopback monitor state. */
  isLoopbackEnabled(): boolean {
    return this.loopbackEnabled;
  }

  /** Sets loopback monitor state directly. */
  setLoopbackEnabled(enabled: boolean): boolean {
    this.loopbackEnabled = enabled;
    this.rebuildOutboundEffectGraph();
    return this.loopbackEnabled;
  }

  async attachRemoteStream(
    peer: SpatialPeerRuntime,
    stream: MediaStream,
    outputDeviceId: string,
  ): Promise<void> {
    await this.ensureContext();
    if (!this.audioCtx) return;
    this.cleanupPeerAudio(peer);

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
      if (this.voiceLayerEnabled) {
        gainNode.connect(pannerNode).connect(this.masterGainNode ?? this.audioCtx.destination);
      }
    } else {
      if (this.voiceLayerEnabled) {
        gainNode.connect(this.masterGainNode ?? this.audioCtx.destination);
      }
    }

    peer.audioElement = audioElement;
    peer.gain = gainNode;
    peer.panner = pannerNode;
  }

  updateSpatialAudio(peers: Iterable<SpatialPeerRuntime>, playerPosition: { x: number; y: number }): void {
    if (!this.audioCtx) return;

    for (const peer of peers) {
      if (!peer.gain) continue;
      const mix = resolveSpatialMix({
        dx: peer.x - playerPosition.x,
        dy: peer.y - playerPosition.y,
        range: HEARING_RADIUS,
        nearFieldDistance: 1.5,
        nearFieldGain: 1,
      });
      const listenGain = Number.isFinite(peer.listenGain) ? Math.max(0, peer.listenGain as number) : 1;
      const scaledMix = mix ? { ...mix, gain: mix.gain * listenGain } : null;
      applySpatialMixToNodes({
        audioCtx: this.audioCtx,
        gainNode: peer.gain,
        pannerNode: peer.panner ?? null,
        mix: scaledMix,
        outputMode: this.outputMode,
        transition: 'target',
      });
    }
  }

  /** Updates active one-shot spatial sample gain/pan against current listener position. */
  updateSpatialSamples(playerPosition: { x: number; y: number }): void {
    if (!this.audioCtx) return;
    for (const sample of Array.from(this.activeSpatialSamples)) {
      this.applySpatialSampleRuntime(sample, playerPosition);
    }
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

  sfxTileItemPing(): void {
    this.playSound({ freq: 1320, duration: 0.12, type: 'sine', gain: 0.45 });
  }

  sfxTileUserPing(): void {
    this.playSound({ freq: 880, duration: 0.12, type: 'sine', gain: 0.45 });
  }

  async playSpatialSample(
    url: string,
    sourcePosition: { x: number; y: number },
    playerPosition: { x: number; y: number },
    gain = 1,
    range = HEARING_RADIUS,
  ): Promise<void> {
    await this.ensureContext();
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode) return;

    try {
      const buffer = await this.getSampleBuffer(url);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      source.connect(gainNode);
      let pannerNode: StereoPannerNode | null = null;
      if (this.supportsStereoPanner() && this.outputMode === 'stereo') {
        pannerNode = audioCtx.createStereoPanner();
        gainNode.connect(pannerNode).connect(sfxGainNode);
      } else {
        gainNode.connect(sfxGainNode);
      }
      const runtime: ActiveSpatialSampleRuntime = {
        sourceX: sourcePosition.x,
        sourceY: sourcePosition.y,
        range: Math.max(1, range),
        baseGain: gain,
        gainNode,
        pannerNode,
        sourceNode: source,
      };
      this.activeSpatialSamples.add(runtime);
      this.applySpatialSampleRuntime(runtime, playerPosition, true);
      source.onended = () => {
        this.activeSpatialSamples.delete(runtime);
        try {
          source.disconnect();
        } catch {
          // Ignore stale graph disconnects.
        }
        gainNode.disconnect();
        pannerNode?.disconnect();
      };
      source.start();
    } catch {
      // Ignore sample decode/load errors.
    }
  }

  /** Plays one spatial sample and resolves when playback finishes. */
  async playSpatialSampleAndWait(
    url: string,
    sourcePosition: { x: number; y: number },
    playerPosition: { x: number; y: number },
    gain = 1,
    range = HEARING_RADIUS,
  ): Promise<void> {
    await this.ensureContext();
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode) return;

    try {
      const buffer = await this.getSampleBuffer(url);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      source.connect(gainNode);
      let pannerNode: StereoPannerNode | null = null;
      if (this.supportsStereoPanner() && this.outputMode === 'stereo') {
        pannerNode = audioCtx.createStereoPanner();
        gainNode.connect(pannerNode).connect(sfxGainNode);
      } else {
        gainNode.connect(sfxGainNode);
      }
      const runtime: ActiveSpatialSampleRuntime = {
        sourceX: sourcePosition.x,
        sourceY: sourcePosition.y,
        range: Math.max(1, range),
        baseGain: gain,
        gainNode,
        pannerNode,
        sourceNode: source,
      };
      this.activeSpatialSamples.add(runtime);
      this.applySpatialSampleRuntime(runtime, playerPosition, true);
      await new Promise<void>((resolve) => {
        source.onended = () => {
          this.activeSpatialSamples.delete(runtime);
          try {
            source.disconnect();
          } catch {
            // Ignore stale graph disconnects.
          }
          gainNode.disconnect();
          pannerNode?.disconnect();
          resolve();
        };
        source.start();
      });
    } catch {
      // Ignore sample decode/load errors.
    }
  }

  async playSample(url: string, gain = 1, fadeInMs = 0): Promise<void> {
    await this.ensureContext();
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode) return;
    if (gain <= 0) return;

    try {
      const buffer = await this.getSampleBuffer(url);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gainNode = audioCtx.createGain();
      const safeFadeMs = Number.isFinite(fadeInMs) ? Math.max(0, fadeInMs) : 0;
      if (safeFadeMs > 0) {
        gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
        gainNode.gain.linearRampToValueAtTime(gain, audioCtx.currentTime + safeFadeMs / 1000);
      } else {
        gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
        gainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, ONE_SHOT_ATTACK_SECONDS);
      }
      source.connect(gainNode).connect(sfxGainNode);
      source.start();
    } catch {
      // Ignore sample decode/load errors.
    }
  }

  stopPreviewSample(): void {
    if (this.previewSourceNode) {
      try { this.previewSourceNode.stop(); } catch { /* already ended */ }
      try { this.previewSourceNode.disconnect(); } catch { /* ignore */ }
      this.previewSourceNode = null;
    }
    if (this.previewGainNode) {
      try { this.previewGainNode.disconnect(); } catch { /* ignore */ }
      this.previewGainNode = null;
    }
  }

  async playPreviewSample(url: string, gain = 1): Promise<void> {
    this.stopPreviewSample();
    await this.ensureContext();
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode) return;
    if (gain <= 0) return;
    try {
      const buffer = await this.getSampleBuffer(url);
      this.stopPreviewSample();
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      const gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.setTargetAtTime(gain, audioCtx.currentTime, ONE_SHOT_ATTACK_SECONDS);
      source.connect(gainNode).connect(sfxGainNode);
      this.previewSourceNode = source;
      this.previewGainNode = gainNode;
      source.onended = () => {
        if (this.previewSourceNode === source) {
          this.previewSourceNode = null;
          this.previewGainNode = null;
        }
      };
      source.start();
    } catch {
      // Ignore decode/load errors.
    }
  }

  /** Starts a looping sample and returns a stop callback for explicit teardown. */
  async startLoopingSample(url: string, gain = 1): Promise<(() => void) | null> {
    await this.ensureContext();
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode || gain <= 0) return null;
    try {
      const buffer = await this.getSampleBuffer(url);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = gain;
      source.connect(gainNode).connect(sfxGainNode);
      source.start();
      return () => {
        try {
          source.stop();
        } catch {
          // Ignore already-stopped source.
        }
        source.disconnect();
        gainNode.disconnect();
      };
    } catch {
      return null;
    }
  }

  cleanupPeerAudio(peer: SpatialPeerRuntime): void {
    if (peer.audioElement) {
      peer.audioElement.pause();
      peer.audioElement.srcObject = null;
      peer.audioElement.remove();
    }
    peer.gain?.disconnect();
    peer.panner?.disconnect();
    peer.audioElement = undefined;
    peer.gain = undefined;
    peer.panner = undefined;
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
    this.rebuildLoopbackGraph(effect, this.effectValues[effect]);
  }

  private rebuildLoopbackGraph(effect: EffectId, effectValue: number): void {
    if (!this.audioCtx || !this.outboundInputGain) {
      return;
    }
    disconnectEffectRuntime(this.loopbackRuntime);
    this.loopbackRuntime = null;
    if (!this.loopbackEnabled) {
      return;
    }
    this.loopbackRuntime = connectEffectChain(
      this.audioCtx,
      this.outboundInputGain,
      this.masterGainNode ?? this.audioCtx.destination,
      effect,
      effectValue,
    );
  }

  private clampLevel(value: number): number {
    return clampEffectLevel(value);
  }

  private playSound(spec: SoundSpec): void {
    const { audioCtx, sfxGainNode } = this;
    if (!audioCtx || !sfxGainNode) return;

    const baseGain = spec.gain ?? 1;
    const resolved = spec.sourcePosition
      ? resolveSpatialMix({
          dx: spec.sourcePosition.x,
          dy: spec.sourcePosition.y,
          range: HEARING_RADIUS,
          baseGain,
        })
      : { gain: baseGain, pan: 0 };
    if (!resolved) return;
    const finalGain = resolved.gain;
    const panValue = spec.sourcePosition ? resolved.pan : undefined;

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

  private applySpatialSampleRuntime(
    sample: ActiveSpatialSampleRuntime,
    playerPosition: { x: number; y: number },
    initial = false,
  ): void {
    if (!this.audioCtx) return;
    const mix = resolveSpatialMix({
      dx: sample.sourceX - playerPosition.x,
      dy: sample.sourceY - playerPosition.y,
      range: sample.range,
      baseGain: sample.baseGain,
    });
    if (initial) {
      const gainValue = mix?.gain ?? 0;
      sample.gainNode.gain.setTargetAtTime(gainValue, this.audioCtx.currentTime, ONE_SHOT_ATTACK_SECONDS);
      if (sample.pannerNode) {
        const panValue = mix?.pan ?? 0;
        const resolvedPan = this.outputMode === 'mono' ? 0 : Math.max(-1, Math.min(1, panValue));
        sample.pannerNode.pan.setValueAtTime(resolvedPan, this.audioCtx.currentTime);
      }
      return;
    }
    applySpatialMixToNodes({
      audioCtx: this.audioCtx,
      gainNode: sample.gainNode,
      pannerNode: sample.pannerNode,
      mix,
      outputMode: this.outputMode,
      transition: 'target',
    });
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
