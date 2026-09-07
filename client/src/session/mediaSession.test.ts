// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../audio/audioEngine';
import { SettingsStore } from '../settings/settingsStore';
import { createInitialState } from '../state/gameState';
import { PeerManager } from '../webrtc/peerManager';
import { MediaSession } from './mediaSession';

function capture() {
  const track = Object.assign(new EventTarget(), {
    enabled: true,
    // Also simulate a queued ended event during intentional replacement.
    stop: vi.fn(() => track.dispatchEvent(new Event('ended'))),
  });
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

function setup() {
  const first = capture();
  const replacement = capture();
  const mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn(async (_constraints: MediaStreamConstraints) => replacement.stream)
      .mockResolvedValueOnce(first.stream),
    enumerateDevices: vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Default microphone' },
      { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
    ]),
  });
  vi.stubGlobal('navigator', { mediaDevices });
  const state = createInitialState();
  state.running = true;
  const audio = new AudioEngine();
  vi.spyOn(audio, 'ensureContext').mockResolvedValue();
  vi.spyOn(audio, 'configureOutboundStream').mockImplementation(async (stream) => stream);
  const setOutputDevice = vi.spyOn(audio, 'setOutputDevice').mockResolvedValue();
  const updateStatus = vi.fn();
  const peerManager = new PeerManager(audio, updateStatus, {
    isSessionRunning: () => state.running,
    requestToken: vi.fn(),
  });
  const replaceOutgoingTrack = vi.spyOn(peerManager, 'replaceOutgoingTrack').mockResolvedValue();
  const dom = {
    settingsModal: document.createElement('div'),
    audioInputSelect: document.createElement('select'),
    audioOutputSelect: document.createElement('select'),
    audioInputCurrent: document.createElement('p'),
    audioOutputCurrent: document.createElement('p'),
  };
  dom.settingsModal.classList.add('hidden');
  const settings = new SettingsStore();
  let microphoneEnabled = true;
  const session = new MediaSession({
    state, audio, peerManager, settings, dom, updateStatus,
    isVoiceSendAllowed: () => microphoneEnabled,
    micCalibrationDurationMs: 5000,
    micCalibrationSampleIntervalMs: 50,
    micCalibrationMinGain: 0.1,
    micCalibrationMaxGain: 10,
    micCalibrationTargetRms: 0.1,
    micCalibrationActiveRmsThreshold: 0.01,
    micInputGainScaleMultiplier: 1,
    micInputGainStep: 0.1,
  });
  return {
    session,
    state,
    first,
    replacement,
    mediaDevices,
    replaceOutgoingTrack,
    updateStatus,
    dom,
    setOutputDevice,
    setVoiceSendAllowed: (enabled: boolean) => {
      microphoneEnabled = enabled;
    },
  };
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('microphone loss', () => {
  it('keeps fallback capture disabled when voice sending is not permitted', async () => {
    const test = setup();
    expect(test.state.isMuted).toBe(false);
    await test.session.setupLocalMedia('headset');

    test.setVoiceSendAllowed(false);
    test.first.track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(test.replaceOutgoingTrack).toHaveBeenCalledTimes(2));

    expect(test.replacement.track.enabled).toBe(false);
    expect(test.replaceOutgoingTrack).toHaveBeenLastCalledWith(test.replacement.stream);
  });

  it('recaptures the default microphone once, preserves mute, and publishes the replacement', async () => {
    const test = setup();
    test.state.isMuted = true;
    await test.session.setupLocalMedia('headset');

    test.first.track.dispatchEvent(new Event('ended'));
    test.first.track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(test.replaceOutgoingTrack).toHaveBeenCalledTimes(2));

    expect(test.updateStatus).toHaveBeenCalledWith('Microphone disconnected. Switching to default microphone.');
    expect(test.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(test.mediaDevices.getUserMedia).toHaveBeenLastCalledWith(expect.objectContaining({
      audio: expect.objectContaining({ deviceId: undefined }),
    }));
    expect(test.replacement.track.enabled).toBe(false);
    expect(test.replaceOutgoingTrack).toHaveBeenLastCalledWith(test.replacement.stream);
    expect(test.session.getOutboundStream()).toBe(test.replacement.stream);
  });

  it('does not recover when tracks are intentionally replaced or stopped', async () => {
    const test = setup();
    await test.session.setupLocalMedia('headset');
    await test.session.setupLocalMedia('another-microphone');
    test.session.stopLocalMedia();

    expect(test.updateStatus).not.toHaveBeenCalled();
    expect(test.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(test.session.getOutboundStream()).toBeNull();
  });

  it('does not recover outside a running session', async () => {
    const test = setup();
    await test.session.setupLocalMedia();
    test.state.running = false;
    test.first.track.dispatchEvent(new Event('ended'));

    expect(test.updateStatus).not.toHaveBeenCalled();
    expect(test.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('reports failed recovery without retrying the same disconnect', async () => {
    const test = setup();
    await test.session.setupLocalMedia('headset');
    test.mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('No microphone'));
    test.first.track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(test.updateStatus).toHaveBeenLastCalledWith(
      'Microphone unavailable. Check your input device.',
    ));
    test.first.track.dispatchEvent(new Event('ended'));

    expect(test.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(test.session.getOutboundStream()).toBeNull();
  });

  it('can recover again when the replacement microphone really disconnects', async () => {
    const test = setup();
    await test.session.setupLocalMedia();
    test.first.track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(test.replaceOutgoingTrack).toHaveBeenCalledTimes(2));
    const third = capture();
    test.mediaDevices.getUserMedia.mockResolvedValueOnce(third.stream);
    test.replacement.track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(test.replaceOutgoingTrack).toHaveBeenCalledTimes(3));
    expect(test.session.getOutboundStream()).toBe(third.stream);
  });

  it('discards fallback capture that resolves after local media has stopped', async () => {
    const test = setup();
    await test.session.setupLocalMedia();
    let finishCapture: (stream: MediaStream) => void = () => { throw new Error('Capture not requested'); };
    test.mediaDevices.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      finishCapture = resolve;
    }));
    test.first.track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(test.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));

    test.state.running = false;
    test.session.stopLocalMedia();
    finishCapture(test.replacement.stream);
    await vi.waitFor(() => expect(test.replacement.track.stop).toHaveBeenCalledTimes(1));
    expect(test.replaceOutgoingTrack).toHaveBeenCalledTimes(1);
    expect(test.session.getOutboundStream()).toBeNull();
  });

  it('keeps a manual device choice when an older fallback capture resolves later', async () => {
    const test = setup();
    await test.session.setupLocalMedia();
    let finishCapture: (stream: MediaStream) => void = () => { throw new Error('Capture not requested'); };
    test.mediaDevices.getUserMedia.mockImplementationOnce(() => new Promise((resolve) => {
      finishCapture = resolve;
    }));
    test.first.track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(test.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));

    const manual = capture();
    test.mediaDevices.getUserMedia.mockResolvedValueOnce(manual.stream);
    await test.session.setupLocalMedia('manual-choice');
    finishCapture(test.replacement.stream);
    await vi.waitFor(() => expect(test.replacement.track.stop).toHaveBeenCalledTimes(1));
    expect(test.replaceOutgoingTrack).toHaveBeenCalledTimes(2);
    expect(test.session.getOutboundStream()).toBe(manual.stream);
  });
});

describe('device preferences', () => {
  it('refreshes dropdowns on devicechange only while Settings is open and stops temporary capture', async () => {
    const test = setup();
    test.mediaDevices.dispatchEvent(new Event('devicechange'));
    expect(test.mediaDevices.getUserMedia).not.toHaveBeenCalled();

    test.dom.settingsModal.classList.remove('hidden');
    test.mediaDevices.dispatchEvent(new Event('devicechange'));
    await vi.waitFor(() => expect(test.dom.audioInputSelect.options).toHaveLength(1));
    expect(test.dom.audioInputSelect.options[0].text).toBe('Default microphone');
    expect(test.dom.audioOutputSelect.options[0].text).toBe('Speakers');
    expect(test.first.track.stop).toHaveBeenCalledTimes(1);

    test.dom.settingsModal.classList.add('hidden');
    test.mediaDevices.dispatchEvent(new Event('devicechange'));
    expect(test.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('routes saved output restoration through PeerManager to Web Audio', async () => {
    new SettingsStore().savePreferredOutput('speakers', 'Speakers');
    const test = setup();
    await test.session.populateAudioDevices();
    expect(test.setOutputDevice).toHaveBeenCalledWith('speakers');
  });

  it.each([true, false])('enables output selection only with Web Audio sink support: %s', async (supported) => {
    class Context {}
    if (supported) Object.assign(Context.prototype, { setSinkId: vi.fn() });
    vi.stubGlobal('AudioContext', Context);
    const test = setup();
    await test.session.populateAudioDevices();
    expect(test.dom.audioOutputSelect.disabled).toBe(!supported);
  });
});
