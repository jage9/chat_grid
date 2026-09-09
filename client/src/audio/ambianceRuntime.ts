import { HEARING_RADIUS, type AmbianceRegion, type AmbianceType } from '../state/gameState';
import { applyAcousticLowpass, normalizeAcousticMix, OPEN_AIR_LOWPASS_HZ, type AcousticMix } from './acoustics';
import { AudioEngine, type SpatialAudioPosition } from './audioEngine';
import {
  applySpatialMixToNodes,
  createSpatialPanner,
  disconnectSpatialPanner,
  resolveSpatialMix,
  SPATIAL_TIME_CONSTANT_SECONDS,
} from './spatial';

const DEFAULT_VOLUME_PERCENT = 25;
const DEFAULT_FADE_DISTANCE = 3;
const PLAY_RETRY_DELAY_MS = 5_000;
const PLAY_MAX_FAILURES = 3;

type AmbianceBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Geometry and custom attenuation for one ambience/listener pair. */
export type AmbianceSpatialResolution = {
  source: SpatialAudioPosition;
  distance: number;
  falloff: number;
  volume: number;
  inside: boolean;
};

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function getBounds(region: AmbianceRegion): AmbianceBounds | null {
  const coordinates = [region.startX, region.startY, region.endX, region.endY];
  if (!coordinates.every((coordinate) => Number.isFinite(coordinate))) return null;
  return {
    minX: Math.min(region.startX, region.endX),
    minY: Math.min(region.startY, region.endY),
    maxX: Math.max(region.startX, region.endX),
    maxY: Math.max(region.startY, region.endY),
  };
}

function clampTo(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Returns the closest point in an inclusive ambience rectangle. */
export function getAmbianceNearestPoint(
  region: AmbianceRegion,
  listener: Pick<SpatialAudioPosition, 'x' | 'y'>,
): { x: number; y: number } | null {
  const bounds = getBounds(region);
  if (!bounds || !Number.isFinite(listener.x) || !Number.isFinite(listener.y)) return null;
  return {
    x: clampTo(listener.x, bounds.minX, bounds.maxX),
    y: clampTo(listener.y, bounds.minY, bounds.maxY),
  };
}

/**
 * Resolves source position and rectangle attenuation. Every point on the
 * inclusive rectangle has full configured volume and a centered source.
 */
export function resolveAmbianceSpatialResolution(
  region: AmbianceRegion,
  listener: SpatialAudioPosition,
): AmbianceSpatialResolution | null {
  const nearest = getAmbianceNearestPoint(region, listener);
  if (!nearest || !Number.isFinite(region.floorZ)) return null;
  const bounds = getBounds(region);
  if (!bounds) return null;

  const inside = listener.x >= bounds.minX
    && listener.x <= bounds.maxX
    && listener.y >= bounds.minY
    && listener.y <= bounds.maxY;
  const distance = Math.hypot(nearest.x - listener.x, nearest.y - listener.y);
  const fadeDistance = clampNumber(region.fadeDistance, 0, 100, DEFAULT_FADE_DISTANCE);
  const falloff = inside
    ? 1
    : fadeDistance > 0
    ? Math.max(0, Math.min(1, 1 - distance / fadeDistance)) ** 2
    : 0;
  const volume = clampNumber(region.volume, 0, 100, DEFAULT_VOLUME_PERCENT) / 100;

  return {
    source: {
      x: nearest.x,
      y: nearest.y,
      z: region.floorZ,
      acousticZoneId: `floor:${region.floorZ}`,
    },
    distance,
    falloff,
    volume,
    inside,
  };
}

/** Returns whether an ambience is on the listener's physical floor. */
export function isAmbianceOnListenerFloor(region: AmbianceRegion, listener: SpatialAudioPosition): boolean {
  return Number.isFinite(region.floorZ) && region.floorZ === listener.z;
}

type SharedMediaSource = {
  url: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  references: number;
  playPending: boolean;
  started: boolean;
};

type AmbianceOutput = {
  soundId: string;
  url: string;
  gain: GainNode;
  occlusionFilter: BiquadFilterNode;
  panner: PannerNode;
  media: SharedMediaSource;
  silentUntil?: number;
};

type PlayFailure = {
  failures: number;
  nextRetryAtMs: number;
};

/**
 * Runs looping rectangle ambience through the shared spatial renderer.
 * Browser media elements are used for catalog sounds: the shipped set is six
 * long Ogg files, so streaming avoids retaining their roughly 120 MB decoded
 * footprint. A shared element per URL still permits overlapping regions to
 * have independent gain, filtering, and panning.
 */
export class AmbianceRuntime {
  private readonly outputs = new Map<string, AmbianceOutput>();
  private readonly types = new Map<string, AmbianceType>();
  private readonly mediaSources = new Map<string, SharedMediaSource>();
  private readonly playFailures = new Map<string, PlayFailure>();
  private layerEnabled = true;
  private generation = 0;
  private contextSetup: Promise<void> | null = null;

  constructor(
    private readonly audio: AudioEngine,
    private readonly getAcousticMix: (source: SpatialAudioPosition, listener: SpatialAudioPosition) => AcousticMix,
  ) {}

  /** Replaces the server-provided ambience sound catalog. */
  setTypes(types: Iterable<AmbianceType>): void {
    this.types.clear();
    for (const type of types) {
      if (!type || typeof type.id !== 'string' || typeof type.url !== 'string' || !type.url.trim()) continue;
      this.types.set(type.id, type);
    }
  }

  /** Synchronizes active regions and applies the current listener mix. */
  update(ambiances: Iterable<AmbianceRegion>, listener: SpatialAudioPosition, enabled: boolean): void {
    if (!enabled) {
      if (this.layerEnabled) this.generation += 1;
      this.layerEnabled = false;
      this.cleanupOutputs();
      return;
    }
    this.layerEnabled = true;

    // The normal app creates its AudioContext from a user gesture before the
    // game loop starts. If a reconnect races that setup, wait for the next
    // frame rather than constructing a graph against a missing context.
    if (!this.audio.context) {
      this.ensureContext();
      return;
    }

    const activeIds = new Set<string>();
    for (const region of ambiances) {
      if (!region || typeof region.id !== 'string') continue;
      const type = this.types.get(region.soundId);
      const resolution = resolveAmbianceSpatialResolution(region, listener);
      if (!type || !resolution || !isAmbianceOnListenerFloor(region, listener)) {
        this.cleanupOutput(region.id);
        continue;
      }

      if (!resolution.inside && resolution.falloff <= 0) {
        const output = this.outputs.get(region.id);
        if (output) {
          const now = this.audio.context.currentTime;
          if (output.silentUntil === undefined) {
            output.gain.gain.setTargetAtTime(0, now, SPATIAL_TIME_CONSTANT_SECONDS);
            output.silentUntil = now + SPATIAL_TIME_CONSTANT_SECONDS * 6;
          }
          if (now < output.silentUntil) activeIds.add(region.id);
          else this.cleanupOutput(region.id);
        }
        continue;
      }

      activeIds.add(region.id);
      let output: AmbianceOutput | undefined = this.outputs.get(region.id);
      if (output && (output.soundId !== region.soundId || output.url !== type.url)) {
        this.cleanupOutput(region.id);
        output = undefined;
      }
      if (!output) {
        if (!this.canAttemptPlay(type.url)) continue;
        const created = this.createOutput(region, type);
        if (!created) continue;
        output = created;
        this.outputs.set(region.id, created);
      }
      output.silentUntil = undefined;
      this.applyOutputMix(output, region, listener);
      void this.tryStartMedia(output.media, this.generation);
    }

    for (const regionId of Array.from(this.outputs.keys())) {
      if (!activeIds.has(regionId)) this.cleanupOutput(regionId);
    }
  }

  /** Stops current playback, invalidates late play promises, and is reusable. */
  cleanup(): void {
    this.generation += 1;
    this.layerEnabled = false;
    this.cleanupOutputs();
    this.playFailures.clear();
  }

  private ensureContext(): void {
    if (this.contextSetup) return;
    this.contextSetup = this.audio.ensureContext()
      .catch(() => undefined)
      .finally(() => {
        this.contextSetup = null;
      });
  }

  private cleanupOutputs(): void {
    for (const regionId of Array.from(this.outputs.keys())) this.cleanupOutput(regionId);
    for (const url of Array.from(this.mediaSources.keys())) this.releaseMediaSource(url);
  }

  private cleanupOutput(regionId: string): void {
    const output = this.outputs.get(regionId);
    if (!output) return;
    this.outputs.delete(regionId);
    try {
      output.media.source.disconnect(output.gain);
    } catch {
      // Ignore stale graph disconnects.
    }
    output.media.references -= 1;
    if (output.media.references <= 0) this.releaseMediaSource(output.media.url);
    output.gain.disconnect();
    output.occlusionFilter.disconnect();
    disconnectSpatialPanner(output.panner);
  }

  private releaseMediaSource(url: string): void {
    const media = this.mediaSources.get(url);
    if (!media) return;
    this.mediaSources.delete(url);
    media.playPending = false;
    media.started = false;
    media.element.pause();
    try {
      media.element.removeAttribute('src');
      media.element.load();
    } catch {
      // Ignore reset failures in browser and test media implementations.
    }
    try {
      media.source.disconnect();
    } catch {
      // Ignore stale graph disconnects.
    }
  }

  private canAttemptPlay(url: string): boolean {
    const failure = this.playFailures.get(url);
    return !failure || (failure.failures < PLAY_MAX_FAILURES && Date.now() >= failure.nextRetryAtMs);
  }

  private notePlayFailure(url: string): void {
    const previous = this.playFailures.get(url);
    this.playFailures.set(url, {
      failures: (previous?.failures ?? 0) + 1,
      nextRetryAtMs: Date.now() + PLAY_RETRY_DELAY_MS,
    });
  }

  private createOutput(region: AmbianceRegion, type: AmbianceType): AmbianceOutput | null {
    const context = this.audio.context;
    if (!context || typeof Audio !== 'function') {
      this.notePlayFailure(type.url);
      return null;
    }
    let gain: GainNode | null = null;
    let occlusionFilter: BiquadFilterNode | null = null;
    let panner: PannerNode | null = null;
    let media: SharedMediaSource | undefined;
    try {
      gain = context.createGain();
      gain.gain.value = 0;
      occlusionFilter = context.createBiquadFilter();
      occlusionFilter.type = 'lowpass';
      occlusionFilter.frequency.value = OPEN_AIR_LOWPASS_HZ;
      panner = createSpatialPanner(context);
      gain.connect(occlusionFilter);
      occlusionFilter.connect(panner);
      panner.connect(this.audio.getOutputDestinationNode() ?? context.destination);

      media = this.mediaSources.get(type.url);
      if (!media) {
        const element = new Audio(type.url);
        element.loop = true;
        element.preload = 'auto';
        element.crossOrigin = 'anonymous';
        const source = context.createMediaElementSource(element);
        media = { url: type.url, element, source, references: 0, playPending: false, started: false };
        this.mediaSources.set(type.url, media);
      }
      media.source.connect(gain);
      media.references += 1;
      return { soundId: region.soundId, url: type.url, gain, occlusionFilter, panner, media };
    } catch {
      if (media && media.references <= 0) this.releaseMediaSource(media.url);
      if (gain) gain.disconnect();
      if (occlusionFilter) occlusionFilter.disconnect();
      if (panner) disconnectSpatialPanner(panner);
      this.notePlayFailure(type.url);
      return null;
    }
  }

  private async tryStartMedia(media: SharedMediaSource, generation: number): Promise<void> {
    if (!this.layerEnabled || generation !== this.generation || media.started || media.playPending) return;
    if (!this.canAttemptPlay(media.url)) return;
    media.playPending = true;
    try {
      const result = media.element.play();
      if (result && typeof result.then === 'function') await result;
      if (this.layerEnabled && generation === this.generation && this.mediaSources.get(media.url) === media) {
        media.started = true;
        this.clearPlayFailure(media.url);
      }
    } catch {
      if (this.layerEnabled && generation === this.generation && this.mediaSources.get(media.url) === media) {
        this.notePlayFailure(media.url);
      }
    } finally {
      media.playPending = false;
    }
  }

  private clearPlayFailure(url: string): void {
    this.playFailures.delete(url);
  }

  private applyOutputMix(
    output: AmbianceOutput,
    region: AmbianceRegion,
    listener: SpatialAudioPosition,
  ): void {
    const resolution = resolveAmbianceSpatialResolution(region, listener);
    const audioCtx = this.audio.context;
    if (!audioCtx || !resolution || !isAmbianceOnListenerFloor(region, listener)) return;

    let acoustic: AcousticMix;
    try {
      const resolvedAcoustic = this.getAcousticMix(resolution.source, listener);
      if (!Number.isFinite(resolvedAcoustic.gain)) throw new Error('Invalid acoustic gain');
      acoustic = normalizeAcousticMix(resolvedAcoustic);
    } catch {
      // Acoustic routing is fail-closed if world state changes during a frame.
      acoustic = { gain: 0, lowpassHz: 20 };
    }
    applyAcousticLowpass(audioCtx, output.occlusionFilter, acoustic.lowpassHz);

    const fadeDistance = clampNumber(region.fadeDistance, 0, 100, DEFAULT_FADE_DISTANCE);
    const range = Math.max(1, HEARING_RADIUS, fadeDistance);
    const baseMix = resolution.falloff > 0
      ? resolveSpatialMix({
          dx: resolution.source.x - listener.x,
          dy: resolution.source.y - listener.y,
          dz: 0,
          range,
        })
      : null;
    // Keep resolveSpatialMix's shared direction/pan, but replace its shaped
    // distance gain with the rectangle's squared falloff.
    const mix = baseMix
      ? { ...baseMix, gain: resolution.volume * resolution.falloff * acoustic.gain }
      : null;
    applySpatialMixToNodes({
      audioCtx,
      gainNode: output.gain,
      pannerNode: output.panner,
      mix,
      transition: 'target',
    });
  }
}
