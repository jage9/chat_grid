import { HEARING_RADIUS, type WorldItem } from '../state/gameState';
import { EFFECT_IDS, clampEffectLevel, connectEffectChain, disconnectEffectRuntime, type EffectId, type EffectRuntime } from './effects';
import { AudioEngine } from './audioEngine';

export const RADIO_CHANNEL_OPTIONS = ['stereo', 'mono', 'left', 'right'] as const;
export type RadioChannelMode = (typeof RADIO_CHANNEL_OPTIONS)[number];

type SharedRadioSource = {
  streamUrl: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  refCount: number;
};

type ItemRadioOutput = {
  streamUrl: string;
  channel: RadioChannelMode;
  sharedSource: MediaElementAudioSourceNode;
  sourceInput: GainNode;
  channelSplitter: ChannelSplitterNode | null;
  channelMerger: ChannelMergerNode | null;
  channelLeftGain: GainNode | null;
  channelRightGain: GainNode | null;
  effectInput: GainNode;
  effectRuntime: EffectRuntime | null;
  effect: EffectId;
  effectValue: number;
  gain: GainNode;
  panner: StereoPannerNode | null;
};

export function normalizeRadioEffect(effect: unknown): EffectId {
  if (typeof effect !== 'string') return 'off';
  const normalized = effect.trim().toLowerCase() as EffectId;
  return EFFECT_IDS.has(normalized) ? normalized : 'off';
}

export function normalizeRadioEffectValue(effectValue: unknown): number {
  if (typeof effectValue !== 'number' || !Number.isFinite(effectValue)) {
    return 50;
  }
  return clampEffectLevel(effectValue);
}

export function normalizeRadioChannel(channel: unknown): RadioChannelMode {
  if (typeof channel !== 'string') return 'stereo';
  const normalized = channel.trim().toLowerCase() as RadioChannelMode;
  return (RADIO_CHANNEL_OPTIONS as readonly string[]).includes(normalized) ? normalized : 'stereo';
}

function connectRadioChannelSource(
  audioCtx: AudioContext,
  sharedSource: MediaElementAudioSourceNode,
  channel: RadioChannelMode,
  destination: GainNode,
): {
  sourceInput: GainNode;
  channelSplitter: ChannelSplitterNode | null;
  channelMerger: ChannelMergerNode | null;
  channelLeftGain: GainNode | null;
  channelRightGain: GainNode | null;
} {
  const sourceInput = audioCtx.createGain();
  sourceInput.gain.value = 1;

  if (channel === 'stereo') {
    sharedSource.connect(sourceInput);
    sourceInput.connect(destination);
    return {
      sourceInput,
      channelSplitter: null,
      channelMerger: null,
      channelLeftGain: null,
      channelRightGain: null,
    };
  }

  const splitter = audioCtx.createChannelSplitter(2);
  const merger = audioCtx.createChannelMerger(1);
  sharedSource.connect(splitter);

  let leftGain: GainNode | null = null;
  let rightGain: GainNode | null = null;
  if (channel === 'mono') {
    leftGain = audioCtx.createGain();
    rightGain = audioCtx.createGain();
    leftGain.gain.value = 0.5;
    rightGain.gain.value = 0.5;
    splitter.connect(leftGain, 0);
    splitter.connect(rightGain, 1);
    leftGain.connect(merger, 0, 0);
    rightGain.connect(merger, 0, 0);
  } else if (channel === 'left') {
    splitter.connect(merger, 0, 0);
  } else {
    splitter.connect(merger, 1, 0);
  }

  merger.connect(sourceInput);
  sourceInput.connect(destination);
  return {
    sourceInput,
    channelSplitter: splitter,
    channelMerger: merger,
    channelLeftGain: leftGain,
    channelRightGain: rightGain,
  };
}

function freshStreamUrl(streamUrl: string): string {
  const separator = streamUrl.includes('?') ? '&' : '?';
  return `${streamUrl}${separator}chgrid_start=${Date.now()}`;
}

export class RadioStationRuntime {
  private readonly sharedRadioSources = new Map<string, SharedRadioSource>();
  private readonly itemRadioOutputs = new Map<string, ItemRadioOutput>();
  private layerEnabled = true;

  constructor(private readonly audio: AudioEngine) {}

  cleanup(itemId: string): void {
    const output = this.itemRadioOutputs.get(itemId);
    if (!output) return;
    if (output.channelSplitter) {
      try {
        output.sharedSource.disconnect(output.channelSplitter);
      } catch {
        // Ignore stale graph disconnects.
      }
    } else {
      try {
        output.sharedSource.disconnect(output.sourceInput);
      } catch {
        // Ignore stale graph disconnects.
      }
    }
    output.channelLeftGain?.disconnect();
    output.channelRightGain?.disconnect();
    output.channelSplitter?.disconnect();
    output.channelMerger?.disconnect();
    output.sourceInput.disconnect();
    output.effectInput.disconnect();
    disconnectEffectRuntime(output.effectRuntime);
    output.gain.disconnect();
    output.panner?.disconnect();
    this.itemRadioOutputs.delete(itemId);
    this.releaseSharedSource(output.streamUrl);
  }

  cleanupAll(): void {
    for (const id of Array.from(this.itemRadioOutputs.keys())) {
      this.cleanup(id);
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
    for (const item of items) {
      if (item.type !== 'radio_station') continue;
      validIds.add(item.id);
      await this.ensureRuntime(item);
    }
    for (const id of Array.from(this.itemRadioOutputs.keys())) {
      if (!validIds.has(id)) {
        this.cleanup(id);
      }
    }
  }

  updateSpatialAudio(items: Map<string, WorldItem>, playerPosition: { x: number; y: number }): void {
    if (!this.layerEnabled) return;
    const audioCtx = this.audio.context;
    if (!audioCtx) return;
    for (const [itemId, output] of this.itemRadioOutputs.entries()) {
      const item = items.get(itemId);
      if (!item || item.type !== 'radio_station') {
        this.cleanup(itemId);
        continue;
      }
      const streamUrl = String(item.params.streamUrl ?? '').trim();
      const enabled = item.params.enabled !== false;
      const volume = Number(item.params.volume ?? 50);
      const normalizedVolume = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) / 100 : 0.5;
      const effect = normalizeRadioEffect(item.params.effect);
      const effectValue = normalizeRadioEffectValue(item.params.effectValue);
      this.applyEffect(output, audioCtx, effect, effectValue);
      if (!streamUrl || !enabled) {
        output.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
        continue;
      }
      const dist = Math.hypot(item.x - playerPosition.x, item.y - playerPosition.y);
      let gainValue = 0;
      let panValue = 0;
      if (dist < HEARING_RADIUS) {
        gainValue = Math.pow(1 - dist / HEARING_RADIUS, 2);
        panValue = Math.sin(((item.x - playerPosition.x) / HEARING_RADIUS) * (Math.PI / 2));
      }
      if (dist <= 1) {
        gainValue = 1;
        panValue = 0;
      }
      output.gain.gain.linearRampToValueAtTime(gainValue * normalizedVolume, audioCtx.currentTime + 0.1);
      if (output.panner) {
        const resolvedPan = this.audio.getOutputMode() === 'mono' ? 0 : Math.max(-1, Math.min(1, panValue));
        output.panner.pan.linearRampToValueAtTime(resolvedPan, audioCtx.currentTime + 0.1);
      }
    }
  }

  private applyEffect(
    output: ItemRadioOutput,
    audioCtx: AudioContext,
    effect: EffectId,
    effectValue: number,
  ): void {
    if (output.effect === effect && output.effectValue === effectValue) {
      return;
    }
    output.effectInput.disconnect();
    disconnectEffectRuntime(output.effectRuntime);
    output.effectRuntime = connectEffectChain(audioCtx, output.effectInput, output.gain, effect, effectValue);
    output.effect = effect;
    output.effectValue = effectValue;
  }

  private releaseSharedSource(streamUrl: string): void {
    const shared = this.sharedRadioSources.get(streamUrl);
    if (!shared) return;
    shared.refCount -= 1;
    if (shared.refCount > 0) return;
    shared.element.pause();
    shared.element.src = '';
    shared.source.disconnect();
    this.sharedRadioSources.delete(streamUrl);
  }

  private getOrCreateSharedSource(streamUrl: string): SharedRadioSource | null {
    const existing = this.sharedRadioSources.get(streamUrl);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    const audioCtx = this.audio.context;
    if (!audioCtx) return null;
    const element = new Audio(freshStreamUrl(streamUrl));
    element.crossOrigin = 'anonymous';
    element.loop = true;
    element.preload = 'none';
    const source = audioCtx.createMediaElementSource(element);
    void element.play().catch(() => undefined);
    const shared: SharedRadioSource = {
      streamUrl,
      element,
      source,
      refCount: 1,
    };
    this.sharedRadioSources.set(streamUrl, shared);
    return shared;
  }

  private async ensureRuntime(item: WorldItem): Promise<void> {
    const streamUrl = String(item.params.streamUrl ?? '').trim();
    if (!streamUrl) {
      this.cleanup(item.id);
      return;
    }
    await this.audio.ensureContext();
    const audioCtx = this.audio.context;
    if (!audioCtx) return;

    const channel = normalizeRadioChannel(item.params.channel);
    const existing = this.itemRadioOutputs.get(item.id);
    if (existing && existing.streamUrl === streamUrl && existing.channel === channel) {
      return;
    }
    if (existing) {
      this.cleanup(item.id);
    }

    const shared = this.getOrCreateSharedSource(streamUrl);
    if (!shared) return;

    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    const effectInput = audioCtx.createGain();
    const channelSource = connectRadioChannelSource(audioCtx, shared.source, channel, effectInput);
    const effect = normalizeRadioEffect(item.params.effect);
    const effectValue = normalizeRadioEffectValue(item.params.effectValue);
    const effectRuntime = connectEffectChain(audioCtx, effectInput, gain, effect, effectValue);
    let panner: StereoPannerNode | null = null;
    if (this.audio.supportsStereoPanner()) {
      panner = audioCtx.createStereoPanner();
      gain.connect(panner).connect(audioCtx.destination);
    } else {
      gain.connect(audioCtx.destination);
    }
    this.itemRadioOutputs.set(item.id, {
      streamUrl,
      channel,
      sharedSource: shared.source,
      sourceInput: channelSource.sourceInput,
      channelSplitter: channelSource.channelSplitter,
      channelMerger: channelSource.channelMerger,
      channelLeftGain: channelSource.channelLeftGain,
      channelRightGain: channelSource.channelRightGain,
      effectInput,
      effectRuntime,
      effect,
      effectValue,
      gain,
      panner,
    });
  }
}
