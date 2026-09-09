import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, type SpatialPeerRuntime } from './audioEngine';
import { createSpatialPanner, resolveSpatialMix, updateSpatialPanner } from './spatial';

class FakeAudioContext {
  state = 'running';
  destination = {};
  currentTime = 0;
  listener = {
    forwardX: { setTargetAtTime: vi.fn() },
    forwardY: { setTargetAtTime: vi.fn() },
    forwardZ: { setTargetAtTime: vi.fn() },
    upX: { value: 0 }, upY: { value: 1 }, upZ: { value: 0 },
  };
  createPanner() {
    const param = () => ({ value: 0, setTargetAtTime: vi.fn(function (this: { value: number }, value: number) { this.value = value; }) });
    return { context: this, positionX: param(), positionY: param(), positionZ: param() };
  }
  setSinkId = vi.fn(async (_id: string) => undefined);
  createGain() {
    const param = () => ({
      value: 1,
      setTargetAtTime: vi.fn(function (this: { value: number }, value: number) { this.value = value; }),
      setValueAtTime: vi.fn(function (this: { value: number }, value: number) { this.value = value; }),
      cancelScheduledValues: vi.fn(),
      linearRampToValueAtTime: vi.fn(function (this: { value: number }, value: number) { this.value = value; }),
    });
    return { gain: param(), connect: vi.fn() };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('AudioEngine output device', () => {
  it('routes an existing context to the selected device and back to default', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audio = new AudioEngine();
    await audio.ensureContext();
    const context = audio.context as unknown as FakeAudioContext;

    await audio.setOutputDevice('speakers');
    expect(context.setSinkId).toHaveBeenLastCalledWith('speakers');
    await audio.setOutputDevice('');
    expect(context.setSinkId).toHaveBeenLastCalledWith('');
  });

  it('keeps UI output outside the shared world transition gain', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audio = new AudioEngine();
    await audio.ensureContext();

    const worldOutput = audio.getOutputDestinationNode() as unknown as {
      gain: {
        value: number;
        cancelScheduledValues: ReturnType<typeof vi.fn>;
        linearRampToValueAtTime: ReturnType<typeof vi.fn>;
      };
    };
    const uiOutput = audio.getUiOutputDestinationNode();
    audio.setWorldTransitionGain(0, 500);

    expect(worldOutput).not.toBe(uiOutput);
    expect(worldOutput.gain.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(worldOutput.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.5);
    expect(worldOutput.gain.value).toBe(0);
  });

  it.each(['headset', ''])('stores selection %j without creating a context, then applies it on creation', async (deviceId) => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audio = new AudioEngine();
    await audio.setOutputDevice('old-speakers');
    await audio.setOutputDevice(deviceId);
    expect(audio.context).toBeNull();

    await audio.ensureContext();
    const context = audio.context as unknown as FakeAudioContext;
    expect(context.setSinkId).toHaveBeenCalledWith(deviceId);
    await audio.ensureContext();
    expect(context.setSinkId).toHaveBeenCalledTimes(1);
  });

  it('keeps context setup usable if a saved speaker is unavailable', async () => {
    class UnavailableSinkAudioContext extends FakeAudioContext {
      setSinkId = vi.fn(async (_id: string) => { throw new Error('Device unavailable'); });
    }
    vi.stubGlobal('window', { AudioContext: UnavailableSinkAudioContext });
    const audio = new AudioEngine();
    await audio.setOutputDevice('unplugged-speakers');
    await expect(audio.ensureContext()).resolves.toBeUndefined();
    expect(audio.getOutputDestinationNode()).not.toBeNull();
  });

  it('works without browser support for context sink selection', async () => {
    class UnsupportedAudioContext {
      state = 'running';
      destination = {};
      createGain = FakeAudioContext.prototype.createGain;
    }
    vi.stubGlobal('window', { AudioContext: UnsupportedAudioContext });
    const audio = new AudioEngine();
    await audio.setOutputDevice('headset');
    await expect(audio.ensureContext()).resolves.toBeUndefined();
    await expect(audio.setOutputDevice('')).resolves.toBeUndefined();
  });
});

describe('AudioEngine spatial preferences', () => {
  it('remembers standard-mode turns without rotating audio, then applies them in HRTF', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audio = new AudioEngine();
    await audio.ensureContext();
    const context = audio.context as unknown as FakeAudioContext;
    const panner = createSpatialPanner(audio.context!);
    updateSpatialPanner(panner, resolveSpatialMix({ dx: 5, dy: 0, range: 15 }));

    audio.setListenerFacing(90);
    expect(panner.positionX.value).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(panner.positionZ.value).toBeCloseTo(-Math.cos(Math.PI / 4));
    audio.setSpatialMode('hrtf');
    expect(panner.positionX.value).toBeCloseTo(0);
    expect(panner.positionZ.value).toBeCloseTo(-5);
    audio.setSpatialMode('standard');
    expect(panner.positionX.value).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(panner.positionZ.value).toBeCloseTo(-Math.cos(Math.PI / 4));
    audio.setListenerFacing(225);
    expect(panner.positionX.value).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(panner.positionZ.value).toBeCloseTo(-Math.cos(Math.PI / 4));
    audio.setSpatialMode('hrtf');
    expect(panner.positionX.value).toBeCloseTo(-5 / Math.sqrt(2));
    expect(panner.positionZ.value).toBeCloseTo(5 / Math.sqrt(2));
    expect(context.listener.forwardX.setTargetAtTime).not.toHaveBeenCalled();
  });

  it('loads saved HRTF and keeps accepting facing changes with a method-only listener', async () => {
    const setOrientation = vi.fn();
    class MethodOnlyAudioContext extends FakeAudioContext {
      constructor() {
        super();
        Object.defineProperty(this, 'listener', { value: { setOrientation } });
      }
    }
    vi.stubGlobal('window', { AudioContext: MethodOnlyAudioContext });
    const audio = new AudioEngine();
    audio.setSpatialMode('hrtf');
    await expect(audio.ensureContext()).resolves.toBeUndefined();
    expect(audio.getOutputDestinationNode()).not.toBeNull();

    for (const heading of [90, 180, 270, 0, 45]) {
      expect(() => audio.setListenerFacing(heading)).not.toThrow();
    }
    expect(() => audio.setSpatialMode('standard')).not.toThrow();
    expect(() => audio.setSpatialMode('hrtf')).not.toThrow();
    expect(audio.getSpatialMode()).toBe('hrtf');
    expect(setOrientation).not.toHaveBeenCalled();
  });

  it('applies settings chosen before context creation and retains HRTF through mono', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audio = new AudioEngine();
    audio.setSpatialMode('hrtf');
    audio.setListenerFacing(90);
    audio.setOutputMode('mono');
    expect(audio.context).toBeNull();
    await audio.ensureContext();
    const context = audio.context as unknown as FakeAudioContext;
    expect(context.listener.forwardX.setTargetAtTime).not.toHaveBeenCalled();
    expect(audio.toggleOutputMode()).toBe('stereo');
    expect(audio.getSpatialMode()).toBe('hrtf');
  });

  it('keeps wall gain and filtering consistent across standard and HRTF voice updates', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audio = new AudioEngine();
    await audio.ensureContext();

    const gainTarget = vi.fn(function (this: { value: number }, value: number) {
      this.value = value;
    });
    const filterTarget = vi.fn(function (this: { value: number }, value: number) {
      this.value = value;
    });
    const peer = {
      nickname: 'behind-wall',
      x: 4,
      y: 0,
      z: 0,
      acousticGain: 0.35,
      occlusionLowpassHz: 900,
      gain: { gain: { value: 1, setTargetAtTime: gainTarget } },
      occlusionFilter: { frequency: { value: 20_000, setTargetAtTime: filterTarget } },
      panner: createSpatialPanner(audio.context!),
    } as unknown as SpatialPeerRuntime;
    const listener = { x: 0, y: 0, z: 0 };

    audio.setSpatialMode('standard');
    audio.setListenerFacing(90);
    audio.updateSpatialAudio([peer], listener);
    const standardGain = gainTarget.mock.calls[gainTarget.mock.calls.length - 1]?.[0];
    const standardFilter = filterTarget.mock.calls[filterTarget.mock.calls.length - 1]?.[0];
    expect(standardGain).toBeGreaterThan(0);
    expect(standardFilter).toBe(900);
    expect(peer.panner?.panningModel).toBe('equalpower');
    expect(peer.panner?.positionX.value).toBeCloseTo(Math.sin(Math.sin(Math.PI / 10) * Math.PI / 2));
    expect(peer.panner?.positionY.value).toBe(0);
    expect(peer.panner?.positionZ.value).toBeCloseTo(-Math.cos(Math.sin(Math.PI / 10) * Math.PI / 2));

    audio.setSpatialMode('hrtf');
    audio.setListenerFacing(90);
    audio.updateSpatialAudio([peer], listener);
    expect(gainTarget.mock.calls[gainTarget.mock.calls.length - 1]?.[0]).toBeCloseTo(standardGain as number);
    expect(filterTarget.mock.calls[filterTarget.mock.calls.length - 1]?.[0]).toBe(standardFilter);
    expect(peer.panner?.panningModel).toBe('HRTF');
    expect(peer.panner?.positionX.value).toBeCloseTo(0);
    expect(peer.panner?.positionZ.value).toBeCloseTo(-4);

    peer.acousticGain = 0;
    peer.occlusionLowpassHz = 120;
    audio.updateSpatialAudio([peer], listener);
    expect(gainTarget.mock.calls[gainTarget.mock.calls.length - 1]?.[0]).toBe(0);
    expect(filterTarget.mock.calls[filterTarget.mock.calls.length - 1]?.[0]).toBe(120);

    audio.setSpatialMode('standard');
    audio.updateSpatialAudio([peer], listener);
    expect(gainTarget.mock.calls[gainTarget.mock.calls.length - 1]?.[0]).toBe(0);
    expect(filterTarget.mock.calls[filterTarget.mock.calls.length - 1]?.[0]).toBe(120);
    expect(peer.panner?.positionX.value).toBe(0);
    expect(peer.panner?.positionY.value).toBe(0);
    expect(peer.panner?.positionZ.value).toBe(-1);
  });
});
