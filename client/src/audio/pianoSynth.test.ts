import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PianoSynth } from './pianoSynth';

const spatial = vi.hoisted(() => ({
  applySpatialMixToNodes: vi.fn(),
  createSpatialPanner: vi.fn(),
  disconnectSpatialPanner: vi.fn(),
  resolveSpatialMix: vi.fn((options: { dx: number; dy: number; dz?: number; range: number; baseGain?: number }) => ({
    dx: options.dx,
    dy: options.dy,
    dz: options.dz ?? 0,
    distance: Math.hypot(options.dx, options.dy, options.dz ?? 0),
    gain: options.baseGain ?? 1,
  })),
  updateSpatialPanner: vi.fn(),
}));

vi.mock('./spatial', () => spatial);

type FakeParam = {
  value: number;
  setValueAtTime: (value: number) => void;
  exponentialRampToValueAtTime: (value: number) => void;
  linearRampToValueAtTime: (value: number) => void;
  setTargetAtTime: (value: number) => void;
  cancelScheduledValues: () => void;
};

function param(value = 0): FakeParam {
  return {
    value,
    setValueAtTime(next) { this.value = next; },
    exponentialRampToValueAtTime(next) { this.value = next; },
    linearRampToValueAtTime(next) { this.value = next; },
    setTargetAtTime(next) { this.value = next; },
    cancelScheduledValues() {},
  };
}

function createContext(): AudioContext {
  const context = {
    currentTime: 0,
    destination: {},
    createGain: () => {
      const node = {
        context,
        gain: param(),
        connect: (target: unknown) => target,
        disconnect: vi.fn(),
      };
      return node;
    },
    createBiquadFilter: () => ({
      context,
      type: 'lowpass',
      frequency: param(),
      Q: param(),
      connect: (target: unknown) => target,
      disconnect: vi.fn(),
    }),
    createOscillator: () => ({
      context,
      type: 'sine',
      frequency: param(),
      detune: param(),
      connect: (target: unknown) => target,
      start: vi.fn(),
      stop: vi.fn(),
    }),
    createBufferSource: () => ({
      context,
      buffer: null,
      connect: (target: unknown) => target,
      start: vi.fn(),
      stop: vi.fn(),
    }),
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
    sampleRate: 48_000,
  } as unknown as AudioContext;
  return context;
}

function spatialSource() {
  let source = { x: 1, y: 2, z: 0, acousticZoneId: 'floor:0' };
  const value = {
    x: 1,
    y: 2,
    z: 0,
    range: 20,
    getPosition: () => source,
  };
  return {
    value,
    move(next: typeof source) { source = next; },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  spatial.createSpatialPanner.mockImplementation((context: AudioContext) => ({
    context,
    connect: (target: unknown) => target,
  }));
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PianoSynth spatial voices', () => {
  it('updates a sustained note separately from its envelope as the source moves', () => {
    const context = createContext();
    const source = spatialSource();
    const synth = new PianoSynth();
    synth.noteOn(
      'key',
      'group',
      60,
      'piano',
      'poly',
      10,
      40,
      30,
      50,
      { audioCtx: context, destination: context.destination },
      source.value,
    );
    const listener = { x: 0, y: 0, z: 0, acousticZoneId: 'floor:0' };
    const resolveTransmission = vi.fn(() => ({ gain: 0.4, lowpassHz: 900 }));

    source.move({ x: 6, y: 2, z: 4, acousticZoneId: 'floor:40' });
    synth.updateSpatialAudio(listener, resolveTransmission);

    expect(resolveTransmission).toHaveBeenCalledWith(source.value.getPosition(), listener);
    expect(spatial.resolveSpatialMix).toHaveBeenLastCalledWith(expect.objectContaining({ dx: 6, dy: 2, dz: 4, baseGain: 0.4 }));
    expect(spatial.applySpatialMixToNodes).toHaveBeenLastCalledWith(expect.objectContaining({
      gainNode: expect.anything(),
      mix: expect.objectContaining({ dx: 6, dy: 2, dz: 4, gain: 0.4 }),
    }));

    synth.noteOff('key');
    source.move({ x: 8, y: 2, z: 4, acousticZoneId: 'floor:40' });
    synth.updateSpatialAudio(listener, resolveTransmission);
    expect(spatial.resolveSpatialMix).toHaveBeenLastCalledWith(expect.objectContaining({ dx: 8, dy: 2, dz: 4 }));
  });

  it('tracks short drum tails with the shared spatial panner until cleanup', () => {
    const context = createContext();
    const synth = new PianoSynth();
    synth.noteOn(
      'drum',
      'group',
      60,
      'drum_kit',
      'poly',
      1,
      22,
      12,
      68,
      { audioCtx: context, destination: context.destination },
      { x: 1, y: 0, z: 0, range: 20 },
    );

    synth.updateSpatialAudio({ x: 0, y: 0, z: 0, acousticZoneId: 'floor:0' });
    expect(spatial.applySpatialMixToNodes).toHaveBeenCalled();
    expect(spatial.disconnectSpatialPanner).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(spatial.disconnectSpatialPanner).toHaveBeenCalledTimes(1);
  });
});
