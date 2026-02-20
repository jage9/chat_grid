import './styles.css';
import { AudioEngine } from './audio/audioEngine';
import {
  EFFECT_IDS,
  EFFECT_SEQUENCE,
  clampEffectLevel,
  connectEffectChain,
  disconnectEffectRuntime,
  type EffectId,
  type EffectRuntime,
} from './audio/effects';
import { applyTextInput } from './input/textInput';
import { type IncomingMessage, type OutgoingMessage } from './network/protocol';
import { SignalingClient } from './network/signalingClient';
import { CanvasRenderer } from './render/canvasRenderer';
import {
  GRID_SIZE,
  HEARING_RADIUS,
  MOVE_COOLDOWN_MS,
  createInitialState,
  getDirection,
  getNearestItem,
  getNearestPeer,
  type GameState,
  type ItemType,
  type WorldItem,
} from './state/gameState';
import { PeerManager } from './webrtc/peerManager';

const EFFECT_LEVELS_STORAGE_KEY = 'chatGridEffectLevels';
const AUDIO_INPUT_STORAGE_KEY = 'chatGridAudioInputDeviceId';
const AUDIO_OUTPUT_STORAGE_KEY = 'chatGridAudioOutputDeviceId';
const AUDIO_INPUT_NAME_STORAGE_KEY = 'chatGridAudioInputDeviceName';
const AUDIO_OUTPUT_NAME_STORAGE_KEY = 'chatGridAudioOutputDeviceName';
const AUDIO_OUTPUT_MODE_STORAGE_KEY = 'chatGridAudioOutputMode';
const NICKNAME_STORAGE_KEY = 'spatialChatNickname';
const NICKNAME_MAX_LENGTH = 32;

declare global {
  interface Window {
    CHGRID_WEB_VERSION?: string;
  }
}

type Dom = {
  appVersion: HTMLElement;
  nicknameContainer: HTMLDivElement;
  preconnectNickname: HTMLInputElement;
  connectButton: HTMLButtonElement;
  disconnectButton: HTMLButtonElement;
  focusGridButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  closeSettingsButton: HTMLButtonElement;
  settingsModal: HTMLDivElement;
  audioInputSelect: HTMLSelectElement;
  audioOutputSelect: HTMLSelectElement;
  audioInputCurrent: HTMLParagraphElement;
  audioOutputCurrent: HTMLParagraphElement;
  canvas: HTMLCanvasElement;
  status: HTMLDivElement;
  instructions: HTMLDivElement;
};

const dom: Dom = {
  appVersion: requiredById('appVersion'),
  nicknameContainer: requiredById('nicknameContainer'),
  preconnectNickname: requiredById('preconnectNickname'),
  connectButton: requiredById('connectButton'),
  disconnectButton: requiredById('disconnectButton'),
  focusGridButton: requiredById('focusGridButton'),
  settingsButton: requiredById('settingsButton'),
  closeSettingsButton: requiredById('closeSettingsButton'),
  settingsModal: requiredById('settingsModal'),
  audioInputSelect: requiredById('audioInputSelect'),
  audioOutputSelect: requiredById('audioOutputSelect'),
  audioInputCurrent: requiredById('audioInputCurrent'),
  audioOutputCurrent: requiredById('audioOutputCurrent'),
  canvas: requiredById('gameCanvas'),
  status: requiredById('status'),
  instructions: requiredById('instructions'),
};

const APP_VERSION = String(window.CHGRID_WEB_VERSION ?? '').trim();
dom.appVersion.textContent = APP_VERSION
  ? `Another AI experiment with Jage. Version ${APP_VERSION}`
  : 'Another AI experiment with Jage. Version unknown';
const ITEM_TYPE_SEQUENCE: ItemType[] = ['radio_station', 'dice'];
const APP_BASE_URL = import.meta.env.BASE_URL || '/';
function withBase(path: string): string {
  const normalizedBase = APP_BASE_URL.endsWith('/') ? APP_BASE_URL : `${APP_BASE_URL}/`;
  return `${normalizedBase}${path.replace(/^\/+/, '')}`;
}
const SYSTEM_SOUND_URLS = {
  logon: withBase('sounds/logon.ogg'),
  logout: withBase('sounds/logout.ogg'),
  notify: withBase('sounds/notify.ogg'),
} as const;

const state = createInitialState();
const renderer = new CanvasRenderer(dom.canvas);
const audio = new AudioEngine();
let localStream: MediaStream | null = null;
let outboundStream: MediaStream | null = null;
let statusTimeout: number | null = null;
let lastFocusedElement: Element | null = null;
let lastAnnouncementText = '';
let lastAnnouncementAt = 0;
let preferredInputDeviceId = localStorage.getItem(AUDIO_INPUT_STORAGE_KEY) || '';
let preferredOutputDeviceId = localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY) || '';
let preferredInputDeviceName = localStorage.getItem(AUDIO_INPUT_NAME_STORAGE_KEY) || '';
let preferredOutputDeviceName = localStorage.getItem(AUDIO_OUTPUT_NAME_STORAGE_KEY) || '';
let outputMode = localStorage.getItem(AUDIO_OUTPUT_MODE_STORAGE_KEY) === 'mono' ? 'mono' : 'stereo';
let connecting = false;
const messageBuffer: string[] = [];
let messageCursor = -1;
type SharedRadioSource = {
  streamUrl: string;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  refCount: number;
};
type ItemRadioOutput = {
  streamUrl: string;
  effectInput: GainNode;
  effectRuntime: EffectRuntime | null;
  effect: EffectId;
  effectValue: number;
  gain: GainNode;
  panner: StereoPannerNode | null;
};
const sharedRadioSources = new Map<string, SharedRadioSource>();
const itemRadioOutputs = new Map<string, ItemRadioOutput>();
let replaceTextOnNextType = false;

const signalingProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const signalingUrl = `${signalingProtocol}://${window.location.host}/ws`;
const signaling = new SignalingClient(signalingUrl, updateStatus);

const peerManager = new PeerManager(
  audio,
  (targetId, payload) => {
    signaling.send({ type: 'signal', targetId, ...payload });
  },
  () => outboundStream,
  updateStatus,
);
audio.setOutputMode(outputMode);

loadEffectLevels();

function requiredById<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element: ${id}`);
  }
  return found as T;
}

function updateStatus(message: string): void {
  const normalized = String(message)
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const now = performance.now();
  if (normalized && normalized === lastAnnouncementText && now - lastAnnouncementAt < 300) {
    return;
  }
  lastAnnouncementText = normalized;
  lastAnnouncementAt = now;

  if (statusTimeout !== null) {
    window.clearTimeout(statusTimeout);
  }
  dom.status.textContent = '';
  requestAnimationFrame(() => {
    dom.status.textContent = normalized;
  });
  statusTimeout = window.setTimeout(() => {
    if (dom.status.textContent === normalized) {
      dom.status.textContent = '';
    }
  }, 4000);
}

function sanitizeName(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, NICKNAME_MAX_LENGTH);
}

function updateConnectAvailability(): void {
  if (state.running) {
    dom.connectButton.disabled = true;
    return;
  }
  const hasNickname = sanitizeName(dom.preconnectNickname.value).length > 0;
  dom.connectButton.disabled = connecting || !hasNickname;
}

function loadEffectLevels(): void {
  const raw = localStorage.getItem(EFFECT_LEVELS_STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Partial<
      Record<'reverb' | 'echo' | 'flanger' | 'high_pass' | 'low_pass' | 'off', number>
    >;
    audio.setEffectLevels(parsed);
  } catch {
    // Ignore malformed persisted values.
  }
}

function persistEffectLevels(): void {
  localStorage.setItem(EFFECT_LEVELS_STORAGE_KEY, JSON.stringify(audio.getEffectLevels()));
}

function pushChatMessage(message: string): void {
  messageBuffer.push(message);
  if (messageBuffer.length > 300) {
    messageBuffer.shift();
  }
  messageCursor = messageBuffer.length - 1;
  updateStatus(message);
}

function classifySystemMessageSound(message: string): keyof typeof SYSTEM_SOUND_URLS | null {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('welcome. logged in as ') || normalized.endsWith(' has logged in.')) {
    return 'logon';
  }
  if (normalized.endsWith(' has logged out.')) {
    return 'logout';
  }
  if (normalized.includes(' is now known as ') || normalized.startsWith('you are now known as ')) {
    return 'notify';
  }
  return null;
}

function resolveIncomingSoundUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  if (raw.startsWith('/sounds/')) {
    return withBase(raw.slice(1));
  }
  if (raw.startsWith('sounds/')) {
    return withBase(raw);
  }
  return raw;
}

function navigateChatBuffer(target: 'prev' | 'next' | 'first' | 'last'): void {
  if (messageBuffer.length === 0) {
    updateStatus('No chat messages.');
    audio.sfxUiCancel();
    return;
  }

  if (target === 'first') {
    messageCursor = 0;
  } else if (target === 'last') {
    messageCursor = messageBuffer.length - 1;
  } else if (target === 'prev') {
    messageCursor = Math.max(0, messageCursor - 1);
  } else if (target === 'next') {
    messageCursor = Math.min(messageBuffer.length - 1, messageCursor + 1);
  }

  updateStatus(messageBuffer[messageCursor]);
  audio.sfxUiBlip();
}

function updateDeviceSummary(): void {
  if (preferredInputDeviceId) {
    const text = dom.audioInputSelect.selectedOptions[0]?.text || preferredInputDeviceName || 'Saved microphone';
    dom.audioInputCurrent.textContent = `Input: ${text}`;
    dom.audioInputCurrent.classList.remove('hidden');
  } else {
    dom.audioInputCurrent.classList.add('hidden');
  }

  if (preferredOutputDeviceId) {
    const text = dom.audioOutputSelect.selectedOptions[0]?.text || preferredOutputDeviceName || 'Saved speakers';
    dom.audioOutputCurrent.textContent = `Output: ${text}`;
    dom.audioOutputCurrent.classList.remove('hidden');
  } else {
    dom.audioOutputCurrent.classList.add('hidden');
  }
}

function getPeerNamesAtPosition(x: number, y: number): string[] {
  return Array.from(state.peers.values())
    .filter((peer) => peer.x === x && peer.y === y)
    .map((peer) => peer.nickname);
}

function itemTypeLabel(type: ItemType): string {
  return type === 'radio_station' ? 'radio' : type;
}

function itemLabel(item: WorldItem): string {
  return `${item.title} (${itemTypeLabel(item.type)})`;
}

function getItemsAtPosition(x: number, y: number): WorldItem[] {
  return Array.from(state.items.values()).filter((item) => !item.carrierId && item.x === x && item.y === y);
}

function getCarriedItem(): WorldItem | null {
  if (!state.player.id) return null;
  return Array.from(state.items.values()).find((item) => item.carrierId === state.player.id) || null;
}

function beginItemSelection(context: 'pickup' | 'delete' | 'edit' | 'use', items: WorldItem[]): void {
  if (items.length === 0) {
    updateStatus('No items available.');
    audio.sfxUiCancel();
    return;
  }
  state.mode = 'selectItem';
  state.selectionContext = context;
  state.selectedItemIds = items.map((item) => item.id);
  state.selectedItemIndex = 0;
  updateStatus(`Select item: ${itemLabel(items[0])}.`);
  audio.sfxUiBlip();
}

function beginItemProperties(item: WorldItem): void {
  state.selectedItemId = item.id;
  state.mode = 'itemProperties';
  state.itemPropertyKeys = ['title'];
  if (item.type === 'radio_station') {
    state.itemPropertyKeys.push('streamUrl', 'enabled', 'volume', 'effect', 'effectValue');
  } else if (item.type === 'dice') {
    state.itemPropertyKeys.push('sides', 'number');
  }
  state.itemPropertyIndex = 0;
  const key = state.itemPropertyKeys[0];
  const value = getItemPropertyValue(item, key);
  updateStatus(`${key}: ${value}`);
  audio.sfxUiBlip();
}

function useItem(item: WorldItem): void {
  signaling.send({ type: 'item_use', itemId: item.id });
}

function releaseSharedRadioSource(streamUrl: string): void {
  const shared = sharedRadioSources.get(streamUrl);
  if (!shared) return;
  shared.refCount -= 1;
  if (shared.refCount > 0) return;
  shared.element.pause();
  shared.element.src = '';
  shared.source.disconnect();
  sharedRadioSources.delete(streamUrl);
}

function getOrCreateSharedRadioSource(streamUrl: string): SharedRadioSource | null {
  const existing = sharedRadioSources.get(streamUrl);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }
  const audioCtx = audio.context;
  if (!audioCtx) return null;
  const element = new Audio(streamUrl);
  element.crossOrigin = 'anonymous';
  element.loop = true;
  element.preload = 'none';
  const source = audioCtx.createMediaElementSource(element);
  void element.play().catch(() => undefined);
  const shared: SharedRadioSource = {
    streamUrl,
    element,
    source,
    refCount: 1,
  };
  sharedRadioSources.set(streamUrl, shared);
  return shared;
}

function cleanupRadioRuntime(itemId: string): void {
  const output = itemRadioOutputs.get(itemId);
  if (!output) return;
  output.effectInput.disconnect();
  disconnectEffectRuntime(output.effectRuntime);
  output.gain.disconnect();
  output.panner?.disconnect();
  itemRadioOutputs.delete(itemId);
  releaseSharedRadioSource(output.streamUrl);
}

function normalizeRadioEffect(effect: unknown): EffectId {
  if (typeof effect !== 'string') return 'off';
  const normalized = effect.trim().toLowerCase() as EffectId;
  return EFFECT_IDS.has(normalized) ? normalized : 'off';
}

function normalizeRadioEffectValue(effectValue: unknown): number {
  if (typeof effectValue !== 'number' || !Number.isFinite(effectValue)) {
    return 50;
  }
  return clampEffectLevel(effectValue);
}

function applyRadioEffect(
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

function cleanupAllRadioRuntimes(): void {
  for (const id of Array.from(itemRadioOutputs.keys())) {
    cleanupRadioRuntime(id);
  }
}

async function ensureRadioRuntime(item: WorldItem): Promise<void> {
  const streamUrl = String(item.params.streamUrl ?? '').trim();
  if (!streamUrl) {
    cleanupRadioRuntime(item.id);
    return;
  }
  await audio.ensureContext();
  const audioCtx = audio.context;
  if (!audioCtx) return;

  const existing = itemRadioOutputs.get(item.id);
  if (existing && existing.streamUrl === streamUrl) {
    return;
  }
  if (existing) {
    cleanupRadioRuntime(item.id);
  }

  const shared = getOrCreateSharedRadioSource(streamUrl);
  if (!shared) return;

  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  const effectInput = audioCtx.createGain();
  shared.source.connect(effectInput);
  const effect = normalizeRadioEffect(item.params.effect);
  const effectValue = normalizeRadioEffectValue(item.params.effectValue);
  const effectRuntime = connectEffectChain(audioCtx, effectInput, gain, effect, effectValue);
  let panner: StereoPannerNode | null = null;
  if (audio.supportsStereoPanner()) {
    panner = audioCtx.createStereoPanner();
    gain.connect(panner).connect(audioCtx.destination);
  } else {
    gain.connect(audioCtx.destination);
  }
  itemRadioOutputs.set(item.id, { streamUrl, effectInput, effectRuntime, effect, effectValue, gain, panner });
}

async function syncRadioStationPlayback(): Promise<void> {
  const validIds = new Set<string>();
  for (const item of state.items.values()) {
    if (item.type !== 'radio_station') continue;
    validIds.add(item.id);
    await ensureRadioRuntime(item);
  }
  for (const id of Array.from(itemRadioOutputs.keys())) {
    if (!validIds.has(id)) {
      cleanupRadioRuntime(id);
    }
  }
}

function updateRadioStationSpatialAudio(): void {
  const audioCtx = audio.context;
  if (!audioCtx) return;
  for (const [itemId, output] of itemRadioOutputs.entries()) {
    const item = state.items.get(itemId);
    if (!item || item.type !== 'radio_station') {
      cleanupRadioRuntime(itemId);
      continue;
    }
    const streamUrl = String(item.params.streamUrl ?? '').trim();
    const enabled = item.params.enabled !== false;
    const volume = Number(item.params.volume ?? 50);
    const normalizedVolume = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) / 100 : 0.5;
    const effect = normalizeRadioEffect(item.params.effect);
    const effectValue = normalizeRadioEffectValue(item.params.effectValue);
    applyRadioEffect(output, audioCtx, effect, effectValue);
    if (!streamUrl || !enabled) {
      output.gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
      continue;
    }
    const dist = Math.hypot(item.x - state.player.x, item.y - state.player.y);
    let gainValue = 0;
    let panValue = 0;
    if (dist < HEARING_RADIUS) {
      gainValue = Math.pow(1 - dist / HEARING_RADIUS, 2);
      panValue = Math.sin(((item.x - state.player.x) / HEARING_RADIUS) * (Math.PI / 2));
    }
    if (dist <= 1) {
      gainValue = 1;
      panValue = 0;
    }
    output.gain.gain.linearRampToValueAtTime(gainValue * normalizedVolume, audioCtx.currentTime + 0.1);
    if (output.panner) {
      output.panner.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, panValue)), audioCtx.currentTime + 0.1);
    }
  }
}

function shouldReplaceCurrentText(code: string, key: string): boolean {
  if (!replaceTextOnNextType) return false;
  if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
    replaceTextOnNextType = false;
    return false;
  }
  if (code === 'Backspace' || code === 'Delete') {
    replaceTextOnNextType = false;
    return false;
  }
  if (key.length === 1) {
    replaceTextOnNextType = false;
    return true;
  }
  return false;
}

function describeCharacter(ch: string): string {
  if (ch === ' ') return 'space';
  if (ch === '\t') return 'tab';
  if (ch === '.') return 'period';
  if (ch === ',') return 'comma';
  if (ch === "'") return 'apostrophe';
  if (ch === '"') return 'quote';
  if (ch === '-') return 'dash';
  if (ch === '=') return 'equals';
  return ch;
}

function getItemPropertyValue(item: WorldItem, key: string): string {
  if (key === 'title') return item.title;
  if (key === 'enabled') return item.params.enabled === false ? 'off' : 'on';
  if (key === 'effect') return normalizeRadioEffect(item.params.effect);
  if (key === 'effectValue') return String(normalizeRadioEffectValue(item.params.effectValue));
  return String(item.params[key] ?? '');
}

function announceCursorCharacter(text: string, cursorPos: number): void {
  if (cursorPos < 0 || cursorPos >= text.length || text.length === 0) {
    return;
  }
  updateStatus(describeCharacter(text[cursorPos]));
}

function announceBackspaceDeletedCharacter(text: string, cursorPos: number): void {
  if (cursorPos <= 0 || cursorPos > text.length) return;
  updateStatus(describeCharacter(text[cursorPos - 1]));
}

function squareWord(distance: number): string {
  return distance === 1 ? 'square' : 'squares';
}

function gameLoop(): void {
  if (!state.running) return;
  handleMovement();
  audio.updateSpatialAudio(peerManager.getPeers(), { x: state.player.x, y: state.player.y });
  updateRadioStationSpatialAudio();
  state.cursorVisible = Math.floor(Date.now() / 500) % 2 === 0;
  renderer.draw(state);
  requestAnimationFrame(gameLoop);
}

function handleMovement(): void {
  if (state.mode !== 'normal') return;
  const now = Date.now();
  if (now - state.player.lastMoveTime < MOVE_COOLDOWN_MS) return;

  let dx = 0;
  let dy = 0;
  if (state.keysPressed.ArrowUp) dy = 1;
  if (state.keysPressed.ArrowDown) dy = -1;
  if (state.keysPressed.ArrowLeft) dx = -1;
  if (state.keysPressed.ArrowRight) dx = 1;

  if (dx === 0 && dy === 0) return;

  const nextX = state.player.x + dx;
  const nextY = state.player.y + dy;
  if (nextX < 0 || nextY < 0 || nextX >= GRID_SIZE || nextY >= GRID_SIZE) return;

  state.player.x = nextX;
  state.player.y = nextY;
  state.player.lastMoveTime = now;
  audio.sfxMove(state.player);
  signaling.send({ type: 'update_position', x: nextX, y: nextY });

  const namesOnTile = getPeerNamesAtPosition(nextX, nextY);
  const itemsOnTile = getItemsAtPosition(nextX, nextY);
  const tileAnnouncements: string[] = [];
  if (namesOnTile.length > 0) {
    tileAnnouncements.push(namesOnTile.join(', '));
  }
  if (itemsOnTile.length > 0) {
    tileAnnouncements.push(itemsOnTile.map((item) => itemLabel(item)).join(', '));
  }
  if (tileAnnouncements.length > 0) {
    updateStatus(tileAnnouncements.join('. '));
    audio.sfxTileOccupantPing();
  }
}

async function checkMicPermission(): Promise<boolean> {
  const permissionApi = navigator.permissions;
  if (!permissionApi?.query) return true;
  try {
    const result = await permissionApi.query({ name: 'microphone' as PermissionName });
    return result.state !== 'denied';
  } catch {
    return true;
  }
}

async function setupLocalMedia(audioDeviceId = ''): Promise<void> {
  stopLocalMedia();

  await audio.ensureContext();

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

  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !state.isMuted;
  }
  outboundStream = await audio.configureOutboundStream(localStream);
  await peerManager.replaceOutgoingTrack(outboundStream);
}

function stopLocalMedia(): void {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  outboundStream = null;
}

function describeMediaError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Microphone blocked. Allow mic access in browser site settings.';
    if (error.name === 'NotFoundError') return 'No microphone found. Check that an input device is connected and enabled.';
    if (error.name === 'NotReadableError') return 'Microphone is busy or unavailable. Close other apps using the mic and retry.';
    if (error.name === 'OverconstrainedError') return 'Selected audio device is unavailable. Choose another input device.';
    if (error.name === 'SecurityError') return 'Microphone access requires a secure context (HTTPS) in production.';
  }
  return 'Audio setup failed. Check browser permissions and selected input device.';
}

async function connect(): Promise<void> {
  if (connecting || state.running) {
    return;
  }
  const nickname = sanitizeName(dom.preconnectNickname.value);
  if (!nickname) {
    updateStatus('Nickname is required.');
    updateConnectAvailability();
    return;
  }
  state.player.nickname = nickname;
  dom.preconnectNickname.value = nickname;
  localStorage.setItem(NICKNAME_STORAGE_KEY, nickname);
  connecting = true;
  updateConnectAvailability();
  const canProceed = await checkMicPermission();
  if (!canProceed) {
    updateStatus('Microphone access is required.');
    connecting = false;
    updateConnectAvailability();
    return;
  }

  state.player.x = Math.floor(Math.random() * GRID_SIZE);
  state.player.y = Math.floor(Math.random() * GRID_SIZE);
  const storedPosition = localStorage.getItem('spatialChatPosition');
  if (storedPosition) {
    try {
      const parsed = JSON.parse(storedPosition) as { x?: number; y?: number };
      if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        const x = Math.floor(parsed.x as number);
        const y = Math.floor(parsed.y as number);
        if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
          state.player.x = x;
          state.player.y = y;
        }
      }
    } catch {
      // Ignore malformed saved positions and keep randomized defaults.
    }
  }

  try {
    await populateAudioDevices();
    if (dom.audioInputSelect.options.length === 0) {
      updateStatus('No audio input device found. Open Settings or connect a microphone.');
      connecting = false;
      updateConnectAvailability();
      return;
    }
    const inputDeviceId = dom.audioInputSelect.value || preferredInputDeviceId;
    await setupLocalMedia(inputDeviceId);
  } catch (error) {
    console.error(error);
    updateStatus(describeMediaError(error));
    connecting = false;
    updateConnectAvailability();
    return;
  }

  try {
    await signaling.connect(onMessage);
  } catch (error) {
    console.error(error);
    stopLocalMedia();
    updateStatus('Connect failed. Signaling server may be offline or unreachable.');
    connecting = false;
    updateConnectAvailability();
  }
}

function disconnect(): void {
  const wasRunning = state.running;
  if (state.running) {
    localStorage.setItem(
      'spatialChatPosition',
      JSON.stringify({ x: state.player.x, y: state.player.y }),
    );
  }

  signaling.disconnect();
  stopLocalMedia();

  peerManager.cleanupAll();
  cleanupAllRadioRuntimes();
  state.running = false;
  state.keysPressed = {};
  state.peers.clear();
  state.items.clear();
  state.carriedItemId = null;
  state.mode = 'normal';
  state.sortedItemIds = [];
  state.itemListIndex = 0;
  state.selectedItemIds = [];
  state.selectionContext = null;
  state.selectedItemIndex = 0;
  state.selectedItemId = null;
  state.itemPropertyKeys = [];
  state.itemPropertyIndex = 0;
  state.editingPropertyKey = null;

  connecting = false;
  dom.nicknameContainer.classList.remove('hidden');
  dom.connectButton.classList.remove('hidden');
  dom.disconnectButton.classList.add('hidden');
  dom.focusGridButton.classList.add('hidden');
  dom.canvas.classList.add('hidden');
  dom.instructions.classList.add('hidden');
  updateConnectAvailability();

  updateStatus('Disconnected.');
  if (wasRunning) {
    void audio.playSample(SYSTEM_SOUND_URLS.logout, 1);
  }
}

async function onMessage(message: IncomingMessage): Promise<void> {
  switch (message.type) {
    case 'welcome':
      state.player.id = message.id;
      state.running = true;
      connecting = false;
      dom.nicknameContainer.classList.add('hidden');
      dom.connectButton.classList.add('hidden');
      dom.disconnectButton.classList.remove('hidden');
      dom.focusGridButton.classList.remove('hidden');
      dom.canvas.classList.remove('hidden');
      dom.instructions.classList.remove('hidden');
      dom.canvas.focus();

      signaling.send({ type: 'update_position', x: state.player.x, y: state.player.y });
      signaling.send({ type: 'update_nickname', nickname: state.player.nickname });

      for (const user of message.users) {
        state.peers.set(user.id, { ...user });
        await peerManager.createOrGetPeer(user.id, true, user);
      }
      state.items.clear();
      for (const item of message.items || []) {
        state.items.set(item.id, {
          ...item,
          carrierId: item.carrierId ?? null,
        });
      }
      await syncRadioStationPlayback();

      gameLoop();
      break;

    case 'signal': {
      const peer = await peerManager.handleSignal(message);
      if (!state.peers.has(peer.id)) {
        state.peers.set(peer.id, {
          id: peer.id,
          nickname: sanitizeName(peer.nickname) || 'user...',
          x: peer.x,
          y: peer.y,
        });
      }
      break;
    }

    case 'update_position': {
      const peer = state.peers.get(message.id);
      if (peer) {
        peer.x = message.x;
        peer.y = message.y;
      }
      peerManager.setPeerPosition(message.id, message.x, message.y);
      if (peer) {
        audio.sfxPeerMove({ x: peer.x - state.player.x, y: peer.y - state.player.y });
      }
      break;
    }

    case 'update_nickname': {
      const peer = state.peers.get(message.id);
      if (peer) {
        peer.nickname = sanitizeName(message.nickname) || 'user...';
      }
      peerManager.setPeerNickname(message.id, sanitizeName(message.nickname) || 'user...');
      break;
    }

    case 'user_left': {
      const peer = state.peers.get(message.id);
      if (peer) {
        updateStatus(`${peer.nickname} has left.`);
      }
      state.peers.delete(message.id);
      peerManager.removePeer(message.id);
      break;
    }

    case 'chat_message': {
      if (message.system) {
        pushChatMessage(message.message);
        const sound = classifySystemMessageSound(message.message);
        if (sound) {
          void audio.playSample(SYSTEM_SOUND_URLS[sound], 1);
        }
      } else {
        const sender = message.senderNickname || 'Unknown';
        pushChatMessage(`${sender}: ${message.message}`);
      }
      break;
    }

    case 'pong': {
      const elapsed = Math.max(0, Date.now() - message.clientSentAt);
      updateStatus(`Ping ${elapsed} ms`);
      audio.sfxUiBlip();
      break;
    }

    case 'nickname_result': {
      state.player.nickname = sanitizeName(message.effectiveNickname) || 'user...';
      if (message.accepted) {
        dom.preconnectNickname.value = state.player.nickname;
        localStorage.setItem(NICKNAME_STORAGE_KEY, state.player.nickname);
      } else {
        pushChatMessage(message.reason || 'Nickname unavailable.');
        audio.sfxUiCancel();
      }
      break;
    }

    case 'item_upsert': {
      state.items.set(message.item.id, {
        ...message.item,
        carrierId: message.item.carrierId ?? null,
      });
      state.carriedItemId = getCarriedItem()?.id ?? null;
      if (state.mode === 'itemProperties' && state.selectedItemId === message.item.id) {
        const key = state.itemPropertyKeys[state.itemPropertyIndex];
        if (key) {
          updateStatus(`${key}: ${getItemPropertyValue(message.item, key)}`);
        }
      }
      await syncRadioStationPlayback();
      break;
    }

    case 'item_remove': {
      state.items.delete(message.itemId);
      state.carriedItemId = getCarriedItem()?.id ?? null;
      cleanupRadioRuntime(message.itemId);
      break;
    }

    case 'item_action_result': {
      if (message.ok) {
        if (message.action === 'use') {
          pushChatMessage(message.message);
          const item = message.itemId ? state.items.get(message.itemId) : null;
          if (!item?.useSound && item) {
            audio.sfxLocate({ x: item.x - state.player.x, y: item.y - state.player.y });
          }
        } else if (message.action !== 'update') {
          pushChatMessage(message.message);
          audio.sfxUiConfirm();
        }
      } else {
        pushChatMessage(message.message);
        audio.sfxUiCancel();
      }
      break;
    }

    case 'item_use_sound': {
      const soundUrl = resolveIncomingSoundUrl(message.sound);
      if (!soundUrl) break;
      void audio.playSpatialSample(
        soundUrl,
        { x: message.x - state.player.x, y: message.y - state.player.y },
        1,
      );
      break;
    }
  }
}

function toggleMute(): void {
  state.isMuted = !state.isMuted;
  if (localStream) {
    const track = localStream.getAudioTracks()[0];
    if (track) track.enabled = !state.isMuted;
  }
  updateStatus(state.isMuted ? 'Muted.' : 'Unmuted.');
}

function handleNormalModeInput(code: string, shiftKey: boolean): void {
  if (code === 'KeyN') {
    state.mode = 'nickname';
    state.nicknameInput = state.player.nickname;
    state.cursorPos = state.player.nickname.length;
    replaceTextOnNextType = true;
    updateStatus(`Nickname edit: ${state.nicknameInput}`);
    audio.sfxUiBlip();
    return;
  }

  if (code === 'KeyM') {
    if (shiftKey) {
      outputMode = audio.toggleOutputMode();
      localStorage.setItem(AUDIO_OUTPUT_MODE_STORAGE_KEY, outputMode);
      updateStatus(outputMode === 'mono' ? 'Mono output.' : 'Stereo output.');
      audio.sfxUiBlip();
      return;
    }
    toggleMute();
    return;
  }

  if (code === 'KeyE') {
    const effect = audio.cycleOutboundEffect();
    updateStatus(effect.label);
    audio.sfxUiBlip();
    return;
  }

  if (code === 'Equal' || code === 'NumpadAdd' || code === 'Minus' || code === 'NumpadSubtract') {
    const step = code === 'Equal' || code === 'NumpadAdd' ? 5 : -5;
    const adjusted = audio.adjustCurrentEffectLevel(step);
    if (!adjusted) {
      return;
    }
    persistEffectLevels();
    audio.sfxEffectLevel(adjusted.value === adjusted.defaultValue);
    updateStatus(`${adjusted.label} ${adjusted.value}`);
    return;
  }

  if (code === 'KeyC') {
    updateStatus(`${state.player.x}, ${state.player.y}`);
    audio.sfxUiBlip();
    return;
  }

  if (code === 'KeyU') {
    if (shiftKey) {
      const allUsers = [state.player.nickname, ...Array.from(state.peers.values()).map((p) => p.nickname)];
      const label = allUsers.length === 1 ? 'user' : 'users';
      updateStatus(`${allUsers.length} ${label}: ${allUsers.join(', ')}`);
      audio.sfxUiBlip();
      return;
    }
    const carried = getCarriedItem();
    if (carried) {
      useItem(carried);
      return;
    }
    const squareItems = getItemsAtPosition(state.player.x, state.player.y);
    const usable = squareItems.filter((item) => item.capabilities.includes('usable'));
    if (usable.length === 0) {
      updateStatus('No usable items here.');
      audio.sfxUiCancel();
      return;
    }
    if (usable.length === 1) {
      useItem(usable[0]);
      return;
    }
    beginItemSelection('use', usable);
    return;
  }

  if (code === 'KeyA') {
    state.mode = 'addItem';
    updateStatus(`Add item: ${itemTypeLabel(ITEM_TYPE_SEQUENCE[state.addItemTypeIndex])}.`);
    audio.sfxUiBlip();
    return;
  }

  if (code === 'KeyI') {
    if (shiftKey) {
      if (state.items.size === 0) {
        updateStatus('No items to list.');
        audio.sfxUiCancel();
        return;
      }
      state.sortedItemIds = Array.from(state.items.entries())
        .filter(([, item]) => !item.carrierId)
        .sort(
          (a, b) =>
            Math.hypot(a[1].x - state.player.x, a[1].y - state.player.y) -
            Math.hypot(b[1].x - state.player.x, b[1].y - state.player.y),
        )
        .map(([id]) => id);
      if (state.sortedItemIds.length === 0) {
        updateStatus('No items to list.');
        audio.sfxUiCancel();
        return;
      }
      state.itemListIndex = 0;
      state.mode = 'listItems';
      const first = state.items.get(state.sortedItemIds[0]);
      if (first) {
        const distance = Math.round(Math.hypot(first.x - state.player.x, first.y - state.player.y));
        updateStatus(
          `List: ${itemLabel(first)}, ${distance} ${squareWord(distance)} ${getDirection(state.player.x, state.player.y, first.x, first.y)}, ${first.x}, ${first.y}`,
        );
      }
      audio.sfxUiBlip();
      return;
    }
    const nearest = getNearestItem(state);
    if (!nearest.itemId) {
      updateStatus('No items to locate.');
      audio.sfxUiCancel();
      return;
    }
    const item = state.items.get(nearest.itemId);
    if (!item) return;
    audio.sfxLocate({ x: item.x - state.player.x, y: item.y - state.player.y });
    const roundedDistance = Math.round(nearest.distance);
    updateStatus(
      `${itemLabel(item)}, ${roundedDistance} ${squareWord(roundedDistance)} ${getDirection(state.player.x, state.player.y, item.x, item.y)}, ${item.x}, ${item.y}`,
    );
    return;
  }

  if (code === 'KeyD') {
    const carried = getCarriedItem();
    if (shiftKey) {
      const squareItems = getItemsAtPosition(state.player.x, state.player.y);
      if (squareItems.length === 0) {
        updateStatus('No items to delete.');
        audio.sfxUiCancel();
        return;
      }
      if (squareItems.length === 1) {
        signaling.send({ type: 'item_delete', itemId: squareItems[0].id });
        return;
      }
      beginItemSelection('delete', squareItems);
      return;
    }

    if (carried) {
      signaling.send({ type: 'item_drop', itemId: carried.id, x: state.player.x, y: state.player.y });
      return;
    }
    const squareItems = getItemsAtPosition(state.player.x, state.player.y);
    if (squareItems.length === 0) {
      updateStatus('No items to pick up.');
      audio.sfxUiCancel();
      return;
    }
    if (squareItems.length === 1) {
      signaling.send({ type: 'item_pickup', itemId: squareItems[0].id });
      return;
    }
    beginItemSelection('pickup', squareItems);
    return;
  }

  if (code === 'KeyO') {
    const squareItems = getItemsAtPosition(state.player.x, state.player.y);
    if (squareItems.length === 0) {
      const carried = getCarriedItem();
      if (!carried) {
        updateStatus('No editable item here.');
        audio.sfxUiCancel();
        return;
      }
      beginItemProperties(carried);
      return;
    }
    if (squareItems.length === 1) {
      beginItemProperties(squareItems[0]);
      return;
    }
    beginItemSelection('edit', squareItems);
    return;
  }

  if (code === 'KeyP') {
    signaling.send({ type: 'ping', clientSentAt: Date.now() });
    return;
  }

  if (code === 'KeyL') {
    if (shiftKey) {
      if (state.peers.size === 0) {
        updateStatus('No users to list.');
        audio.sfxUiCancel();
        return;
      }
      state.sortedPeerIds = Array.from(state.peers.entries())
        .sort(
          (a, b) =>
            Math.hypot(a[1].x - state.player.x, a[1].y - state.player.y) -
            Math.hypot(b[1].x - state.player.x, b[1].y - state.player.y),
        )
        .map(([id]) => id);
      state.listIndex = 0;
      state.mode = 'listUsers';
      const first = state.peers.get(state.sortedPeerIds[0]);
      if (first) {
        const distance = Math.round(Math.hypot(first.x - state.player.x, first.y - state.player.y));
        updateStatus(
          `List: ${first.nickname}, ${distance} ${squareWord(distance)} ${getDirection(state.player.x, state.player.y, first.x, first.y)}, ${first.x}, ${first.y}`,
        );
      }
      audio.sfxUiBlip();
      return;
    }

    const nearest = getNearestPeer(state);
    if (!nearest.peerId) {
      updateStatus('No users to locate.');
      audio.sfxUiCancel();
      return;
    }
    const peer = state.peers.get(nearest.peerId);
    if (!peer) return;
    audio.sfxLocate({ x: peer.x - state.player.x, y: peer.y - state.player.y });
    const roundedDistance = Math.round(nearest.distance);
    updateStatus(
      `${peer.nickname}, ${roundedDistance} ${squareWord(roundedDistance)} ${getDirection(state.player.x, state.player.y, peer.x, peer.y)}, ${peer.x}, ${peer.y}`,
    );
    return;
  }

  if (code === 'Quote') {
    state.mode = 'chat';
    state.nicknameInput = '';
    state.cursorPos = 0;
    replaceTextOnNextType = false;
    updateStatus('Chat.');
    audio.sfxUiBlip();
    return;
  }

  if (code === 'Comma') {
    if (shiftKey) {
      navigateChatBuffer('first');
    } else {
      navigateChatBuffer('prev');
    }
    return;
  }

  if (code === 'Period') {
    if (shiftKey) {
      navigateChatBuffer('last');
    } else {
      navigateChatBuffer('next');
    }
    return;
  }

  if (code === 'Escape') {
    disconnect();
  }
}

function handleChatModeInput(code: string, key: string): void {
  if (code === 'Enter') {
    const message = state.nicknameInput.trim();
    if (message.length > 0) {
      signaling.send({ type: 'chat_message', message });
      state.mode = 'normal';
      state.nicknameInput = '';
      state.cursorPos = 0;
      audio.sfxUiConfirm();
    } else {
      state.mode = 'normal';
      audio.sfxUiCancel();
      updateStatus('Cancelled.');
    }
    return;
  }

  if (code === 'Escape') {
    state.mode = 'normal';
    state.nicknameInput = '';
    state.cursorPos = 0;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
    return;
  }

  const beforeText = state.nicknameInput;
  const beforeCursor = state.cursorPos;
  const mappedKey =
    code === 'ArrowLeft'
      ? 'arrowleft'
      : code === 'ArrowRight'
        ? 'arrowright'
        : code === 'Backspace'
          ? 'backspace'
          : code === 'Home'
            ? 'home'
            : code === 'End'
              ? 'end'
              : key;

  const result = applyTextInput(mappedKey, state.nicknameInput, state.cursorPos, 500);
  state.nicknameInput = result.newString;
  state.cursorPos = result.newCursorPos;
  if (code === 'Backspace') {
    announceBackspaceDeletedCharacter(beforeText, beforeCursor);
  }
  if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
    announceCursorCharacter(state.nicknameInput, state.cursorPos);
  }
}

function handleListModeInput(code: string): void {
  if (state.sortedPeerIds.length === 0) {
    state.mode = 'normal';
    return;
  }

  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.listIndex =
      code === 'ArrowDown'
        ? (state.listIndex + 1) % state.sortedPeerIds.length
        : (state.listIndex - 1 + state.sortedPeerIds.length) % state.sortedPeerIds.length;
    const peer = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!peer) return;
    const distance = Math.round(Math.hypot(peer.x - state.player.x, peer.y - state.player.y));
    updateStatus(
      `${peer.nickname}, ${distance} ${squareWord(distance)} ${getDirection(state.player.x, state.player.y, peer.x, peer.y)}, ${peer.x}, ${peer.y}`,
    );
    return;
  }

  if (code === 'Enter') {
    const peer = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!peer) return;
    state.player.x = peer.x;
    state.player.y = peer.y;
    signaling.send({ type: 'update_position', x: peer.x, y: peer.y });
    state.mode = 'normal';
    updateStatus(`Moved to ${peer.nickname}.`);
    audio.sfxUiConfirm();
    return;
  }

  if (code === 'Escape') {
    state.mode = 'normal';
    updateStatus('Exit list mode.');
    audio.sfxUiCancel();
  }
}

function handleListItemsModeInput(code: string): void {
  if (state.sortedItemIds.length === 0) {
    state.mode = 'normal';
    return;
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.itemListIndex =
      code === 'ArrowDown'
        ? (state.itemListIndex + 1) % state.sortedItemIds.length
        : (state.itemListIndex - 1 + state.sortedItemIds.length) % state.sortedItemIds.length;
    const item = state.items.get(state.sortedItemIds[state.itemListIndex]);
    if (!item) return;
    const distance = Math.round(Math.hypot(item.x - state.player.x, item.y - state.player.y));
    updateStatus(
      `${itemLabel(item)}, ${distance} ${squareWord(distance)} ${getDirection(state.player.x, state.player.y, item.x, item.y)}, ${item.x}, ${item.y}`,
    );
    return;
  }
  if (code === 'Enter') {
    const item = state.items.get(state.sortedItemIds[state.itemListIndex]);
    if (!item) return;
    state.player.x = item.x;
    state.player.y = item.y;
    signaling.send({ type: 'update_position', x: item.x, y: item.y });
    state.mode = 'normal';
    updateStatus(`Moved to ${itemLabel(item)}.`);
    audio.sfxUiConfirm();
    return;
  }
  if (code === 'Escape') {
    state.mode = 'normal';
    updateStatus('Exit item list mode.');
    audio.sfxUiCancel();
  }
}

function handleAddItemModeInput(code: string): void {
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.addItemTypeIndex =
      code === 'ArrowDown'
        ? (state.addItemTypeIndex + 1) % ITEM_TYPE_SEQUENCE.length
        : (state.addItemTypeIndex - 1 + ITEM_TYPE_SEQUENCE.length) % ITEM_TYPE_SEQUENCE.length;
    updateStatus(`${itemTypeLabel(ITEM_TYPE_SEQUENCE[state.addItemTypeIndex])}.`);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Enter') {
    signaling.send({ type: 'item_add', itemType: ITEM_TYPE_SEQUENCE[state.addItemTypeIndex] });
    state.mode = 'normal';
    return;
  }
  if (code === 'Escape') {
    state.mode = 'normal';
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

function handleSelectItemModeInput(code: string): void {
  if (state.selectedItemIds.length === 0) {
    state.mode = 'normal';
    state.selectionContext = null;
    return;
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.selectedItemIndex =
      code === 'ArrowDown'
        ? (state.selectedItemIndex + 1) % state.selectedItemIds.length
        : (state.selectedItemIndex - 1 + state.selectedItemIds.length) % state.selectedItemIds.length;
    const current = state.items.get(state.selectedItemIds[state.selectedItemIndex]);
    if (current) {
      updateStatus(itemLabel(current));
      audio.sfxUiBlip();
    }
    return;
  }
  if (code === 'Enter') {
    const selected = state.items.get(state.selectedItemIds[state.selectedItemIndex]);
    if (!selected) {
      state.mode = 'normal';
      state.selectionContext = null;
      return;
    }
    const context = state.selectionContext;
    state.mode = 'normal';
    state.selectionContext = null;
    if (context === 'pickup') {
      signaling.send({ type: 'item_pickup', itemId: selected.id });
      return;
    }
    if (context === 'delete') {
      signaling.send({ type: 'item_delete', itemId: selected.id });
      return;
    }
    if (context === 'edit') {
      beginItemProperties(selected);
      return;
    }
    if (context === 'use') {
      useItem(selected);
      return;
    }
    return;
  }
  if (code === 'Escape') {
    state.mode = 'normal';
    state.selectionContext = null;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

function handleItemPropertiesModeInput(code: string): void {
  const itemId = state.selectedItemId;
  if (!itemId) {
    state.mode = 'normal';
    return;
  }
  const item = state.items.get(itemId);
  if (!item) {
    state.mode = 'normal';
    updateStatus('Item no longer exists.');
    audio.sfxUiCancel();
    return;
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.itemPropertyIndex =
      code === 'ArrowDown'
        ? (state.itemPropertyIndex + 1) % state.itemPropertyKeys.length
        : (state.itemPropertyIndex - 1 + state.itemPropertyKeys.length) % state.itemPropertyKeys.length;
    const key = state.itemPropertyKeys[state.itemPropertyIndex];
    const value = getItemPropertyValue(item, key);
    updateStatus(`${key}: ${value}`);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Enter') {
    const key = state.itemPropertyKeys[state.itemPropertyIndex];
    if (key === 'enabled') {
      const nextEnabled = item.params.enabled === false;
      signaling.send({ type: 'item_update', itemId, params: { enabled: nextEnabled } });
      updateStatus(`enabled: ${nextEnabled ? 'on' : 'off'}`);
      audio.sfxUiBlip();
      return;
    }
    state.mode = 'itemPropertyEdit';
    state.editingPropertyKey = key;
    state.nicknameInput =
      key === 'title'
        ? item.title
        : key === 'enabled'
          ? item.params.enabled === false
            ? 'off'
            : 'on'
          : String(item.params[key] ?? '');
    state.cursorPos = state.nicknameInput.length;
    replaceTextOnNextType = true;
    updateStatus(`Edit ${key}: ${state.nicknameInput}`);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Escape') {
    state.mode = 'normal';
    state.selectedItemId = null;
    state.itemPropertyKeys = [];
    state.itemPropertyIndex = 0;
    updateStatus('Closed item properties.');
    audio.sfxUiCancel();
  }
}

function handleItemPropertyEditModeInput(code: string, key: string): void {
  const itemId = state.selectedItemId;
  const propertyKey = state.editingPropertyKey;
  if (!itemId || !propertyKey) {
    state.mode = 'normal';
    return;
  }
  if (code === 'Enter') {
    const value = state.nicknameInput.trim();
    if (propertyKey === 'title') {
      if (!value) {
        updateStatus('Value is required.');
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, title: value });
    } else if (propertyKey === 'streamUrl') {
      signaling.send({ type: 'item_update', itemId, params: { streamUrl: value } });
    } else if (propertyKey === 'enabled') {
      const normalized = value.toLowerCase();
      if (!['on', 'off', 'true', 'false', '1', '0', 'yes', 'no'].includes(normalized)) {
        updateStatus('enabled must be on or off.');
        audio.sfxUiCancel();
        return;
      }
      const enabled = ['on', 'true', '1', 'yes'].includes(normalized);
      signaling.send({ type: 'item_update', itemId, params: { enabled } });
    } else if (propertyKey === 'volume') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        updateStatus('volume must be an integer between 0 and 100.');
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { volume: parsed } });
    } else if (propertyKey === 'effect') {
      const normalized = value.trim().toLowerCase() as EffectId;
      if (!EFFECT_IDS.has(normalized)) {
        updateStatus(`effect must be one of: ${EFFECT_SEQUENCE.map((effect) => effect.id).join(', ')}.`);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { effect: normalized } });
    } else if (propertyKey === 'effectValue') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        updateStatus('effectValue must be an integer between 0 and 100.');
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { effectValue: clampEffectLevel(parsed) } });
    } else if (propertyKey === 'sides' || propertyKey === 'number') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        updateStatus(`${propertyKey} must be an integer between 1 and 100.`);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { [propertyKey]: parsed } });
    }
    state.mode = 'itemProperties';
    state.editingPropertyKey = null;
    replaceTextOnNextType = false;
    return;
  }
  if (code === 'Escape') {
    state.mode = 'itemProperties';
    state.editingPropertyKey = null;
    replaceTextOnNextType = false;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
    return;
  }
  const beforeText = state.nicknameInput;
  const beforeCursor = state.cursorPos;
  const mappedKey =
    code === 'ArrowLeft'
      ? 'arrowleft'
      : code === 'ArrowRight'
        ? 'arrowright'
        : code === 'Backspace'
          ? 'backspace'
          : code === 'Home'
            ? 'home'
            : code === 'End'
              ? 'end'
              : key;
  if (shouldReplaceCurrentText(code, key)) {
    state.nicknameInput = key;
    state.cursorPos = key.length;
    return;
  }
  const result = applyTextInput(mappedKey, state.nicknameInput, state.cursorPos, 500);
  state.nicknameInput = result.newString;
  state.cursorPos = result.newCursorPos;
  if (code === 'Backspace') {
    announceBackspaceDeletedCharacter(beforeText, beforeCursor);
  }
  if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
    announceCursorCharacter(state.nicknameInput, state.cursorPos);
  }
}

function handleNicknameModeInput(code: string, key: string): void {
  if (code === 'Enter') {
    const clean = sanitizeName(state.nicknameInput);
    if (clean) {
      const payload: OutgoingMessage = { type: 'update_nickname', nickname: clean };
      signaling.send(payload);
      audio.sfxUiConfirm();
    } else {
      updateStatus('Cancelled.');
      audio.sfxUiCancel();
    }
    state.mode = 'normal';
    replaceTextOnNextType = false;
    return;
  }

  if (code === 'Escape') {
    state.mode = 'normal';
    replaceTextOnNextType = false;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
    return;
  }

  const beforeText = state.nicknameInput;
  const beforeCursor = state.cursorPos;
  const mappedKey =
    code === 'ArrowLeft'
      ? 'arrowleft'
      : code === 'ArrowRight'
        ? 'arrowright'
        : code === 'Backspace'
          ? 'backspace'
          : code === 'Home'
            ? 'home'
            : code === 'End'
              ? 'end'
              : key;
  if (shouldReplaceCurrentText(code, key)) {
    state.nicknameInput = key;
    state.cursorPos = key.length;
    return;
  }

  const result = applyTextInput(mappedKey, state.nicknameInput, state.cursorPos, NICKNAME_MAX_LENGTH);
  state.nicknameInput = result.newString;
  state.cursorPos = result.newCursorPos;
  if (code === 'Backspace') {
    announceBackspaceDeletedCharacter(beforeText, beforeCursor);
  }
  if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
    announceCursorCharacter(state.nicknameInput, state.cursorPos);
  }
}

function isTypingKey(code: string): boolean {
  return code.startsWith('Key') || code === 'Space';
}

function setupInputHandlers(): void {
  document.addEventListener('keydown', (event) => {
    const code = event.code;

    if (!dom.settingsModal.classList.contains('hidden') && code === 'Escape') {
      closeSettings();
      return;
    }

    if (!state.running) return;
    if (document.activeElement !== dom.canvas) return;
    if (event.ctrlKey || event.altKey) return;

    if (state.mode !== 'normal' || !code.startsWith('Arrow')) {
      event.preventDefault();
    }

    if (isTypingKey(code) && state.keysPressed[code]) return;

    if (state.mode === 'nickname') {
      handleNicknameModeInput(code, event.key);
    } else if (state.mode === 'chat') {
      handleChatModeInput(code, event.key);
    } else if (state.mode === 'listUsers') {
      handleListModeInput(code);
    } else if (state.mode === 'listItems') {
      handleListItemsModeInput(code);
    } else if (state.mode === 'addItem') {
      handleAddItemModeInput(code);
    } else if (state.mode === 'selectItem') {
      handleSelectItemModeInput(code);
    } else if (state.mode === 'itemProperties') {
      handleItemPropertiesModeInput(code);
    } else if (state.mode === 'itemPropertyEdit') {
      handleItemPropertyEditModeInput(code, event.key);
    } else {
      handleNormalModeInput(code, event.shiftKey);
    }

    state.keysPressed[code] = true;
  });

  document.addEventListener('keyup', (event) => {
    state.keysPressed[event.code] = false;
  });
}

async function populateAudioDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }

  let temporaryStream: MediaStream | null = null;
  try {
    temporaryStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();

    dom.audioInputSelect.innerHTML = '';
    dom.audioOutputSelect.innerHTML = '';

    for (const device of devices) {
      if (device.kind === 'audioinput') {
        dom.audioInputSelect.add(new Option(device.label || `Microphone ${dom.audioInputSelect.length + 1}`, device.deviceId));
      }
      if (device.kind === 'audiooutput') {
        const option = new Option(device.label || `Speaker ${dom.audioOutputSelect.length + 1}`, device.deviceId);
        dom.audioOutputSelect.add(option);
      }
    }

    if (preferredInputDeviceId && Array.from(dom.audioInputSelect.options).some((option) => option.value === preferredInputDeviceId)) {
      dom.audioInputSelect.value = preferredInputDeviceId;
      preferredInputDeviceName = dom.audioInputSelect.selectedOptions[0]?.text || preferredInputDeviceName;
    } else if (dom.audioInputSelect.options.length > 0) {
      preferredInputDeviceId = dom.audioInputSelect.value;
      preferredInputDeviceName = dom.audioInputSelect.selectedOptions[0]?.text || preferredInputDeviceName;
      localStorage.setItem(AUDIO_INPUT_STORAGE_KEY, preferredInputDeviceId);
      localStorage.setItem(AUDIO_INPUT_NAME_STORAGE_KEY, preferredInputDeviceName);
    }

    if (preferredOutputDeviceId && Array.from(dom.audioOutputSelect.options).some((option) => option.value === preferredOutputDeviceId)) {
      dom.audioOutputSelect.value = preferredOutputDeviceId;
      preferredOutputDeviceName = dom.audioOutputSelect.selectedOptions[0]?.text || preferredOutputDeviceName;
      void peerManager.setOutputDevice(preferredOutputDeviceId);
    }

    const sinkCapable = typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function';
    dom.audioOutputSelect.disabled = !sinkCapable;
    updateDeviceSummary();
  } catch {
    updateStatus('Could not list devices.');
  } finally {
    temporaryStream?.getTracks().forEach((track) => track.stop());
  }
}

function openSettings(): void {
  lastFocusedElement = document.activeElement;
  dom.settingsModal.classList.remove('hidden');
  void populateAudioDevices();
  dom.audioInputSelect.focus();
}

function closeSettings(): void {
  dom.settingsModal.classList.add('hidden');
  if (lastFocusedElement instanceof HTMLElement) {
    lastFocusedElement.focus();
  } else {
    dom.canvas.focus();
  }
}

function setupUiHandlers(): void {
  dom.connectButton.addEventListener('click', () => {
    void connect();
  });
  dom.preconnectNickname.addEventListener('input', () => {
    updateConnectAvailability();
  });
  dom.preconnectNickname.addEventListener('change', () => {
    const clean = sanitizeName(dom.preconnectNickname.value);
    dom.preconnectNickname.value = clean;
    if (clean) {
      localStorage.setItem(NICKNAME_STORAGE_KEY, clean);
    } else {
      localStorage.removeItem(NICKNAME_STORAGE_KEY);
    }
    updateConnectAvailability();
  });
  dom.preconnectNickname.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !dom.connectButton.disabled) {
      event.preventDefault();
      void connect();
    }
  });

  dom.disconnectButton.addEventListener('click', () => {
    disconnect();
  });

  dom.focusGridButton.addEventListener('click', () => {
    dom.canvas.focus();
    updateStatus('Chat Grid focused.');
    audio.sfxUiBlip();
  });

  dom.settingsButton.addEventListener('click', () => {
    openSettings();
  });

  dom.closeSettingsButton.addEventListener('click', () => {
    closeSettings();
  });

  dom.audioInputSelect.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    if (!target.value) return;
    preferredInputDeviceId = target.value;
    preferredInputDeviceName = target.selectedOptions[0]?.text || preferredInputDeviceName;
    localStorage.setItem(AUDIO_INPUT_STORAGE_KEY, preferredInputDeviceId);
    localStorage.setItem(AUDIO_INPUT_NAME_STORAGE_KEY, preferredInputDeviceName);
    updateDeviceSummary();
    void setupLocalMedia(target.value);
  });

  dom.audioOutputSelect.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    preferredOutputDeviceId = target.value;
    preferredOutputDeviceName = target.selectedOptions[0]?.text || preferredOutputDeviceName;
    localStorage.setItem(AUDIO_OUTPUT_STORAGE_KEY, preferredOutputDeviceId);
    localStorage.setItem(AUDIO_OUTPUT_NAME_STORAGE_KEY, preferredOutputDeviceName);
    updateDeviceSummary();
    void peerManager.setOutputDevice(preferredOutputDeviceId);
  });

  dom.settingsModal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dom.settingsModal.querySelectorAll<HTMLElement>('select, button'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      last.focus();
      event.preventDefault();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
  });
}

setupInputHandlers();
setupUiHandlers();
const storedNickname = sanitizeName(localStorage.getItem(NICKNAME_STORAGE_KEY) || '');
dom.preconnectNickname.value = storedNickname;
if (storedNickname) {
  state.player.nickname = storedNickname;
}
updateConnectAvailability();
updateDeviceSummary();
updateStatus('Welcome to the Chat Grid. Press the Settings button to configure your audio, then Connect to join the grid.');
