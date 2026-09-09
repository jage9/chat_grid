import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine, SpatialAudioPosition } from './audioEngine';
import {
  AmbianceRuntime,
  getAmbianceNearestPoint,
  resolveAmbianceSpatialResolution,
} from './ambianceRuntime';
import type { AmbianceRegion } from '../state/gameState';

type FakeParam = {
  value: number;
  setTargetAtTime: ReturnType<typeof vi.fn>;
};

function param(value = 0): FakeParam {
  return {
    value,
    setTargetAtTime: vi.fn(function (this: FakeParam, next: number) {
      this.value = next;
    }),
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
  readonly gains: Array<ReturnType<typeof node>> = [];
  readonly panners: Array<ReturnType<typeof node>> = [];
  readonly sources: Array<ReturnType<typeof node>> = [];
  createGain() {
    const gain = node({ gain: param(1) });
    this.gains.push(gain);
    return gain;
  }
  createBiquadFilter() {
    return node({ type: 'lowpass', frequency: param(20_000) });
  }
  createPanner() {
    const panner = node({
      context: this,
      positionX: param(),
      positionY: param(),
      positionZ: param(),
    });
    this.panners.push(panner);
    return panner;
  }
  createMediaElementSource(element: HTMLAudioElement) {
    return node({ context: this, element });
  }
  decodeAudioData = vi.fn(async () => ({} as AudioBuffer));
  createBufferSource() {
    const source = node({
      buffer: null,
      loop: false,
      start: vi.fn(),
      stop: vi.fn(),
    });
    this.sources.push(source);
    return source;
  }
}

type FakeMedia = {
  src: string;
  loop: boolean;
  preload: string;
  crossOrigin: string;
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
};

function installMedia(): { media: FakeMedia[]; restore: () => void } {
  const media: FakeMedia[] = [];
  const OriginalAudio = globalThis.Audio;
  vi.stubGlobal('Audio', vi.fn((url: string) => {
    const element: FakeMedia = {
      src: url,
      loop: false,
      preload: '',
      crossOrigin: '',
      paused: true,
      play: vi.fn(() => {
        element.paused = false;
        return Promise.resolve();
      }),
      pause: vi.fn(() => { element.paused = true; }),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    media.push(element);
    return element;
  }));
  return { media, restore: () => vi.stubGlobal('Audio', OriginalAudio) };
}

function region(overrides: Partial<AmbianceRegion> = {}): AmbianceRegion {
  return {
    id: 'region-a',
    name: 'Water',
    soundId: 'water',
    floorZ: 0,
    startX: 2,
    startY: 2,
    endX: 4,
    endY: 4,
    volume: 50,
    fadeDistance: 4,
    ...overrides,
  };
}

function listener(overrides: Partial<SpatialAudioPosition> = {}): SpatialAudioPosition {
  return { x: 3, y: 3, z: 0, acousticZoneId: 'floor:0', ...overrides };
}

function makeAudio(context: FakeAudioContext): AudioEngine {
  return {
    context,
    ensureContext: vi.fn(async () => undefined),
    getOutputDestinationNode: vi.fn(() => context.destination),
  } as unknown as AudioEngine;
}

afterEach(() => vi.unstubAllGlobals());

describe('ambiance rectangle geometry', () => {
  it('treats every inclusive edge cell as inside and centered', () => {
    const item = region();
    const resolved = resolveAmbianceSpatialResolution(item, listener({ x: 4, y: 2 }))!;

    expect(resolved.inside).toBe(true);
    expect(resolved.distance).toBe(0);
    expect(resolved.falloff).toBe(1);
    expect(resolved.volume).toBe(0.5);
    expect(resolved.source).toMatchObject({ x: 4, y: 2, z: 0, acousticZoneId: 'floor:0' });
  });

  it('uses the nearest rectangle point for linear fade and direction', () => {
    const item = region({ startX: 10, startY: 10, endX: 14, endY: 14, fadeDistance: 4 });
    const resolved = resolveAmbianceSpatialResolution(item, listener({ x: 8, y: 12 }))!;

    expect(getAmbianceNearestPoint(item, listener({ x: 8, y: 12 }))).toEqual({ x: 10, y: 12 });
    expect(resolved.distance).toBe(2);
    expect(resolved.falloff).toBe(0.5);
    expect(resolved.source.x).toBe(10);
    expect(resolved.source.y).toBe(12);
  });

  it('keeps zero fade distance full only inside the rectangle', () => {
    const item = region({ fadeDistance: 0 });
    expect(resolveAmbianceSpatialResolution(item, listener({ x: 3, y: 3 }))!.falloff).toBe(1);
    expect(resolveAmbianceSpatialResolution(item, listener({ x: 5, y: 3 }))!.falloff).toBe(0);
  });
});

describe('AmbianceRuntime', () => {
  it('allows overlapping regions, applies acoustic gain, and does not restart loops per frame', async () => {
    const context = new FakeAudioContext();
    const audio = makeAudio(context);
    const mediaInstall = installMedia();
    const acoustic = vi.fn(() => ({ gain: 0.4, lowpassHz: 900 }));
    const runtime = new AmbianceRuntime(audio, acoustic);
    runtime.setTypes([{ id: 'water', title: 'Water', url: '/sounds/water.ogg' }]);
    const first = region();
    const second = region({ id: 'region-b', startX: 3, startY: 3, endX: 5, endY: 5 });

    runtime.update([first, second], listener(), true);
    await Promise.resolve();
    await Promise.resolve();
    expect(mediaInstall.media).toHaveLength(1);
    expect(mediaInstall.media[0].play).toHaveBeenCalledOnce();
    expect(context.panners).toHaveLength(2);
    expect(context.gains.map((gain) => (gain as unknown as { gain: FakeParam }).gain.value)).toEqual([0.2, 0.2]);

    runtime.update([first, second], listener({ x: 6, y: 3 }), true);
    expect(mediaInstall.media[0].play).toHaveBeenCalledOnce();
    expect((context.gains[0] as unknown as { gain: FakeParam }).gain.value).toBeCloseTo(0.1);
    expect((context.panners[0] as unknown as { positionX: FakeParam }).positionX.value).toBeLessThan(0);
    expect(acoustic).toHaveBeenCalledWith(
      expect.objectContaining({ x: 4, y: 3, z: 0, acousticZoneId: 'floor:0' }),
      expect.objectContaining({ x: 6, y: 3, z: 0, acousticZoneId: 'floor:0' }),
    );
    runtime.cleanup();
  });

  it('stops and releases same-floor sources on a layer toggle or floor change', async () => {
    const context = new FakeAudioContext();
    const audio = makeAudio(context);
    const mediaInstall = installMedia();
    const runtime = new AmbianceRuntime(audio, () => ({ gain: 1, lowpassHz: 20_000 }));
    runtime.setTypes([{ id: 'water', title: 'Water', url: '/sounds/water.ogg' }]);
    runtime.update([region()], listener(), true);
    await Promise.resolve();
    await Promise.resolve();
    runtime.update([region()], listener({ z: 40, acousticZoneId: 'floor:40' }), true);
    expect(mediaInstall.media[0].pause).toHaveBeenCalledOnce();
    expect(context.panners[0].disconnect).toHaveBeenCalledOnce();

    runtime.update([region()], listener(), true);
    await Promise.resolve();
    await Promise.resolve();
    expect(mediaInstall.media).toHaveLength(2);
    runtime.update([region()], listener(), false);
    expect(mediaInstall.media[1].pause).toHaveBeenCalledOnce();
  });

  it('invalidates a late play promise after cleanup, and the instance can reconnect', async () => {
    const context = new FakeAudioContext();
    const audio = makeAudio(context);
    const mediaInstall = installMedia();
    let resolvePlay: (() => void) | null = null;
    mediaInstall.media.length = 0;
    mediaInstall.restore();
    vi.stubGlobal('Audio', vi.fn((url: string) => {
      const element = {
        src: url,
        loop: false,
        preload: '',
        crossOrigin: '',
        paused: true,
        play: vi.fn(() => new Promise<void>((resolve) => {
          resolvePlay = () => {
            element.paused = false;
            resolve();
          };
        })),
        pause: vi.fn(),
        removeAttribute: vi.fn(),
        load: vi.fn(),
      } as unknown as FakeMedia;
      mediaInstall.media.push(element);
      return element;
    }));
    const runtime = new AmbianceRuntime(audio, () => ({ gain: 1, lowpassHz: 20_000 }));
    runtime.setTypes([{ id: 'water', title: 'Water', url: '/sounds/water.ogg' }]);
    runtime.update([region()], listener(), true);
    runtime.cleanup();
    (resolvePlay as (() => void) | null)?.();
    await Promise.resolve();
    expect(mediaInstall.media[0].pause).toHaveBeenCalledOnce();

    runtime.update([region()], listener(), true);
    await Promise.resolve();
    await Promise.resolve();
    expect(mediaInstall.media).toHaveLength(2);
    expect(mediaInstall.media[1].play).toHaveBeenCalledOnce();
  });

  it('bounds repeated media play failures instead of retrying every frame', async () => {
    const context = new FakeAudioContext();
    const audio = makeAudio(context);
    const mediaInstall = installMedia();
    mediaInstall.restore();
    const play = vi.fn(() => Promise.reject(new Error('blocked')));
    vi.stubGlobal('Audio', vi.fn((url: string) => ({
      src: url,
      loop: false,
      preload: '',
      crossOrigin: '',
      paused: true,
      play,
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    })));
    const runtime = new AmbianceRuntime(audio, () => ({ gain: 1, lowpassHz: 20_000 }));
    runtime.setTypes([{ id: 'water', title: 'Water', url: '/sounds/water.ogg' }]);
    runtime.update([region()], listener(), true);
    await Promise.resolve();
    await Promise.resolve();
    for (let index = 0; index < 20; index += 1) runtime.update([region()], listener(), true);
    expect(play).toHaveBeenCalledOnce();
    runtime.cleanup();
  });
});
