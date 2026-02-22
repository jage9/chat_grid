import { HEARING_RADIUS, type WorldItem } from '../state/gameState';
import { AudioEngine } from './audioEngine';
import { resolveSpatialMix } from './spatial';

type EmitOutput = {
  soundUrl: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
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
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      let panner: StereoPannerNode | null = null;
      source.connect(gain);
      if (this.audio.supportsStereoPanner()) {
        panner = audioCtx.createStereoPanner();
        gain.connect(panner).connect(audioCtx.destination);
      } else {
        gain.connect(audioCtx.destination);
      }
      this.outputs.set(item.id, { soundUrl, element, source, gain, panner });
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
