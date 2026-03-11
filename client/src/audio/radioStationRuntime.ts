import { HEARING_RADIUS, type WorldItem } from '../state/gameState';
import { EFFECT_IDS, clampEffectLevel, connectEffectChain, disconnectEffectRuntime, type EffectId, type EffectRuntime } from './effects';
import { AudioEngine } from './audioEngine';
import { applySpatialMixToNodes, resolveSpatialMix } from './spatial';
import { volumePercentToGain } from './volume';

export const RADIO_CHANNEL_OPTIONS = ['stereo', 'mono', 'left', 'right'] as const;
export type RadioChannelMode = (typeof RADIO_CHANNEL_OPTIONS)[number];
const APP_BASE_PATH = import.meta.env.BASE_URL ?? '/';

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

/** Connects a shared radio media source according to channel mode. */
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

/** Returns whether a hostname belongs to Dropbox domains that need proxy support. */
export function shouldProxyStreamUrl(streamUrl: string): boolean {
  try {
    const parsed = new URL(streamUrl);
    if (
      parsed.origin === window.location.origin &&
      parsed.pathname.toLowerCase().endsWith('/media_proxy.php')
    ) {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function getProxyUrlForStream(streamUrl: string): string {
  const normalizedBase = APP_BASE_PATH.endsWith('/') ? APP_BASE_PATH : `${APP_BASE_PATH}/`;
  const proxy = new URL(`${normalizedBase}media_proxy.php`, window.location.origin);
  proxy.searchParams.set('url', streamUrl);
  return proxy.toString();
}

/** Appends a cache-buster query parameter to avoid stale stream buffers between sessions. */
function freshStreamUrl(streamUrl: string): string {
  const playbackSource = shouldProxyStreamUrl(streamUrl) ? getProxyUrlForStream(streamUrl) : streamUrl;
  try {
    const parsed = new URL(playbackSource);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith('dropbox.com') || hostname.endsWith('dropboxusercontent.com')) {
      return playbackSource;
    }
  } catch {
    // Leave non-URL strings to the generic cache-buster behavior below.
  }
  const separator = playbackSource.includes('?') ? '&' : '?';
  return `${playbackSource}${separator}chgrid_start=${Date.now()}`;
}

type RadioSpatialConfig = {
  range: number;
  directional: boolean;
  facingDeg: number;
};

const SUBSCRIBE_PRELOAD_SQUARES = 5;
const UNSUBSCRIBE_HYSTERESIS_SQUARES = 8;
const STREAM_PLAY_RETRY_MS = 5000;
const STREAM_PLAY_MAX_RETRIES = 6;
const STREAM_PLAY_RESET_COOLDOWN_MS = 60000;

export class RadioStationRuntime {
  private readonly sharedRadioSources = new Map<string, SharedRadioSource>();
  private readonly itemRadioOutputs = new Map<string, ItemRadioOutput>();
  private readonly pendingSharedStarts = new Set<string>();
  private readonly nextSharedStartAtMs = new Map<string, number>();
  private readonly sharedStartFailureCount = new Map<string, number>();
  private layerEnabled = true;
  private listenerPositions: Array<{ x: number; y: number }> = [];

  constructor(
    private readonly audio: AudioEngine,
    private readonly getSpatialConfig: (item: WorldItem) => RadioSpatialConfig,
  ) {}

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

  async setLayerEnabled(
    enabled: boolean,
    items: Iterable<WorldItem>,
    listenerPosition: { x: number; y: number } | null = null,
  ): Promise<void> {
    this.layerEnabled = enabled;
    this.listenerPositions = listenerPosition ? [{ ...listenerPosition }] : [];
    if (!enabled) {
      this.cleanupAll();
      return;
    }
    await this.sync(items, this.listenerPositions);
  }

  async sync(
    items: Iterable<WorldItem>,
    listenerPositions: Array<{ x: number; y: number }> | { x: number; y: number } | null = null,
  ): Promise<void> {
    if (!this.layerEnabled) {
      this.cleanupAll();
      return;
    }
    if (Array.isArray(listenerPositions)) {
      this.listenerPositions = listenerPositions.map((listener) => ({ ...listener }));
    } else if (listenerPositions) {
      this.listenerPositions = [{ ...listenerPositions }];
    }
    const listeners = this.listenerPositions;
    const validIds = new Set<string>();
    for (const item of items) {
      if (item.type !== 'radio_station') continue;
      validIds.add(item.id);
      if (!this.shouldKeepRuntime(item, listeners, this.itemRadioOutputs.has(item.id))) {
        this.cleanup(item.id);
        continue;
      }
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
      const normalizedVolume = volumePercentToGain(item.params.mediaVolume, 50);
      const effect = normalizeRadioEffect(item.params.mediaEffect);
      const effectValue = normalizeRadioEffectValue(item.params.mediaEffectValue);
      this.applyEffect(output, audioCtx, effect, effectValue);
      if (!streamUrl || !enabled) {
        output.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
        continue;
      }
      const shared = this.sharedRadioSources.get(output.streamUrl);
      if (shared) {
        this.tryStartSharedPlayback(shared);
      }
      const spatialConfig = this.getSpatialConfig(item);
      const mix = resolveSpatialMix({
        dx: item.x - playerPosition.x,
        dy: item.y - playerPosition.y,
        range: Math.max(1, spatialConfig.range || HEARING_RADIUS),
        baseGain: normalizedVolume,
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
      applySpatialMixToNodes({
        audioCtx,
        gainNode: output.gain,
        pannerNode: output.panner,
        mix,
        outputMode: this.audio.getOutputMode(),
        transition: 'target',
      });
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
    this.pendingSharedStarts.delete(streamUrl);
    this.nextSharedStartAtMs.delete(streamUrl);
    this.sharedStartFailureCount.delete(streamUrl);
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
    const shared: SharedRadioSource = {
      streamUrl,
      element,
      source,
      refCount: 1,
    };
    this.sharedRadioSources.set(streamUrl, shared);
    this.tryStartSharedPlayback(shared);
    return shared;
  }

  private tryStartSharedPlayback(shared: SharedRadioSource): void {
    if (!shared.element.paused) {
      this.nextSharedStartAtMs.delete(shared.streamUrl);
      return;
    }
    if (this.pendingSharedStarts.has(shared.streamUrl)) {
      return;
    }
    const now = Date.now();
    const retryAt = this.nextSharedStartAtMs.get(shared.streamUrl) ?? 0;
    if (now < retryAt) {
      return;
    }
    this.pendingSharedStarts.add(shared.streamUrl);
    if (shared.element.error) {
      try {
        shared.element.load();
      } catch {
        // Ignore stale media reload failures.
      }
    }
    void shared.element
      .play()
      .then(() => {
        this.nextSharedStartAtMs.delete(shared.streamUrl);
        this.sharedStartFailureCount.delete(shared.streamUrl);
      })
      .catch(() => {
        const failures = (this.sharedStartFailureCount.get(shared.streamUrl) ?? 0) + 1;
        if (failures >= STREAM_PLAY_MAX_RETRIES) {
          this.sharedStartFailureCount.set(shared.streamUrl, 0);
          this.nextSharedStartAtMs.set(shared.streamUrl, Date.now() + STREAM_PLAY_RESET_COOLDOWN_MS);
          return;
        }
        this.sharedStartFailureCount.set(shared.streamUrl, failures);
        this.nextSharedStartAtMs.set(shared.streamUrl, Date.now() + STREAM_PLAY_RETRY_MS);
      })
      .finally(() => {
        this.pendingSharedStarts.delete(shared.streamUrl);
      });
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

    const channel = normalizeRadioChannel(item.params.mediaChannel);
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
    const effect = normalizeRadioEffect(item.params.mediaEffect);
    const effectValue = normalizeRadioEffectValue(item.params.mediaEffectValue);
    const effectRuntime = connectEffectChain(audioCtx, effectInput, gain, effect, effectValue);
    const destination = this.audio.getOutputDestinationNode() ?? audioCtx.destination;
    let panner: StereoPannerNode | null = null;
    if (this.audio.supportsStereoPanner()) {
      panner = audioCtx.createStereoPanner();
      gain.connect(panner).connect(destination);
    } else {
      gain.connect(destination);
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

  private shouldKeepRuntime(
    item: WorldItem,
    listenerPositions: Array<{ x: number; y: number }>,
    currentlyActive: boolean,
  ): boolean {
    const streamUrl = String(item.params.streamUrl ?? '').trim();
    if (!streamUrl || item.params.enabled === false || listenerPositions.length === 0) {
      return false;
    }
    const spatialConfig = this.getSpatialConfig(item);
    const baseRange = Math.max(1, spatialConfig.range || HEARING_RADIUS);
    const threshold = baseRange + (currentlyActive ? UNSUBSCRIBE_HYSTERESIS_SQUARES : SUBSCRIBE_PRELOAD_SQUARES);
    return listenerPositions.some((listenerPosition) =>
      Math.hypot(item.x - listenerPosition.x, item.y - listenerPosition.y) <= threshold,
    );
  }
}
