import { HEARING_RADIUS, type WorldItem } from '../state/gameState';
import { AudioEngine } from './audioEngine';
import { resolveDirectionalMuffleRatio, resolveSpatialMix } from './spatial';

type EmitOutput = {
  soundUrl: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  directionalFilter: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
};

type EmitSpatialConfig = {
  range: number;
  directional: boolean;
  facingDeg: number;
};

const ITEM_EMIT_BASE_GAIN = 0.3;

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
    output.directionalFilter.disconnect();
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
      const soundUrl = this.resolveSoundUrl(String(item.emitSound ?? '').trim());
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
      const directionalFilter = audioCtx.createBiquadFilter();
      directionalFilter.type = 'lowpass';
      directionalFilter.frequency.value = 12000;
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      let panner: StereoPannerNode | null = null;
      source.connect(directionalFilter).connect(gain);
      if (this.audio.supportsStereoPanner()) {
        panner = audioCtx.createStereoPanner();
        gain.connect(panner).connect(audioCtx.destination);
      } else {
        gain.connect(audioCtx.destination);
      }
      this.outputs.set(item.id, { soundUrl, element, source, directionalFilter, gain, panner });
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
          rearGain: 0.5,
        },
      });
      const gainValue = mix?.gain ?? 0;
      const panValue = mix?.pan ?? 0;
      const muffleRatio = resolveDirectionalMuffleRatio(
        item.x - playerPosition.x,
        item.y - playerPosition.y,
        {
          enabled: spatialConfig.directional,
          facingDeg: spatialConfig.facingDeg,
          coneDeg: 120,
          rearGain: 0.35,
        },
      );
      const clearCutoffHz = 22050;
      const rearCutoffHz = 4500;
      const muffleCurve = muffleRatio * muffleRatio;
      const cutoffHz = clearCutoffHz - (clearCutoffHz - rearCutoffHz) * muffleCurve;
      output.directionalFilter.frequency.linearRampToValueAtTime(cutoffHz, audioCtx.currentTime + 0.1);
      output.gain.gain.linearRampToValueAtTime(gainValue, audioCtx.currentTime + 0.1);
      if (output.panner) {
        const resolvedPan = this.audio.getOutputMode() === 'mono' ? 0 : Math.max(-1, Math.min(1, panValue));
        output.panner.pan.linearRampToValueAtTime(resolvedPan, audioCtx.currentTime + 0.1);
      }
    }
  }
}
