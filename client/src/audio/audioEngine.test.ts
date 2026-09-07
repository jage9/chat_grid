import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './audioEngine';

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
  setSinkId = vi.fn(async (_id: string) => undefined);
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn() };
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
  it('applies settings chosen before context creation and retains HRTF through mono', async () => {
    vi.stubGlobal('window', { AudioContext: FakeAudioContext });
    const audio = new AudioEngine();
    audio.setSpatialMode('hrtf');
    audio.setListenerFacing(90);
    audio.setOutputMode('mono');
    expect(audio.context).toBeNull();
    await audio.ensureContext();
    const context = audio.context as unknown as FakeAudioContext;
    expect(context.listener.forwardX.setTargetAtTime).toHaveBeenCalledWith(1, 0, expect.any(Number));
    expect(audio.toggleOutputMode()).toBe('stereo');
    expect(audio.getSpatialMode()).toBe('hrtf');
  });
});
