import { describe, expect, it, vi } from 'vitest';
import { configureSpatialAudio } from './spatial';
import type { WorldItem } from '../state/gameState';
import { isItemEmitPlaybackEligible, ItemEmitRuntime, resolveItemEmitSound } from './itemEmitRuntime';

function param(value = 0) {
  return {
    value,
    setTargetAtTime: vi.fn(function (this: { value: number }, next: number) { this.value = next; }),
    setValueAtTime: vi.fn(function (this: { value: number }, next: number) { this.value = next; }),
    cancelScheduledValues: vi.fn(),
    linearRampToValueAtTime: vi.fn(function (this: { value: number }, next: number) { this.value = next; }),
  };
}

function node<T extends object>(extra: T): T & { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } {
  const result = {
    ...extra,
    connect: vi.fn(() => result),
    disconnect: vi.fn(),
  } as T & { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  return result;
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};

  createGain() {
    return node({ gain: param(1) });
  }

  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: param(20_000), Q: param(0.7) });
  }

  createPanner() {
    return node({
      context: this,
      positionX: param(),
      positionY: param(),
      positionZ: param(),
    });
  }

  createMediaElementSource(element: HTMLAudioElement) {
    return node({ context: this, element });
  }
}

function makeAudio(context: FakeAudioContext) {
  return {
    context,
    ensureContext: vi.fn(async () => undefined),
    getOutputDestinationNode: vi.fn(() => context.destination),
  } as never;
}

function installMedia(): { media: Array<{ pause: ReturnType<typeof vi.fn> }>; restore: () => void } {
  const media: Array<{ pause: ReturnType<typeof vi.fn> }> = [];
  const originalAudio = globalThis.Audio;
  vi.stubGlobal('Audio', vi.fn((url: string) => {
    const element = {
      src: url,
      loop: false,
      preload: 'none',
      crossOrigin: 'anonymous',
      paused: true,
      currentTime: 0,
      duration: Number.NaN,
      playbackRate: 1,
      play: vi.fn(() => {
        element.paused = false;
        return Promise.resolve();
      }),
      pause: vi.fn(() => { element.paused = true; }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      load: vi.fn(),
    };
    media.push(element);
    return element;
  }));
  return { media, restore: () => vi.stubGlobal('Audio', originalAudio) };
}

function item(type: string, params: Record<string, unknown> = {}, emitSound?: string): WorldItem {
  return {
    id: `${type}-1`,
    type,
    title: type,
    x: 1,
    y: 1,
    z: 0,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: [],
    emitSound,
    params,
    occupiedOffsets: [{ x: 0, y: 0 }],
  };
}

describe('generic item emit playback eligibility', () => {
  it('does not overlay radio items, including malformed persisted emit params', () => {
    const radio = item('radio_station', { emitSound: 'sounds/legacy.ogg' }, 'sounds/legacy.ogg');
    expect(isItemEmitPlaybackEligible(radio)).toBe(false);
  });

  it('accepts ordinary emitting items only when they have an enabled sound', () => {
    expect(isItemEmitPlaybackEligible(item('widget', { emitSound: '' }))).toBe(false);
    expect(isItemEmitPlaybackEligible(item('widget', { emitSound: 'off' }))).toBe(false);
    expect(isItemEmitPlaybackEligible(item('widget', { emitSound: 'sounds/beacon.ogg' }))).toBe(true);
    expect(isItemEmitPlaybackEligible(item('widget', { enabled: false, emitSound: 'sounds/beacon.ogg' }))).toBe(false);
  });

  it('uses the instance sound before the legacy global item sound field', () => {
    expect(resolveItemEmitSound(item('clock', {}, 'sounds/clock.ogg'))).toBe('sounds/clock.ogg');
    expect(resolveItemEmitSound(item('clock', { emitSound: '' }, 'sounds/clock.ogg'))).toBe('');
  });

  it('does not create radio overlays and fully clears disabled emitter schedules', async () => {
    const context = new FakeAudioContext();
    const audio = makeAudio(context);
    const mediaInstall = installMedia();
    try {
      const runtime = new ItemEmitRuntime(
        audio,
        (soundPath) => `/assets/${soundPath}`,
        () => ({ range: 15, directional: false, facingDeg: 0 }),
      );
      const radio = item('radio_station', { emitSound: 'sounds/legacy.ogg' }, 'sounds/legacy.ogg');
      await runtime.sync([radio], { x: 1, y: 1, z: 0 });
      expect(mediaInstall.media).toHaveLength(0);

      const emitting = item('widget', { emitSound: 'sounds/beacon.ogg', emitInitialDelay: 5 });
      await runtime.sync([emitting], { x: 1, y: 1, z: 0 });
      expect(mediaInstall.media).toHaveLength(1);
      expect((runtime as unknown as { nextEmitStartAtMs: Map<string, number> }).nextEmitStartAtMs.has(emitting.id)).toBe(true);

      await runtime.sync([{ ...emitting, params: { ...emitting.params, enabled: false } }], { x: 1, y: 1, z: 0 });
      expect(mediaInstall.media[0].pause).toHaveBeenCalledOnce();
      expect((runtime as unknown as { nextEmitStartAtMs: Map<string, number> }).nextEmitStartAtMs.has(emitting.id)).toBe(false);
      expect((runtime as unknown as { resumeStateByItemId: Map<string, unknown> }).resumeStateByItemId.has(emitting.id)).toBe(false);
    } finally {
      mediaInstall.restore();
    }
  });
});


describe('emitted sound directionality', () => {
  it.each(['standard', 'hrtf'] as const)('applies source facing and toggles live in %s mode', async (mode) => {
    const context = new FakeAudioContext();
    const mediaInstall = installMedia();
    const config = { range: 10, directional: true, facingDeg: 0 };
    const runtime = new ItemEmitRuntime(makeAudio(context), path => path, () => config);
    try {
      configureSpatialAudio(context as unknown as AudioContext, mode, 'stereo', 0);
      const emitting = item('teleporter', { emitSound: '/sounds/whirr.ogg', emitVolume: 100 });
      const items = new Map([[emitting.id, emitting]]);
      await runtime.sync([emitting], { x: 1, y: 4, z: 0 });
      const output = (runtime as unknown as { outputs: Map<string, { gain: { gain: { value: number } } }> }).outputs.get(emitting.id)!;
      const gainAt = (x: number, y: number) => {
        runtime.updateSpatialAudio(items, { x, y, z: 0 });
        return output.gain.gain.value;
      };
      const front = gainAt(1, 4);
      const side = gainAt(4, 1);
      const rear = gainAt(1, -2);
      expect(front).toBeGreaterThan(side);
      expect(side).toBeGreaterThan(rear);
      expect(rear).toBeGreaterThan(0);
      expect(gainAt(1, -4)).toBe(0);
      config.facingDeg = 180;
      expect(gainAt(1, -2)).toBeCloseTo(front);
      expect(gainAt(1, 4)).toBeCloseTo(rear);
      configureSpatialAudio(context as unknown as AudioContext, mode, 'stereo', 90);
      expect(gainAt(1, 4)).toBeCloseTo(rear);
      config.directional = false;
      expect(gainAt(1, 4)).toBeCloseTo(front);
      expect(gainAt(1, -2)).toBeCloseTo(front);
      expect(gainAt(4, 1)).toBeCloseTo(front);
    } finally {
      mediaInstall.restore();
    }
  });
});
