import { type GameState } from '../state/gameState';
import { AudioEngine } from '../audio/audioEngine';
import { PeerManager } from '../webrtc/peerManager';
import { SettingsStore } from '../settings/settingsStore';
import { formatSteppedNumber, snapNumberToStep } from '../input/numeric';

type DeviceDom = {
  settingsModal: HTMLDivElement;
  audioInputSelect: HTMLSelectElement;
  audioOutputSelect: HTMLSelectElement;
  audioInputCurrent: HTMLParagraphElement;
  audioOutputCurrent: HTMLParagraphElement;
};

type SessionOptions = {
  state: GameState;
  audio: AudioEngine;
  peerManager: PeerManager;
  settings: SettingsStore;
  dom: DeviceDom;
  updateStatus: (message: string) => void;
  /** Returns whether the current account may send microphone audio. */
  isVoiceSendAllowed: () => boolean;
  micCalibrationDurationMs: number;
  micCalibrationSampleIntervalMs: number;
  micCalibrationMinGain: number;
  micCalibrationMaxGain: number;
  micCalibrationTargetRms: number;
  micCalibrationActiveRmsThreshold: number;
  micInputGainScaleMultiplier: number;
  micInputGainStep: number;
};

/**
 * Owns browser media/session lifecycle state and related device preference handling.
 */
export class MediaSession {
  private localStream: MediaStream | null = null;
  private outboundStream: MediaStream | null = null;
  private localMediaGeneration = 0;
  private connecting = false;
  private calibratingMicInput = false;
  private preferredInputDeviceId: string;
  private preferredOutputDeviceId: string;
  private preferredInputDeviceName: string;
  private preferredOutputDeviceName: string;

  constructor(private readonly options: SessionOptions) {
    const prefs = this.options.settings.loadAudioDevicePreferences();
    this.preferredInputDeviceId = prefs.input.id;
    this.preferredOutputDeviceId = prefs.output.id;
    this.preferredInputDeviceName = prefs.input.name;
    this.preferredOutputDeviceName = prefs.output.name;
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      if (!this.options.dom.settingsModal.classList.contains('hidden')) {
        void this.populateAudioDevices();
      }
    });
  }

  /** Returns the current outbound stream used for peer send tracks. */
  getOutboundStream(): MediaStream | null {
    return this.outboundStream;
  }

  /** Returns whether a connect flow is currently in progress. */
  isConnecting(): boolean {
    return this.connecting;
  }

  /** Sets connecting flag for external message handlers. */
  setConnecting(value: boolean): void {
    this.connecting = value;
  }

  /** Returns stored preferred input device id, if any. */
  getPreferredInputDeviceId(): string {
    return this.preferredInputDeviceId;
  }

  /** Returns browser-selected audio output mode from persisted settings. */
  loadOutputMode(): 'mono' | 'stereo' {
    return this.options.settings.loadOutputMode();
  }

  /** Persists audio output mode selection. */
  saveOutputMode(value: 'mono' | 'stereo'): void {
    this.options.settings.saveOutputMode(value);
  }

  /** Updates stored preferred input device and persists it. */
  setPreferredInput(id: string, name: string): void {
    this.preferredInputDeviceId = id;
    this.preferredInputDeviceName = name || this.preferredInputDeviceName;
    this.options.settings.savePreferredInput(this.preferredInputDeviceId, this.preferredInputDeviceName);
  }

  /** Updates stored preferred output device and persists it. */
  setPreferredOutput(id: string, name: string): void {
    this.preferredOutputDeviceId = id;
    this.preferredOutputDeviceName = name || this.preferredOutputDeviceName;
    this.options.settings.savePreferredOutput(this.preferredOutputDeviceId, this.preferredOutputDeviceName);
  }

  /** Applies saved device labels to pre-connect status summary rows. */
  updateDeviceSummary(): void {
    const { dom } = this.options;
    if (this.preferredInputDeviceId) {
      const text = dom.audioInputSelect.selectedOptions[0]?.text || this.preferredInputDeviceName || 'Saved microphone';
      dom.audioInputCurrent.textContent = `Input: ${text}`;
      dom.audioInputCurrent.classList.remove('hidden');
    } else {
      dom.audioInputCurrent.classList.add('hidden');
    }

    if (this.preferredOutputDeviceId) {
      const text = dom.audioOutputSelect.selectedOptions[0]?.text || this.preferredOutputDeviceName || 'Saved speakers';
      dom.audioOutputCurrent.textContent = `Output: ${text}`;
      dom.audioOutputCurrent.classList.remove('hidden');
    } else {
      dom.audioOutputCurrent.classList.add('hidden');
    }
  }

  /** Enumerates audio input/output devices and restores saved choices where possible. */
  async populateAudioDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    let temporaryStream: MediaStream | null = null;
    try {
      temporaryStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      const { dom } = this.options;
      dom.audioInputSelect.innerHTML = '';
      dom.audioOutputSelect.innerHTML = '';

      for (const device of devices) {
        if (device.kind === 'audioinput') {
          dom.audioInputSelect.add(new Option(device.label || `Microphone ${dom.audioInputSelect.length + 1}`, device.deviceId));
        }
        if (device.kind === 'audiooutput') {
          dom.audioOutputSelect.add(new Option(device.label || `Speaker ${dom.audioOutputSelect.length + 1}`, device.deviceId));
        }
      }

      if (this.preferredInputDeviceId && Array.from(dom.audioInputSelect.options).some((option) => option.value === this.preferredInputDeviceId)) {
        dom.audioInputSelect.value = this.preferredInputDeviceId;
        this.preferredInputDeviceName = dom.audioInputSelect.selectedOptions[0]?.text || this.preferredInputDeviceName;
      } else if (dom.audioInputSelect.options.length > 0) {
        this.preferredInputDeviceId = dom.audioInputSelect.value;
        this.preferredInputDeviceName = dom.audioInputSelect.selectedOptions[0]?.text || this.preferredInputDeviceName;
        this.options.settings.savePreferredInput(this.preferredInputDeviceId, this.preferredInputDeviceName);
      }

      if (this.preferredOutputDeviceId && Array.from(dom.audioOutputSelect.options).some((option) => option.value === this.preferredOutputDeviceId)) {
        dom.audioOutputSelect.value = this.preferredOutputDeviceId;
        this.preferredOutputDeviceName = dom.audioOutputSelect.selectedOptions[0]?.text || this.preferredOutputDeviceName;
        void this.options.peerManager.setOutputDevice(this.preferredOutputDeviceId);
      }

      const sinkCapable = typeof (window.AudioContext?.prototype as { setSinkId?: unknown } | undefined)?.setSinkId === 'function';
      dom.audioOutputSelect.disabled = !sinkCapable;
      this.updateDeviceSummary();
    } catch {
      this.options.updateStatus('Could not list devices.');
    } finally {
      temporaryStream?.getTracks().forEach((track) => track.stop());
    }
  }

  /** Returns true when microphone permission is available or cannot be preflight-checked. */
  async checkMicPermission(): Promise<boolean> {
    const permissionApi = navigator.permissions;
    if (!permissionApi?.query) return true;
    try {
      const result = await permissionApi.query({ name: 'microphone' as PermissionName });
      return result.state !== 'denied';
    } catch {
      return true;
    }
  }

  /** Maps capture/setup exceptions to user-facing text. */
  describeMediaError(error: unknown): string {
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') return 'Microphone blocked. Allow mic access in browser site settings.';
      if (error.name === 'NotFoundError') return 'No microphone found. Check that an input device is connected and enabled.';
      if (error.name === 'NotReadableError') return 'Microphone is busy or unavailable. Close other apps using the mic and retry.';
      if (error.name === 'OverconstrainedError') return 'Selected audio device is unavailable. Choose another input device.';
      if (error.name === 'SecurityError') return 'Microphone access requires a secure context (HTTPS) in production.';
    }
    return 'Audio setup failed. Check browser permissions and selected input device.';
  }

  /** Starts local capture and replaces outbound peer tracks. */
  async setupLocalMedia(audioDeviceId = ''): Promise<void> {
    this.stopLocalMedia();
    const generation = this.localMediaGeneration;
    await this.options.audio.ensureContext();
    if (generation !== this.localMediaGeneration) return;

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined,
        sampleRate: 48000,
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (generation !== this.localMediaGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.localStream = stream;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = this.isMicrophoneEnabled();
      audioTrack.addEventListener('ended', this.onLocalTrackEnded, { once: true });
    }
    const outboundStream = await this.options.audio.configureOutboundStream(this.localStream);
    if (generation !== this.localMediaGeneration) return;
    // Reapply the policy after async setup so a fallback cannot publish an
    // enabled track when authorization or mute state changed during capture.
    if (audioTrack) {
      audioTrack.enabled = this.isMicrophoneEnabled();
    }
    this.outboundStream = outboundStream;
    await this.options.peerManager.replaceOutgoingTrack(this.outboundStream);
  }

  private isMicrophoneEnabled(): boolean {
    return this.options.isVoiceSendAllowed() && !this.options.state.isMuted;
  }

  private onLocalTrackEnded = (): void => {
    if (!this.options.state.running) return;
    this.options.updateStatus('Microphone disconnected. Switching to default microphone.');
    const recovery = this.setupLocalMedia('');
    const generation = this.localMediaGeneration;
    void recovery.catch(() => {
      if (generation !== this.localMediaGeneration || !this.options.state.running) return;
      this.stopLocalMedia();
      this.options.updateStatus('Microphone unavailable. Check your input device.');
    });
  };

  /** Stops local media tracks and clears outbound references. */
  stopLocalMedia(): void {
    // Invalidate pending capture so a late result cannot restart stopped media.
    this.localMediaGeneration += 1;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => track.removeEventListener('ended', this.onLocalTrackEnded));
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    this.outboundStream = null;
  }

  /** Applies mute state to active local track when present. */
  applyMuteToTrack(isMuted: boolean): void {
    if (!this.localStream) return;
    const track = this.localStream.getAudioTracks()[0];
    if (track) {
      track.enabled = !isMuted;
    }
  }

  /** Calibrates mic gain from a short speech sample and persists applied value. */
  async calibrateMicInputGain(
    clampMicInputGain: (value: number) => number,
    persistMicInputGain: (value: number) => void,
  ): Promise<void> {
    const {
      updateStatus,
      audio,
      micCalibrationDurationMs,
      micCalibrationSampleIntervalMs,
      micCalibrationActiveRmsThreshold,
      micCalibrationTargetRms,
      micInputGainScaleMultiplier,
      micInputGainStep,
      micCalibrationMinGain,
    } = this.options;
    if (this.calibratingMicInput) {
      updateStatus('Mic calibration already running.');
      return;
    }
    if (!this.options.state.running || !this.localStream) {
      updateStatus('Connect first, then use Shift+C to calibrate.');
      audio.sfxUiCancel();
      return;
    }
    const track = this.localStream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') {
      updateStatus('No active microphone track for calibration.');
      audio.sfxUiCancel();
      return;
    }
    await audio.ensureContext();
    const audioContext = audio.context;
    if (!audioContext) {
      updateStatus('Audio context unavailable.');
      audio.sfxUiCancel();
      return;
    }

    this.calibratingMicInput = true;
    updateStatus('Speak for 5 seconds to calibrate your audio.');
    audio.sfxUiBlip();

    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const rmsValues: number[] = [];

    try {
      const startedAt = performance.now();
      while (performance.now() - startedAt < micCalibrationDurationMs) {
        analyser.getFloatTimeDomainData(samples);
        let sumSquares = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const sample = samples[i];
          sumSquares += sample * sample;
        }
        rmsValues.push(Math.sqrt(sumSquares / samples.length));
        await new Promise((resolve) => window.setTimeout(resolve, micCalibrationSampleIntervalMs));
      }
    } finally {
      source.disconnect();
      analyser.disconnect();
      this.calibratingMicInput = false;
    }

    const activeRms = rmsValues.filter((value) => value >= micCalibrationActiveRmsThreshold);
    if (activeRms.length < 10) {
      updateStatus('No audio detected, please try again.');
      audio.sfxUiCancel();
      return;
    }

    activeRms.sort((a, b) => a - b);
    const percentileIndex = Math.min(activeRms.length - 1, Math.floor(activeRms.length * 0.9));
    const observedRms = activeRms[percentileIndex];
    if (!(observedRms > 0)) {
      updateStatus('No audio detected, please try again.');
      audio.sfxUiCancel();
      return;
    }

    const calibratedGain = clampMicInputGain((micCalibrationTargetRms / observedRms) * micInputGainScaleMultiplier);
    const roundedGain = clampMicInputGain(snapNumberToStep(calibratedGain, micInputGainStep, micCalibrationMinGain));
    const appliedGain = audio.setOutboundInputGain(roundedGain);
    persistMicInputGain(appliedGain);
    updateStatus(`Mic calibration set to ${formatSteppedNumber(appliedGain, micInputGainStep)}x.`);
    audio.sfxUiConfirm();
  }
}
