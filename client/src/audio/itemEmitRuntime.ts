import { HEARING_RADIUS, type WorldItem } from '../state/gameState';
import { getItemTypeGlobalProperties } from '../items/itemRegistry';
import { AudioEngine } from './audioEngine';
import { connectEffectChain, disconnectEffectRuntime, type EffectId, type EffectRuntime } from './effects';
import { normalizeRadioEffect, normalizeRadioEffectValue } from './radioStationRuntime';
import { resolveSpatialMix } from './spatial';

type EmitOutput = {
  soundUrl: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  effectInput: GainNode;
  effectRuntime: EffectRuntime | null;
  effect: EffectId;
  effectValue: number;
  gain: GainNode;
  panner: StereoPannerNode | null;
};

type EmitSpatialConfig = {
  range: number;
  directional: boolean;
  facingDeg: number;
};

const ITEM_EMIT_BASE_GAIN = 0.3;

function resolveEmitPlaybackRate(raw: unknown): number {
  const speed = Number(raw);
  const clamped = Number.isFinite(speed) ? Math.max(0, Math.min(100, speed)) : 50;
  if (clamped <= 50) {
    return 0.5 + (clamped / 50) * 0.5;
  }
  return 1 + ((clamped - 50) / 50) * 1;
}

function setElementPreservesPitch(element: HTMLAudioElement, enabled: boolean): void {
  const target = element as HTMLAudioElement & {
    preservesPitch?: boolean;
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  if ('preservesPitch' in target) target.preservesPitch = enabled;
  if ('mozPreservesPitch' in target) target.mozPreservesPitch = enabled;
  if ('webkitPreservesPitch' in target) target.webkitPreservesPitch = enabled;
}

function resolveEmitRates(item: WorldItem): { playbackRate: number; preservePitch: boolean } {
  const globals = getItemTypeGlobalProperties(item.type);
  const speed = resolveEmitPlaybackRate(item.params.emitSoundSpeed ?? globals.emitSoundSpeed ?? 50);
  const tempo = resolveEmitPlaybackRate(item.params.emitSoundTempo ?? globals.emitSoundTempo ?? 50);
  const playbackRate = Math.max(0.25, Math.min(4, speed * tempo));
  const preservePitch = Math.abs(speed - 1) < 0.001;
  return { playbackRate, preservePitch };
}

export class ItemEmitRuntime {
  private readonly outputs = new Map<string, EmitOutput>();
  private layerEnabled = true;

  constructor(
    private readonly audio: AudioEngine,
    private readonly resolveSoundUrl: (soundPath: string) => string,
    private readonly getSpatialConfig: (item: WorldItem) => EmitSpatialConfig,
  ) {}

  cleanup(itemId: string): void {
    const output = this.outputs.get(itemId);
    if (!output) return;
    output.element.pause();
    output.element.src = '';
    output.source.disconnect();
    output.effectInput.disconnect();
    disconnectEffectRuntime(output.effectRuntime);
    output.gain.disconnect();
    output.panner?.disconnect();
    this.outputs.delete(itemId);
  }

  cleanupAll(): void {
    for (const itemId of Array.from(this.outputs.keys())) {
      this.cleanup(itemId);
    }
  }

  async setLayerEnabled(enabled: boolean, items: Iterable<WorldItem>): Promise<void> {
    this.layerEnabled = enabled;
    if (!enabled) {
      this.cleanupAll();
      return;
    }
    await this.sync(items);
  }

  async sync(items: Iterable<WorldItem>): Promise<void> {
    if (!this.layerEnabled) {
      this.cleanupAll();
      return;
    }
    const validIds = new Set<string>();
    await this.audio.ensureContext();
    const audioCtx = this.audio.context;
    if (!audioCtx) return;

    for (const item of items) {
      const emitSound = String(item.params.emitSound ?? item.emitSound ?? '').trim();
      const enabled = item.params.enabled !== false;
      const soundUrl = enabled ? this.resolveSoundUrl(emitSound) : '';
      if (!soundUrl || item.carrierId) {
        this.cleanup(item.id);
        continue;
      }
      validIds.add(item.id);
      const existing = this.outputs.get(item.id);
      if (existing && existing.soundUrl === soundUrl) {
        continue;
      }
      if (existing) {
        this.cleanup(item.id);
      }
      const element = new Audio(soundUrl);
      element.loop = true;
      element.preload = 'none';
      element.crossOrigin = 'anonymous';
      const source = audioCtx.createMediaElementSource(element);
      const effectInput = audioCtx.createGain();
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      let panner: StereoPannerNode | null = null;
      source.connect(effectInput);
      const effect = normalizeRadioEffect(item.params.emitEffect);
      const effectValue = normalizeRadioEffectValue(item.params.emitEffectValue);
      const effectRuntime = connectEffectChain(audioCtx, effectInput, gain, effect, effectValue);
      const initialRates = resolveEmitRates(item);
      setElementPreservesPitch(element, initialRates.preservePitch);
      element.playbackRate = initialRates.playbackRate;
      if (this.audio.supportsStereoPanner()) {
        panner = audioCtx.createStereoPanner();
        gain.connect(panner).connect(audioCtx.destination);
      } else {
        gain.connect(audioCtx.destination);
      }
      this.outputs.set(item.id, { soundUrl, element, source, effectInput, effectRuntime, effect, effectValue, gain, panner });
      void element.play().catch(() => undefined);
    }

    for (const itemId of Array.from(this.outputs.keys())) {
      if (!validIds.has(itemId)) {
        this.cleanup(itemId);
      }
    }
  }

  updateSpatialAudio(items: Map<string, WorldItem>, playerPosition: { x: number; y: number }): void {
    if (!this.layerEnabled) return;
    const audioCtx = this.audio.context;
    if (!audioCtx) return;

    for (const [itemId, output] of this.outputs.entries()) {
      const item = items.get(itemId);
      if (!item || item.carrierId) {
        output.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
        continue;
      }
      const effect = normalizeRadioEffect(item.params.emitEffect);
      const effectValue = normalizeRadioEffectValue(item.params.emitEffectValue);
      if (output.effect !== effect || output.effectValue !== effectValue) {
        output.effectInput.disconnect();
        disconnectEffectRuntime(output.effectRuntime);
        output.effectRuntime = connectEffectChain(audioCtx, output.effectInput, output.gain, effect, effectValue);
        output.effect = effect;
        output.effectValue = effectValue;
      }
      const nextRates = resolveEmitRates(item);
      setElementPreservesPitch(output.element, nextRates.preservePitch);
      const nextPlaybackRate = nextRates.playbackRate;
      if (Math.abs(output.element.playbackRate - nextPlaybackRate) > 0.001) {
        output.element.playbackRate = nextPlaybackRate;
      }
      const spatialConfig = this.getSpatialConfig(item);
      const mix = resolveSpatialMix({
        dx: item.x - playerPosition.x,
        dy: item.y - playerPosition.y,
        range: Math.max(1, spatialConfig.range || HEARING_RADIUS),
        baseGain: ITEM_EMIT_BASE_GAIN,
        nearFieldDistance: 1,
        nearFieldGain: 1,
        nearFieldCenterPan: true,
        directional: {
          enabled: spatialConfig.directional,
          facingDeg: spatialConfig.facingDeg,
          coneDeg: 120,
          rearGain: 0.4,
        },
      });
      const gainValue = mix?.gain ?? 0;
      const panValue = mix?.pan ?? 0;
      const emitVolumeRaw = Number(item.params.emitVolume ?? 100);
      const emitVolume = Number.isFinite(emitVolumeRaw) ? Math.max(0, Math.min(100, emitVolumeRaw)) / 100 : 1;
      output.gain.gain.linearRampToValueAtTime(gainValue * emitVolume, audioCtx.currentTime + 0.1);
      if (output.panner) {
        const resolvedPan = this.audio.getOutputMode() === 'mono' ? 0 : Math.max(-1, Math.min(1, panValue));
        output.panner.pan.linearRampToValueAtTime(resolvedPan, audioCtx.currentTime + 0.1);
      }
    }
  }
}
