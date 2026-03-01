import { HEARING_RADIUS, type WorldItem } from '../state/gameState';
import { getItemTypeGlobalProperties } from '../items/itemRegistry';
import { AudioEngine } from './audioEngine';
import { connectEffectChain, disconnectEffectRuntime, type EffectId, type EffectRuntime } from './effects';
import { normalizeRadioEffect, normalizeRadioEffectValue } from './radioStationRuntime';
import { applySpatialMixToNodes, resolveSpatialMix } from './spatial';
import { volumePercentToGain } from './volume';

type EmitOutput = {
  soundUrl: string;
  element: HTMLAudioElement;
  onEnded: () => void;
  source: MediaElementAudioSourceNode;
  effectInput: GainNode;
  effectRuntime: EffectRuntime | null;
  effect: EffectId;
  effectValue: number;
  initialDelaySeconds: number;
  loopDelaySeconds: number;
  gain: GainNode;
  panner: StereoPannerNode | null;
};

type EmitResumeState = {
  soundUrl: string;
  savedAtMs: number;
  currentTimeSeconds: number;
  playbackRate: number;
  loopDelaySeconds: number;
  durationSeconds: number | null;
  wasPlaying: boolean;
};

type EmitSpatialConfig = {
  range: number;
  directional: boolean;
  facingDeg: number;
};

const ITEM_EMIT_BASE_GAIN = 1;
const SUBSCRIBE_PRELOAD_SQUARES = 5;
const UNSUBSCRIBE_HYSTERESIS_SQUARES = 8;
const STREAM_PLAY_RETRY_MS = 5000;
const STREAM_PLAY_MAX_RETRIES = 6;
const STREAM_PLAY_RESET_COOLDOWN_MS = 60000;

/** Maps a 0-100 speed control to playback-rate range used by emitted audio. */
function resolveEmitPlaybackRate(raw: unknown): number {
  const speed = Number(raw);
  const clamped = Number.isFinite(speed) ? Math.max(0, Math.min(100, speed)) : 50;
  if (clamped <= 50) {
    return 0.5 + (clamped / 50) * 0.5;
  }
  return 1 + ((clamped - 50) / 50) * 1;
}

/** Sets browser-specific preserve-pitch flags when changing element playback rate. */
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

/** Resolves effective emit playback/pitch settings from item params with global fallbacks. */
function resolveEmitRates(item: WorldItem): { playbackRate: number; preservePitch: boolean } {
  const globals = getItemTypeGlobalProperties(item.type);
  const speed = resolveEmitPlaybackRate(item.params.emitSoundSpeed ?? globals.emitSoundSpeed ?? 50);
  const tempo = resolveEmitPlaybackRate(item.params.emitSoundTempo ?? globals.emitSoundTempo ?? 50);
  const playbackRate = Math.max(0.25, Math.min(4, speed * tempo));
  const preservePitch = Math.abs(speed - 1) < 0.001;
  return { playbackRate, preservePitch };
}

/** Resolves the optional emit loop delay in seconds from item params. */
function resolveEmitLoopDelaySeconds(item: WorldItem): number {
  const globals = getItemTypeGlobalProperties(item.type);
  const delaySeconds = Number(item.params.emitLoopDelay ?? globals.emitLoopDelay ?? 0);
  const clamped = Number.isFinite(delaySeconds) ? Math.max(0, Math.min(300, delaySeconds)) : 0;
  return Math.round(clamped * 10) / 10;
}

/** Resolves the optional emit initial delay in seconds from item params. */
function resolveEmitInitialDelaySeconds(item: WorldItem): number {
  const globals = getItemTypeGlobalProperties(item.type);
  const delaySeconds = Number(item.params.emitInitialDelay ?? globals.emitInitialDelay ?? 0);
  const clamped = Number.isFinite(delaySeconds) ? Math.max(0, Math.min(300, delaySeconds)) : 0;
  return Math.round(clamped * 10) / 10;
}

export class ItemEmitRuntime {
  private readonly outputs = new Map<string, EmitOutput>();
  private readonly resumeStateByItemId = new Map<string, EmitResumeState>();
  private readonly pendingEmitStarts = new Set<string>();
  private readonly nextEmitStartAtMs = new Map<string, number>();
  private readonly emitStartFailureCount = new Map<string, number>();
  private layerEnabled = true;
  private listenerPositions: Array<{ x: number; y: number }> = [];

  constructor(
    private readonly audio: AudioEngine,
    private readonly resolveSoundUrl: (soundPath: string) => string,
    private readonly getSpatialConfig: (item: WorldItem) => EmitSpatialConfig,
  ) {}

  cleanup(itemId: string, options?: { preserveSchedule?: boolean }): void {
    const preserveSchedule = options?.preserveSchedule === true;
    const output = this.outputs.get(itemId);
    if (output) {
      if (preserveSchedule) {
        const duration = Number(output.element.duration);
        this.resumeStateByItemId.set(itemId, {
          soundUrl: output.soundUrl,
          savedAtMs: Date.now(),
          currentTimeSeconds: Number.isFinite(output.element.currentTime) ? Math.max(0, output.element.currentTime) : 0,
          playbackRate: Number.isFinite(output.element.playbackRate) && output.element.playbackRate > 0 ? output.element.playbackRate : 1,
          loopDelaySeconds: output.loopDelaySeconds,
          durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
          wasPlaying: !output.element.paused,
        });
      } else {
        this.resumeStateByItemId.delete(itemId);
      }
      output.element.pause();
      output.element.removeEventListener('ended', output.onEnded);
      output.element.src = '';
      output.source.disconnect();
      output.effectInput.disconnect();
      disconnectEffectRuntime(output.effectRuntime);
      output.gain.disconnect();
      output.panner?.disconnect();
      this.outputs.delete(itemId);
    }
    this.pendingEmitStarts.delete(itemId);
    if (!preserveSchedule) {
      this.nextEmitStartAtMs.delete(itemId);
    }
    this.emitStartFailureCount.delete(itemId);
  }

  cleanupAll(): void {
    for (const itemId of Array.from(this.outputs.keys())) {
      this.cleanup(itemId);
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
    const seenItemIds = new Set<string>();
    let audioCtx = this.audio.context;

    for (const item of items) {
      seenItemIds.add(item.id);
      const emitSound = String(item.params.emitSound ?? item.emitSound ?? '').trim();
      const enabled = item.params.enabled !== false;
      const soundUrl = enabled ? this.resolveSoundUrl(emitSound) : '';
      if (!soundUrl) {
        this.cleanup(item.id);
        continue;
      }
      if (!this.shouldKeepRuntime(item, listeners, this.outputs.has(item.id))) {
        this.cleanup(item.id, { preserveSchedule: true });
        continue;
      }
      validIds.add(item.id);
      const existing = this.outputs.get(item.id);
      if (existing && existing.soundUrl === soundUrl) {
        this.resumeStateByItemId.delete(item.id);
        continue;
      }
      if (existing) {
        this.cleanup(item.id);
      }
      if (!audioCtx) {
        await this.audio.ensureContext();
        audioCtx = this.audio.context;
      }
      if (!audioCtx) {
        continue;
      }
      const element = new Audio(soundUrl);
      element.loop = false;
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
      const initialDelaySeconds = resolveEmitInitialDelaySeconds(item);
      const loopDelaySeconds = resolveEmitLoopDelaySeconds(item);
      element.loop = loopDelaySeconds <= 0;
      const resumeState = this.resumeStateByItemId.get(item.id);
      const matchingResumeState = resumeState && resumeState.soundUrl === soundUrl ? resumeState : null;
      const onEnded = () => {
        const current = this.outputs.get(item.id);
        if (!current || current.element !== element) return;
        const delaySeconds = current.loopDelaySeconds ?? 0;
        if (delaySeconds <= 0) {
          this.nextEmitStartAtMs.delete(item.id);
          this.tryStartEmitPlayback(item.id, element);
          return;
        }
        this.nextEmitStartAtMs.set(item.id, Date.now() + delaySeconds * 1000);
      };
      element.addEventListener('ended', onEnded);
      if (matchingResumeState) {
        const nowMs = Date.now();
        const elapsedSeconds = Math.max(0, (nowMs - matchingResumeState.savedAtMs) / 1000);
        const effectiveRate = matchingResumeState.playbackRate > 0 ? matchingResumeState.playbackRate : 1;
        const durationSeconds = matchingResumeState.durationSeconds;
        if (durationSeconds && durationSeconds > 0) {
          const loopDelaySeconds = Math.max(0, matchingResumeState.loopDelaySeconds);
          const playWallSeconds = durationSeconds / effectiveRate;
          const cycleWallSeconds = playWallSeconds + loopDelaySeconds;
          const seekAndPlayNow = (targetTimeSeconds: number) => {
            const clampedTarget = Math.min(Math.max(0, targetTimeSeconds), Math.max(0, durationSeconds - 0.01));
            const applySeek = () => {
              try {
                element.currentTime = clampedTarget;
              } catch {
                // Ignore seek failures before metadata is fully available.
              }
            };
            applySeek();
            element.addEventListener('loadedmetadata', applySeek, { once: true });
            this.nextEmitStartAtMs.delete(item.id);
          };
          const scheduleAfterSeconds = (seconds: number) => {
            this.nextEmitStartAtMs.set(item.id, nowMs + Math.max(0, seconds) * 1000);
          };
          const scheduledStartMs = this.nextEmitStartAtMs.get(item.id);
          if (scheduledStartMs !== undefined) {
            if (nowMs < scheduledStartMs) {
              // Still in delay window tracked while runtime was out of range.
            } else if (cycleWallSeconds > 0) {
              const sinceStartSeconds = Math.max(0, (nowMs - scheduledStartMs) / 1000);
              const inCycleSeconds = sinceStartSeconds % cycleWallSeconds;
              if (inCycleSeconds < playWallSeconds) {
                seekAndPlayNow(inCycleSeconds * effectiveRate);
              } else {
                scheduleAfterSeconds(cycleWallSeconds - inCycleSeconds);
              }
            } else {
              seekAndPlayNow(0);
            }
          } else if (matchingResumeState.wasPlaying) {
            const playRemainingWallSeconds = Math.max(
              0,
              (durationSeconds - Math.max(0, matchingResumeState.currentTimeSeconds)) / effectiveRate,
            );
            if (elapsedSeconds < playRemainingWallSeconds) {
              seekAndPlayNow(Math.max(0, matchingResumeState.currentTimeSeconds) + elapsedSeconds * effectiveRate);
            } else {
              const afterTrackSeconds = elapsedSeconds - playRemainingWallSeconds;
              if (cycleWallSeconds > 0) {
                const inCycleSeconds = afterTrackSeconds % cycleWallSeconds;
                if (inCycleSeconds < loopDelaySeconds) {
                  scheduleAfterSeconds(loopDelaySeconds - inCycleSeconds);
                } else {
                  seekAndPlayNow((inCycleSeconds - loopDelaySeconds) * effectiveRate);
                }
              } else {
                seekAndPlayNow(0);
              }
            }
          } else {
            // Saved while paused/ended with no known schedule: treat as delay-first state.
            if (elapsedSeconds < loopDelaySeconds) {
              scheduleAfterSeconds(loopDelaySeconds - elapsedSeconds);
            } else if (cycleWallSeconds > 0) {
              const afterDelaySeconds = elapsedSeconds - loopDelaySeconds;
              const inCycleSeconds = afterDelaySeconds % cycleWallSeconds;
              if (inCycleSeconds < playWallSeconds) {
                seekAndPlayNow(inCycleSeconds * effectiveRate);
              } else {
                scheduleAfterSeconds(cycleWallSeconds - inCycleSeconds);
              }
            } else {
              seekAndPlayNow(0);
            }
          }
        }
      }
      const destination = this.audio.getOutputDestinationNode() ?? audioCtx.destination;
      if (this.audio.supportsStereoPanner()) {
        panner = audioCtx.createStereoPanner();
        gain.connect(panner).connect(destination);
      } else {
        gain.connect(destination);
      }
      this.outputs.set(item.id, {
        soundUrl,
        element,
        onEnded,
        source,
        effectInput,
        effectRuntime,
        effect,
        effectValue,
        initialDelaySeconds,
        loopDelaySeconds,
        gain,
        panner,
      });
      if (!matchingResumeState && !this.nextEmitStartAtMs.has(item.id) && initialDelaySeconds > 0) {
        this.nextEmitStartAtMs.set(item.id, Date.now() + initialDelaySeconds * 1000);
      }
      this.resumeStateByItemId.delete(item.id);
      this.tryStartEmitPlayback(item.id, element);
    }

    for (const itemId of Array.from(this.outputs.keys())) {
      if (!validIds.has(itemId)) {
        this.cleanup(itemId);
      }
    }

    for (const itemId of Array.from(this.nextEmitStartAtMs.keys())) {
      if (!seenItemIds.has(itemId)) {
        this.nextEmitStartAtMs.delete(itemId);
      }
    }
    for (const itemId of Array.from(this.resumeStateByItemId.keys())) {
      if (!seenItemIds.has(itemId)) {
        this.resumeStateByItemId.delete(itemId);
      }
    }
  }

  updateSpatialAudio(items: Map<string, WorldItem>, playerPosition: { x: number; y: number }): void {
    if (!this.layerEnabled) return;
    const audioCtx = this.audio.context;
    if (!audioCtx) return;

    for (const [itemId, output] of this.outputs.entries()) {
      const item = items.get(itemId);
      if (!item) {
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
      output.initialDelaySeconds = resolveEmitInitialDelaySeconds(item);
      const nextLoopDelaySeconds = resolveEmitLoopDelaySeconds(item);
      output.loopDelaySeconds = nextLoopDelaySeconds;
      const shouldLoop = nextLoopDelaySeconds <= 0;
      if (output.element.loop !== shouldLoop) {
        output.element.loop = shouldLoop;
        if (shouldLoop) {
          // Returning to native loop mode should clear delayed restart scheduling.
          this.nextEmitStartAtMs.delete(itemId);
          this.tryStartEmitPlayback(itemId, output.element);
        }
      }
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
      const emitVolume = volumePercentToGain(item.params.emitVolume, 100);
      const scaledMix = mix ? { ...mix, gain: mix.gain * emitVolume } : null;
      applySpatialMixToNodes({
        audioCtx,
        gainNode: output.gain,
        pannerNode: output.panner,
        mix: scaledMix,
        outputMode: this.audio.getOutputMode(),
        transition: 'target',
      });
      this.tryStartEmitPlayback(itemId, output.element);
    }
  }

  private shouldKeepRuntime(
    item: WorldItem,
    listenerPositions: Array<{ x: number; y: number }>,
    currentlyActive: boolean,
  ): boolean {
    if (listenerPositions.length === 0) return false;
    const spatialConfig = this.getSpatialConfig(item);
    const baseRange = Math.max(1, spatialConfig.range || HEARING_RADIUS);
    const threshold = baseRange + (currentlyActive ? UNSUBSCRIBE_HYSTERESIS_SQUARES : SUBSCRIBE_PRELOAD_SQUARES);
    return listenerPositions.some((listenerPosition) =>
      Math.hypot(item.x - listenerPosition.x, item.y - listenerPosition.y) <= threshold,
    );
  }

  private tryStartEmitPlayback(itemId: string, element: HTMLAudioElement): void {
    if (!element.paused) {
      this.nextEmitStartAtMs.delete(itemId);
      return;
    }
    if (this.pendingEmitStarts.has(itemId)) {
      return;
    }
    const now = Date.now();
    const retryAt = this.nextEmitStartAtMs.get(itemId) ?? 0;
    if (now < retryAt) {
      return;
    }
    this.pendingEmitStarts.add(itemId);
    if (element.error) {
      try {
        element.load();
      } catch {
        // Ignore stale media reload failures.
      }
    }
    if (element.ended || (Number.isFinite(element.duration) && element.duration > 0 && element.currentTime >= element.duration - 0.01)) {
      try {
        element.currentTime = 0;
      } catch {
        // Ignore reset failures for streams/seeking-restricted media.
      }
    }
    void element
      .play()
      .then(() => {
        this.nextEmitStartAtMs.delete(itemId);
        this.emitStartFailureCount.delete(itemId);
      })
      .catch(() => {
        const failures = (this.emitStartFailureCount.get(itemId) ?? 0) + 1;
        if (failures >= STREAM_PLAY_MAX_RETRIES) {
          this.emitStartFailureCount.set(itemId, 0);
          this.nextEmitStartAtMs.set(itemId, Date.now() + STREAM_PLAY_RESET_COOLDOWN_MS);
          return;
        }
        this.emitStartFailureCount.set(itemId, failures);
        this.nextEmitStartAtMs.set(itemId, Date.now() + STREAM_PLAY_RETRY_MS);
      })
      .finally(() => {
        this.pendingEmitStarts.delete(itemId);
      });
  }
}
