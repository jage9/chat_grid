import './styles.css';
import { AudioEngine } from './audio/audioEngine';
import {
  EFFECT_IDS,
  EFFECT_SEQUENCE,
  clampEffectLevel,
  type EffectId,
} from './audio/effects';
import {
  RadioStationRuntime,
  getProxyUrlForStream,
  normalizeRadioChannel,
  normalizeRadioEffect,
  normalizeRadioEffectValue,
  shouldProxyStreamUrl,
} from './audio/radioStationRuntime';
import { ItemEmitRuntime } from './audio/itemEmitRuntime';
import { normalizeDegrees } from './audio/spatial';
import {
  applyPastedText,
  applyTextInput,
  describeBackspaceDeletedCharacter,
  describeDeleteDeletedCharacter,
  describeCursorCharacter,
  describeCursorWordOrCharacter,
  mapTextInputKey,
  moveCursorWordLeft,
  moveCursorWordRight,
  shouldReplaceCurrentText,
} from './input/textInput';
import { cycleIndex, findNextIndexByInitial } from './input/listNavigation';
import { formatSteppedNumber, snapNumberToStep } from './input/numeric';
import { type IncomingMessage, type OutgoingMessage } from './network/protocol';
import { SignalingClient } from './network/signalingClient';
import { CanvasRenderer } from './render/canvasRenderer';
import {
  GRID_SIZE,
  MOVE_COOLDOWN_MS,
  createInitialState,
  getDirection,
  getNearestItem,
  getNearestPeer,
  type WorldItem,
} from './state/gameState';
import {
  applyServerItemUiDefinitions,
  getDefaultClockTimeZone,
  getItemTypeGlobalProperties,
  getItemTypeSequence,
  getEditableItemPropertyKeys,
  getInspectItemPropertyKeys,
  getItemPropertyOptionValues,
  getItemPropertyMetadata,
  itemPropertyLabel,
  getItemTypeTooltip,
  itemTypeLabel,
} from './items/itemRegistry';
import { PeerManager } from './webrtc/peerManager';

const EFFECT_LEVELS_STORAGE_KEY = 'chatGridEffectLevels';
const AUDIO_INPUT_STORAGE_KEY = 'chatGridAudioInputDeviceId';
const AUDIO_OUTPUT_STORAGE_KEY = 'chatGridAudioOutputDeviceId';
const AUDIO_INPUT_NAME_STORAGE_KEY = 'chatGridAudioInputDeviceName';
const AUDIO_OUTPUT_NAME_STORAGE_KEY = 'chatGridAudioOutputDeviceName';
const AUDIO_OUTPUT_MODE_STORAGE_KEY = 'chatGridAudioOutputMode';
const AUDIO_LAYER_STATE_STORAGE_KEY = 'chatGridAudioLayers';
const MIC_INPUT_GAIN_STORAGE_KEY = 'chatGridMicInputGain';
const DEFAULT_DISPLAY_TIME_ZONE = 'America/Detroit';
const NICKNAME_STORAGE_KEY = 'spatialChatNickname';
const NICKNAME_MAX_LENGTH = 32;
const MIC_CALIBRATION_DURATION_MS = 5000;
const MIC_CALIBRATION_SAMPLE_INTERVAL_MS = 50;
const MIC_CALIBRATION_MIN_GAIN = 0.5;
const MIC_CALIBRATION_MAX_GAIN = 4;
const MIC_CALIBRATION_TARGET_RMS = 0.12;
const MIC_CALIBRATION_ACTIVE_RMS_THRESHOLD = 0.003;
const MIC_INPUT_GAIN_SCALE_MULTIPLIER = 2;
const MIC_INPUT_GAIN_STEP = 0.05;

declare global {
  interface Window {
    CHGRID_WEB_VERSION?: string;
    CHGRID_TIME_ZONE?: string;
  }
}

type Dom = {
  appVersion: HTMLElement;
  updatesSection: HTMLElement;
  updatesToggle: HTMLButtonElement;
  updatesPanel: HTMLDivElement;
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
  updatesSection: requiredById('updatesSection'),
  updatesToggle: requiredById('updatesToggle'),
  updatesPanel: requiredById('updatesPanel'),
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

type ChangelogSection = {
  date: string;
  items: string[];
};

type ChangelogData = {
  sections: ChangelogSection[];
};

type HelpItem = {
  keys: string;
  description: string;
};

type HelpSection = {
  title: string;
  items: HelpItem[];
};

type HelpData = {
  sections: HelpSection[];
};

type AudioLayerState = {
  voice: boolean;
  item: boolean;
  media: boolean;
  world: boolean;
};

const APP_VERSION = String(window.CHGRID_WEB_VERSION ?? '').trim();
const DISPLAY_TIME_ZONE = resolveDisplayTimeZone();
dom.appVersion.textContent = APP_VERSION
  ? `Another AI experiment with Jage. Version ${APP_VERSION}`
  : 'Another AI experiment with Jage. Version unknown';
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
const FOOTSTEP_SOUND_URLS = Array.from({ length: 11 }, (_, index) => withBase(`sounds/step-${index + 1}.ogg`));
const FOOTSTEP_GAIN = 0.7;
const TELEPORT_SOUND_URL = withBase('sounds/teleport.ogg');
const WALL_SOUND_URL = withBase('sounds/wall.ogg');

const state = createInitialState();
const renderer = new CanvasRenderer(dom.canvas);
const audio = new AudioEngine();
let worldGridSize = GRID_SIZE;
let lastWallCollisionDirection: string | null = null;
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
const radioRuntime = new RadioStationRuntime(audio, getItemSpatialConfig);
const itemEmitRuntime = new ItemEmitRuntime(audio, resolveIncomingSoundUrl, getItemSpatialConfig);
let internalClipboardText = '';
let replaceTextOnNextType = false;
let pendingEscapeDisconnect = false;
let helpViewerLines: string[] = [];
let helpViewerIndex = 0;
let calibratingMicInput = false;
let audioLayers: AudioLayerState = {
  voice: true,
  item: true,
  media: true,
  world: true,
};

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
loadAudioLayerState();
loadMicInputGain();
void loadHelp();
void loadChangelog();

function requiredById<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element: ${id}`);
  }
  return found as T;
}

function resolveDisplayTimeZone(): string {
  const configured = String(window.CHGRID_TIME_ZONE ?? '').trim();
  if (configured) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: configured }).format(new Date());
      return configured;
    } catch {
      // Fall back when configured timezone is invalid.
    }
  }
  return DEFAULT_DISPLAY_TIME_ZONE;
}

function formatTimestampMs(value: unknown): string {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return String(value ?? '');
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return String(value ?? '');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
}

function setUpdatesExpanded(expanded: boolean): void {
  dom.updatesToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  dom.updatesToggle.textContent = expanded ? 'Hide updates' : 'Show updates';
  dom.updatesPanel.hidden = !expanded;
  dom.updatesPanel.classList.toggle('hidden', !expanded);
}

function renderHelp(help: HelpData): void {
  const lines: string[] = [];
  dom.instructions.innerHTML = '';
  const heading = document.createElement('h2');
  heading.textContent = 'Help';
  dom.instructions.appendChild(heading);
  for (const section of help.sections) {
    const sectionHeading = document.createElement('h3');
    sectionHeading.textContent = section.title;
    dom.instructions.appendChild(sectionHeading);
    lines.push(section.title);
    for (const item of section.items) {
      const line = document.createElement('p');
      const keys = document.createElement('b');
      keys.textContent = `${item.keys}:`;
      line.appendChild(keys);
      line.append(` ${item.description}`);
      dom.instructions.appendChild(line);
      lines.push(`${item.keys}: ${item.description}`);
    }
  }
  helpViewerLines = lines;
  helpViewerIndex = 0;
}

async function loadHelp(): Promise<void> {
  try {
    const response = await fetch(withBase('help.json'), { cache: 'no-store' });
    if (!response.ok) {
      return;
    }
    const help = (await response.json()) as HelpData;
    if (!Array.isArray(help.sections) || help.sections.length === 0) {
      return;
    }
    renderHelp(help);
  } catch {
    // Keep existing/static help if loading fails.
  }
}

function renderChangelog(changelog: ChangelogData): void {
  dom.updatesPanel.innerHTML = '';
  for (const section of changelog.sections) {
    const heading = document.createElement('h3');
    heading.textContent = section.date;
    dom.updatesPanel.appendChild(heading);

    const list = document.createElement('ul');
    for (const item of section.items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    }
    dom.updatesPanel.appendChild(list);
  }
}

async function loadChangelog(): Promise<void> {
  try {
    const response = await fetch(withBase('changelog.json'), { cache: 'no-store' });
    if (!response.ok) {
      dom.updatesSection.classList.add('hidden');
      return;
    }
    const changelog = (await response.json()) as ChangelogData;
    if (!Array.isArray(changelog.sections) || changelog.sections.length === 0) {
      dom.updatesSection.classList.add('hidden');
      return;
    }
    renderChangelog(changelog);
    setUpdatesExpanded(false);
    dom.updatesToggle.addEventListener('click', () => {
      const expanded = dom.updatesToggle.getAttribute('aria-expanded') === 'true';
      setUpdatesExpanded(!expanded);
    });
  } catch {
    dom.updatesSection.classList.add('hidden');
  }
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

function loadAudioLayerState(): void {
  const raw = localStorage.getItem(AUDIO_LAYER_STATE_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<AudioLayerState>;
      audioLayers = {
        voice: parsed.voice !== false,
        item: parsed.item !== false,
        media: parsed.media !== false,
        world: parsed.world !== false,
      };
    } catch {
      // Ignore malformed persisted values.
    }
  }
  audio.setVoiceLayerEnabled(audioLayers.voice);
}

function persistAudioLayerState(): void {
  localStorage.setItem(AUDIO_LAYER_STATE_STORAGE_KEY, JSON.stringify(audioLayers));
}

function clampMicInputGain(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(MIC_CALIBRATION_MIN_GAIN, Math.min(MIC_CALIBRATION_MAX_GAIN, value));
}

function loadMicInputGain(): void {
  const raw = localStorage.getItem(MIC_INPUT_GAIN_STORAGE_KEY);
  if (!raw) {
    audio.setOutboundInputGain(2);
    return;
  }
  const parsed = Number(raw);
  audio.setOutboundInputGain(clampMicInputGain(parsed));
}

function persistMicInputGain(value: number): void {
  localStorage.setItem(MIC_INPUT_GAIN_STORAGE_KEY, String(value));
}

async function applyAudioLayerState(): Promise<void> {
  audio.setVoiceLayerEnabled(audioLayers.voice);
  if (audioLayers.voice) {
    await peerManager.resumeRemoteAudio();
  } else {
    peerManager.suspendRemoteAudio();
  }
  await radioRuntime.setLayerEnabled(audioLayers.media, state.items.values());
  await itemEmitRuntime.setLayerEnabled(audioLayers.item, state.items.values());
}

function toggleAudioLayer(layer: keyof AudioLayerState): void {
  audioLayers = { ...audioLayers, [layer]: !audioLayers[layer] };
  persistAudioLayerState();
  void applyAudioLayerState();
  updateStatus(`${layer} layer ${audioLayers[layer] ? 'on' : 'off'}.`);
  audio.sfxUiBlip();
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
  if (/^https?:/i.test(raw)) {
    return shouldProxyStreamUrl(raw) ? getProxyUrlForStream(raw) : raw;
  }
  if (/^(data:|blob:)/i.test(raw)) return raw;
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

function itemLabel(item: WorldItem): string {
  return `${item.title} (${itemTypeLabel(item.type)})`;
}

function getItemSpatialConfig(item: WorldItem): { range: number; directional: boolean; facingDeg: number } {
  const global = getItemTypeGlobalProperties(item.type);
  const rawParamRange = Number(item.params.emitRange);
  const rawGlobalRange = Number(global.emitRange);
  const rawRange = Number.isFinite(rawParamRange) && rawParamRange > 0 ? rawParamRange : rawGlobalRange;
  const range = Number.isFinite(rawRange) && rawRange > 0 ? rawRange : 15;
  const directional = typeof item.params.directional === 'boolean' ? item.params.directional : global.directional === true;
  const rawFacing = Number(item.params.facing ?? 0);
  const facingDeg = Number.isFinite(rawFacing) ? normalizeDegrees(rawFacing) : 0;
  return { range, directional, facingDeg };
}

function openHelpViewer(): void {
  if (helpViewerLines.length === 0) {
    updateStatus('Help unavailable.');
    audio.sfxUiCancel();
    return;
  }
  state.mode = 'helpView';
  helpViewerIndex = 0;
  updateStatus(helpViewerLines[helpViewerIndex]);
  audio.sfxUiBlip();
}

function getItemsAtPosition(x: number, y: number): WorldItem[] {
  return Array.from(state.items.values()).filter((item) => !item.carrierId && item.x === x && item.y === y);
}

function getCarriedItem(): WorldItem | null {
  if (!state.player.id) return null;
  return Array.from(state.items.values()).find((item) => item.carrierId === state.player.id) || null;
}

function beginItemSelection(context: 'pickup' | 'delete' | 'edit' | 'use' | 'inspect', items: WorldItem[]): void {
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

function beginItemProperties(item: WorldItem, showAll = false): void {
  state.selectedItemId = item.id;
  state.mode = 'itemProperties';
  state.editingPropertyKey = null;
  state.itemPropertyOptionValues = [];
  state.itemPropertyOptionIndex = 0;
  if (showAll) {
    state.itemPropertyKeys = getInspectItemPropertyKeys(item);
  } else {
    state.itemPropertyKeys = getEditableItemPropertyKeys(item);
  }
  state.itemPropertyIndex = 0;
  const key = state.itemPropertyKeys[0];
  const value = getItemPropertyValue(item, key);
  updateStatus(`${itemPropertyLabel(key)}: ${value}`);
  audio.sfxUiBlip();
}

function useItem(item: WorldItem): void {
  signaling.send({ type: 'item_use', itemId: item.id });
}

function openItemPropertyOptionSelect(item: WorldItem, key: string): void {
  const options = getItemPropertyOptionValues(key);
  if (!options || options.length === 0) {
    return;
  }
  state.mode = 'itemPropertyOptionSelect';
  state.editingPropertyKey = key;
  state.itemPropertyOptionValues = options;
  const currentValue = getItemPropertyValue(item, key);
  const currentIndex = options.indexOf(currentValue);
  state.itemPropertyOptionIndex = currentIndex >= 0 ? currentIndex : 0;
  updateStatus(`Select ${itemPropertyLabel(key)}: ${state.itemPropertyOptionValues[state.itemPropertyOptionIndex]}`);
  audio.sfxUiBlip();
}

function textInputMaxLengthForMode(mode: typeof state.mode): number | null {
  if (mode === 'nickname') return NICKNAME_MAX_LENGTH;
  if (mode === 'chat') return 500;
  if (mode === 'itemPropertyEdit') return 500;
  if (mode === 'micGainEdit') return 8;
  return null;
}

function pasteIntoActiveTextInput(raw: string): boolean {
  const maxLength = textInputMaxLengthForMode(state.mode);
  if (maxLength === null) {
    return false;
  }
  const result = applyPastedText(raw, state.nicknameInput, state.cursorPos, maxLength, replaceTextOnNextType);
  if (!result.handled) return false;
  state.nicknameInput = result.newString;
  state.cursorPos = result.newCursorPos;
  replaceTextOnNextType = result.replaceTextOnNextType;
  return true;
}

function isTextEditingMode(mode: typeof state.mode): boolean {
  return mode === 'nickname' || mode === 'chat' || mode === 'itemPropertyEdit' || mode === 'micGainEdit';
}

function applyTextInputEdit(code: string, key: string, maxLength: number, ctrlKey = false, allowReplaceOnNextType = false): void {
  if (ctrlKey && code === 'KeyA') {
    replaceTextOnNextType = true;
    state.cursorPos = state.nicknameInput.length;
    updateStatus(`${state.nicknameInput} selected`);
    return;
  }
  if (ctrlKey && code === 'ArrowLeft') {
    state.cursorPos = moveCursorWordLeft(state.nicknameInput, state.cursorPos);
    const spoken = describeCursorWordOrCharacter(state.nicknameInput, state.cursorPos);
    if (spoken) updateStatus(spoken);
    return;
  }
  if (ctrlKey && code === 'ArrowRight') {
    state.cursorPos = moveCursorWordRight(state.nicknameInput, state.cursorPos);
    const spoken = describeCursorWordOrCharacter(state.nicknameInput, state.cursorPos);
    if (spoken) updateStatus(spoken);
    return;
  }

  const beforeText = state.nicknameInput;
  const beforeCursor = state.cursorPos;
  const mappedKey = mapTextInputKey(code, key);

  const replaceDecision = shouldReplaceCurrentText(code, key, replaceTextOnNextType);
  replaceTextOnNextType = replaceDecision.replaceTextOnNextType;
  if (allowReplaceOnNextType && replaceDecision.shouldReplace) {
    state.nicknameInput = key;
    state.cursorPos = key.length;
    return;
  }

  const result = applyTextInput(mappedKey, state.nicknameInput, state.cursorPos, maxLength);
  state.nicknameInput = result.newString;
  state.cursorPos = result.newCursorPos;
  if (code === 'Backspace') {
    const spoken = describeBackspaceDeletedCharacter(beforeText, beforeCursor);
    if (spoken) updateStatus(spoken);
  }
  if (code === 'Delete') {
    const spoken = describeDeleteDeletedCharacter(beforeText, beforeCursor);
    if (spoken) updateStatus(spoken);
  }
  if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
    const spoken = describeCursorCharacter(state.nicknameInput, state.cursorPos);
    if (spoken) updateStatus(spoken);
  }
}

function getItemPropertyValue(item: WorldItem, key: string): string {
  const toSoundDisplayName = (rawValue: unknown): string => {
    const raw = String(rawValue ?? '').trim();
    if (!raw) return 'none';
    if (raw.toLowerCase() === 'none') return 'none';
    const withoutQuery = raw.split('?')[0].split('#')[0];
    const segments = withoutQuery.split('/').filter((part) => part.length > 0);
    return segments[segments.length - 1] ?? raw;
  };
  if (key === 'title') return item.title;
  if (key === 'type') return item.type;
  if (key === 'x') return String(item.x);
  if (key === 'y') return String(item.y);
  if (key === 'carrierId') return item.carrierId ?? 'none';
  if (key === 'version') return String(item.version);
  if (key === 'createdBy') return item.createdBy;
  if (key === 'createdAt') return formatTimestampMs(item.createdAt);
  if (key === 'updatedAt') return formatTimestampMs(item.updatedAt);
  if (key === 'capabilities') return item.capabilities.join(', ') || 'none';
  if (key === 'useSound') return toSoundDisplayName(item.params.useSound ?? item.useSound);
  if (key === 'emitSound') return toSoundDisplayName(item.params.emitSound ?? item.emitSound);
  if (key === 'enabled') return item.params.enabled === false ? 'off' : 'on';
  if (key === 'directional') {
    if (typeof item.params.directional === 'boolean') {
      return item.params.directional ? 'on' : 'off';
    }
    return getItemTypeGlobalProperties(item.type).directional === true ? 'on' : 'off';
  }
  if (key === 'timeZone') return String(item.params.timeZone ?? getDefaultClockTimeZone());
  if (key === 'use24Hour') return item.params.use24Hour === true ? 'on' : 'off';
  if (key === 'mediaChannel') return normalizeRadioChannel(item.params.mediaChannel);
  if (key === 'mediaEffect') return normalizeRadioEffect(item.params.mediaEffect);
  if (key === 'mediaEffectValue') return String(normalizeRadioEffectValue(item.params.mediaEffectValue));
  if (key === 'emitEffect') return normalizeRadioEffect(item.params.emitEffect);
  if (key === 'emitEffectValue') return String(normalizeRadioEffectValue(item.params.emitEffectValue));
  if (key === 'facing') {
    const parsed = Number(item.params.facing ?? 0);
    if (!Number.isFinite(parsed)) return '0';
    return String(Math.round(normalizeDegrees(parsed) * 10) / 10);
  }
  if (key === 'emitRange') {
    const parsed = Number(item.params.emitRange ?? getItemTypeGlobalProperties(item.type)?.emitRange ?? 15);
    if (!Number.isFinite(parsed)) return '15';
    return String(Math.round(parsed));
  }
  const paramValue = item.params[key];
  if (paramValue !== undefined) return String(paramValue);
  const globalValue = getItemTypeGlobalProperties(item.type)?.[key];
  if (globalValue !== undefined) return String(globalValue);
  return '';
}

function inferItemPropertyValueType(item: WorldItem, key: string): string | undefined {
  if (key === 'useSound' || key === 'emitSound') return 'sound';
  if (key === 'enabled' || key === 'use24Hour' || key === 'directional') return 'boolean';
  if (key === 'mediaChannel' || key === 'mediaEffect' || key === 'emitEffect' || key === 'timeZone') return 'list';
  if (
    key === 'x' ||
    key === 'y' ||
    key === 'version' ||
    key === 'mediaVolume' ||
    key === 'emitVolume' ||
    key === 'emitSoundSpeed' ||
    key === 'emitSoundTempo' ||
    key === 'mediaEffectValue' ||
    key === 'emitEffectValue' ||
    key === 'facing' ||
    key === 'emitRange' ||
    key === 'sides' ||
    key === 'number' ||
    key === 'useCooldownMs'
  ) {
    return 'number';
  }
  if (key in item.params || key in getItemTypeGlobalProperties(item.type)) {
    const value = item.params[key] ?? getItemTypeGlobalProperties(item.type)?.[key];
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') return 'text';
  }
  return 'text';
}

function getFallbackInspectPropertyTooltip(key: string): string | undefined {
  if (key === 'type') return 'The item type identifier.';
  if (key === 'x') return 'X coordinate on the grid.';
  if (key === 'y') return 'Y coordinate on the grid.';
  if (key === 'carrierId') return 'Current carrier user id, or none when on the ground.';
  if (key === 'version') return 'Server version for this item, incremented after each update.';
  if (key === 'createdBy') return 'User id of who created this item.';
  if (key === 'createdAt') return 'Timestamp when this item was created.';
  if (key === 'updatedAt') return 'Timestamp when this item was last updated.';
  if (key === 'capabilities') return 'Server-declared actions supported by this item.';
  if (key === 'useSound') return 'One-shot sound played when use succeeds.';
  if (key === 'emitSound') return 'Looping emitted sound source for this item.';
  if (key === 'useCooldownMs') return 'Global cooldown in milliseconds between uses.';
  if (key === 'directional') return 'Whether emitted audio favors item facing direction.';
  return undefined;
}

function isItemPropertyEditable(item: WorldItem, key: string): boolean {
  return getEditableItemPropertyKeys(item).includes(key);
}

function describeItemPropertyHelp(item: WorldItem, key: string): string {
  const metadata = getItemPropertyMetadata(item.type, key);
  const parts: string[] = [];
  const tooltip = metadata?.tooltip ?? getFallbackInspectPropertyTooltip(key);
  if (tooltip) {
    parts.push(tooltip);
  } else {
    parts.push('No tooltip available.');
  }

  const valueType = metadata?.valueType ?? inferItemPropertyValueType(item, key);
  if (valueType) {
    parts.push(`Type: ${valueType}.`);
  }

  if (metadata?.range) {
    const stepText = metadata.range.step !== undefined ? ` step ${metadata.range.step}` : '';
    parts.push(`Range: ${metadata.range.min} to ${metadata.range.max}${stepText}.`);
  } else {
    const options = getItemPropertyOptionValues(key);
    if (options && options.length > 0) {
      parts.push(`Options: ${options.join(', ')}.`);
    }
  }

  if (metadata?.maxLength !== undefined) {
    parts.push(`Max length: ${metadata.maxLength} characters.`);
  }

  parts.push(isItemPropertyEditable(item, key) ? 'Editable.' : 'Read only.');
  return parts.join(' ');
}

function validateNumericItemPropertyInput(
  item: WorldItem,
  key: string,
  rawValue: string,
  requireInteger: boolean,
): { ok: true; value: number } | { ok: false; message: string } {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: `${itemPropertyLabel(key)} must be a number.` };
  }
  if (requireInteger && !Number.isInteger(parsed)) {
    return { ok: false, message: `${itemPropertyLabel(key)} must be an integer.` };
  }
  const range = getItemPropertyMetadata(item.type, key)?.range;
  if (range && (parsed < range.min || parsed > range.max)) {
    return { ok: false, message: `${itemPropertyLabel(key)} must be between ${range.min} and ${range.max}.` };
  }
  if (!range) {
    return { ok: true, value: parsed };
  }
  const step = range.step;
  if (step && step > 0) {
    const normalized = snapNumberToStep(parsed, step, range.min);
    return { ok: true, value: normalized };
  }
  return { ok: true, value: parsed };
}

function squareWord(distance: number): string {
  return distance === 1 ? 'square' : 'squares';
}

function distanceDirectionPhrase(px: number, py: number, tx: number, ty: number): string {
  const distance = Math.round(Math.hypot(tx - px, ty - py));
  const direction = getDirection(px, py, tx, ty);
  if (direction === 'here') return 'here';
  return `${distance} ${squareWord(distance)} ${direction}`;
}

function persistPlayerPosition(): void {
  try {
    localStorage.setItem(
      'spatialChatPosition',
      JSON.stringify({ x: state.player.x, y: state.player.y }),
    );
  } catch {
    // Ignore storage failures (private mode/quota/blocked storage).
  }
}

function randomFootstepUrl(): string {
  return FOOTSTEP_SOUND_URLS[Math.floor(Math.random() * FOOTSTEP_SOUND_URLS.length)];
}

function gameLoop(): void {
  if (!state.running) return;
  handleMovement();
  audio.updateSpatialAudio(peerManager.getPeers(), { x: state.player.x, y: state.player.y });
  radioRuntime.updateSpatialAudio(state.items, { x: state.player.x, y: state.player.y });
  itemEmitRuntime.updateSpatialAudio(state.items, { x: state.player.x, y: state.player.y });
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

  if (dx === 0 && dy === 0) {
    lastWallCollisionDirection = null;
    return;
  }

  const nextX = state.player.x + dx;
  const nextY = state.player.y + dy;
  const attemptedDirection = `${dx},${dy}`;
  if (nextX < 0 || nextY < 0 || nextX >= worldGridSize || nextY >= worldGridSize) {
    state.player.lastMoveTime = now;
    if (lastWallCollisionDirection !== attemptedDirection) {
      void audio.playSample(WALL_SOUND_URL, 1);
      lastWallCollisionDirection = attemptedDirection;
    }
    return;
  }

  state.player.x = nextX;
  state.player.y = nextY;
  lastWallCollisionDirection = null;
  persistPlayerPosition();
  state.player.lastMoveTime = now;
  void audio.playSample(randomFootstepUrl(), FOOTSTEP_GAIN);
  signaling.send({ type: 'update_position', x: nextX, y: nextY });

  const namesOnTile = getPeerNamesAtPosition(nextX, nextY);
  const itemsOnTile = getItemsAtPosition(nextX, nextY);
  const tileAnnouncements: string[] = [];
  if (namesOnTile.length > 0) {
    tileAnnouncements.push(namesOnTile.join(', '));
    audio.sfxTileUserPing();
  }
  if (itemsOnTile.length > 0) {
    tileAnnouncements.push(itemsOnTile.map((item) => itemLabel(item)).join(', '));
    audio.sfxTileItemPing();
  }
  if (tileAnnouncements.length > 0) {
    updateStatus(tileAnnouncements.join('. '));
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

async function calibrateMicInputGain(): Promise<void> {
  if (calibratingMicInput) {
    updateStatus('Mic calibration already running.');
    return;
  }
  if (!state.running || !localStream) {
    updateStatus('Connect first, then use Shift+C to calibrate.');
    audio.sfxUiCancel();
    return;
  }
  const track = localStream.getAudioTracks()[0];
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

  calibratingMicInput = true;
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
    while (performance.now() - startedAt < MIC_CALIBRATION_DURATION_MS) {
      analyser.getFloatTimeDomainData(samples);
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i];
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / samples.length);
      rmsValues.push(rms);
      await new Promise((resolve) => window.setTimeout(resolve, MIC_CALIBRATION_SAMPLE_INTERVAL_MS));
    }
  } finally {
    source.disconnect();
    analyser.disconnect();
    calibratingMicInput = false;
  }

  const activeRms = rmsValues.filter((value) => value >= MIC_CALIBRATION_ACTIVE_RMS_THRESHOLD);
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

  const calibratedGain = clampMicInputGain((MIC_CALIBRATION_TARGET_RMS / observedRms) * MIC_INPUT_GAIN_SCALE_MULTIPLIER);
  const roundedGain = clampMicInputGain(snapNumberToStep(calibratedGain, MIC_INPUT_GAIN_STEP, MIC_CALIBRATION_MIN_GAIN));
  const appliedGain = audio.setOutboundInputGain(roundedGain);
  persistMicInputGain(appliedGain);
  updateStatus(`Mic calibration set to ${formatSteppedNumber(appliedGain, MIC_INPUT_GAIN_STEP)}x.`);
  audio.sfxUiConfirm();
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

  state.player.x = Math.floor(Math.random() * worldGridSize);
  state.player.y = Math.floor(Math.random() * worldGridSize);
  const storedPosition = localStorage.getItem('spatialChatPosition');
  if (storedPosition) {
    try {
      const parsed = JSON.parse(storedPosition) as { x?: number; y?: number };
      if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        const x = Math.floor(parsed.x as number);
        const y = Math.floor(parsed.y as number);
        if (x >= 0 && x < worldGridSize && y >= 0 && y < worldGridSize) {
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
    persistPlayerPosition();
  }

  signaling.disconnect();
  stopLocalMedia();

  peerManager.cleanupAll();
  radioRuntime.cleanupAll();
  itemEmitRuntime.cleanupAll();
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
  state.itemPropertyOptionValues = [];
  state.itemPropertyOptionIndex = 0;
  state.effectSelectIndex = 0;
  pendingEscapeDisconnect = false;

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
      if (message.worldConfig?.gridSize && Number.isInteger(message.worldConfig.gridSize) && message.worldConfig.gridSize > 0) {
        worldGridSize = message.worldConfig.gridSize;
      }
      renderer.setGridSize(worldGridSize);
      applyServerItemUiDefinitions(message.uiDefinitions);
      state.addItemTypeIndex = 0;
      state.player.id = message.id;
      state.running = true;
      connecting = false;
      state.player.x = Math.max(0, Math.min(worldGridSize - 1, state.player.x));
      state.player.y = Math.max(0, Math.min(worldGridSize - 1, state.player.y));
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
      await radioRuntime.sync(state.items.values());
      await itemEmitRuntime.sync(state.items.values());
      await applyAudioLayerState();

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
      const prevX = peer?.x ?? message.x;
      const prevY = peer?.y ?? message.y;
      if (peer) {
        peer.x = message.x;
        peer.y = message.y;
      }
      peerManager.setPeerPosition(message.id, message.x, message.y);
      if (peer) {
        const movementDelta = Math.hypot(message.x - prevX, message.y - prevY);
        const soundUrl = movementDelta > 1.5 ? TELEPORT_SOUND_URL : randomFootstepUrl();
        if (audioLayers.world) {
          void audio.playSpatialSample(
            soundUrl,
            { x: peer.x - state.player.x, y: peer.y - state.player.y },
            FOOTSTEP_GAIN,
          );
        }
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
          updateStatus(`${itemPropertyLabel(key)}: ${getItemPropertyValue(message.item, key)}`);
        }
      }
      await radioRuntime.sync(state.items.values());
      await itemEmitRuntime.sync(state.items.values());
      break;
    }

    case 'item_remove': {
      state.items.delete(message.itemId);
      state.carriedItemId = getCarriedItem()?.id ?? null;
      radioRuntime.cleanup(message.itemId);
      itemEmitRuntime.cleanup(message.itemId);
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
      if (audioLayers.world) {
        void audio.playSpatialSample(
          soundUrl,
          { x: message.x - state.player.x, y: message.y - state.player.y },
          1,
        );
      }
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
  if (code !== 'Escape' && pendingEscapeDisconnect) {
    pendingEscapeDisconnect = false;
  }

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

  if (code === 'Digit1' && shiftKey) {
    const enabled = audio.toggleLoopback();
    updateStatus(enabled ? 'Loopback on.' : 'Loopback off.');
    audio.sfxUiBlip();
    return;
  }

  if (code === 'Digit1') {
    toggleAudioLayer('voice');
    return;
  }

  if (code === 'Digit2') {
    toggleAudioLayer('item');
    return;
  }

  if (code === 'Digit3') {
    toggleAudioLayer('media');
    return;
  }

  if (code === 'Digit4') {
    toggleAudioLayer('world');
    return;
  }

  if (code === 'KeyE') {
    const currentEffect = audio.getCurrentEffect();
    const currentIndex = EFFECT_SEQUENCE.findIndex((effect) => effect.id === currentEffect.id);
    state.effectSelectIndex = currentIndex >= 0 ? currentIndex : 0;
    state.mode = 'effectSelect';
    updateStatus(`Select effect: ${EFFECT_SEQUENCE[state.effectSelectIndex].label}`);
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

  if (code === 'KeyV') {
    if (shiftKey) {
      void calibrateMicInputGain();
      return;
    }
    state.mode = 'micGainEdit';
    state.nicknameInput = formatSteppedNumber(audio.getOutboundInputGain(), MIC_INPUT_GAIN_STEP);
    state.cursorPos = state.nicknameInput.length;
    replaceTextOnNextType = true;
    updateStatus(`Set volume: ${state.nicknameInput}`);
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
    const itemTypeSequence = getItemTypeSequence();
    if (itemTypeSequence.length === 0) {
      updateStatus('No item types available.');
      audio.sfxUiCancel();
      return;
    }
    state.addItemTypeIndex = Math.max(0, Math.min(state.addItemTypeIndex, itemTypeSequence.length - 1));
    state.mode = 'addItem';
    updateStatus(`Add item: ${itemTypeLabel(itemTypeSequence[state.addItemTypeIndex])}.`);
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
        updateStatus(
          `List: ${itemLabel(first)}, ${distanceDirectionPhrase(state.player.x, state.player.y, first.x, first.y)}, ${first.x}, ${first.y}`,
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
    updateStatus(
      `${itemLabel(item)}, ${distanceDirectionPhrase(state.player.x, state.player.y, item.x, item.y)}, ${item.x}, ${item.y}`,
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
    const carried = getCarriedItem();
    if (shiftKey) {
      if (squareItems.length === 0) {
        if (!carried) {
          updateStatus('No item to inspect.');
          audio.sfxUiCancel();
          return;
        }
        beginItemProperties(carried, true);
        return;
      }
      if (squareItems.length === 1) {
        beginItemProperties(squareItems[0], true);
        return;
      }
      beginItemSelection('inspect', squareItems);
      return;
    }

    if (squareItems.length === 0) {
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
        updateStatus(
          `List: ${first.nickname}, ${distanceDirectionPhrase(state.player.x, state.player.y, first.x, first.y)}, ${first.x}, ${first.y}`,
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
    updateStatus(
      `${peer.nickname}, ${distanceDirectionPhrase(state.player.x, state.player.y, peer.x, peer.y)}, ${peer.x}, ${peer.y}`,
    );
    return;
  }

  if (code === 'Slash' && shiftKey) {
    openHelpViewer();
    return;
  }

  if (code === 'Slash' && !shiftKey) {
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
    if (pendingEscapeDisconnect) {
      pendingEscapeDisconnect = false;
      disconnect();
      return;
    }
    pendingEscapeDisconnect = true;
    updateStatus('Press Escape again to disconnect.');
    audio.sfxUiCancel();
    return;
  }
}

function handleHelpViewModeInput(code: string): void {
  if (helpViewerLines.length === 0) {
    state.mode = 'normal';
    updateStatus('Help unavailable.');
    audio.sfxUiCancel();
    return;
  }

  if (code === 'ArrowDown') {
    helpViewerIndex = Math.min(helpViewerLines.length - 1, helpViewerIndex + 1);
    updateStatus(helpViewerLines[helpViewerIndex]);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'ArrowUp') {
    helpViewerIndex = Math.max(0, helpViewerIndex - 1);
    updateStatus(helpViewerLines[helpViewerIndex]);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Home') {
    helpViewerIndex = 0;
    updateStatus(helpViewerLines[helpViewerIndex]);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'End') {
    helpViewerIndex = helpViewerLines.length - 1;
    updateStatus(helpViewerLines[helpViewerIndex]);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Escape') {
    state.mode = 'normal';
    updateStatus('Closed help.');
    audio.sfxUiCancel();
  }
}

function handleChatModeInput(code: string, key: string, ctrlKey: boolean): void {
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

  applyTextInputEdit(code, key, 500, ctrlKey);
}

function handleMicGainEditModeInput(code: string, key: string, ctrlKey: boolean): void {
  if (code === 'ArrowUp' || code === 'ArrowDown') {
    const raw = Number(state.nicknameInput.trim());
    const base = Number.isFinite(raw) ? raw : audio.getOutboundInputGain();
    const delta = code === 'ArrowUp' ? MIC_INPUT_GAIN_STEP : -MIC_INPUT_GAIN_STEP;
    const attempted = snapNumberToStep(base + delta, MIC_INPUT_GAIN_STEP, MIC_CALIBRATION_MIN_GAIN);
    const next = clampMicInputGain(attempted);
    state.nicknameInput = formatSteppedNumber(next, MIC_INPUT_GAIN_STEP);
    state.cursorPos = state.nicknameInput.length;
    replaceTextOnNextType = false;
    updateStatus(state.nicknameInput);
    if (Math.abs(next - base) < 1e-9 || Math.abs(next - attempted) > 1e-9) {
      audio.sfxUiCancel();
    } else {
      audio.sfxUiBlip();
    }
    return;
  }

  if (code === 'Enter') {
    const value = Number(state.nicknameInput.trim());
    if (!Number.isFinite(value)) {
      updateStatus(`Volume must be between ${MIC_CALIBRATION_MIN_GAIN} and ${MIC_CALIBRATION_MAX_GAIN}.`);
      audio.sfxUiCancel();
      return;
    }
    const snapped = snapNumberToStep(value, MIC_INPUT_GAIN_STEP, MIC_CALIBRATION_MIN_GAIN);
    if (snapped < MIC_CALIBRATION_MIN_GAIN || snapped > MIC_CALIBRATION_MAX_GAIN) {
      updateStatus(`Volume must be between ${MIC_CALIBRATION_MIN_GAIN} and ${MIC_CALIBRATION_MAX_GAIN}.`);
      audio.sfxUiCancel();
      return;
    }
    const applied = audio.setOutboundInputGain(snapped);
    persistMicInputGain(applied);
    state.mode = 'normal';
    replaceTextOnNextType = false;
    updateStatus(`Volume set to ${formatSteppedNumber(applied, MIC_INPUT_GAIN_STEP)}.`);
    audio.sfxUiConfirm();
    return;
  }

  if (code === 'Escape') {
    state.mode = 'normal';
    replaceTextOnNextType = false;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
    return;
  }

  applyTextInputEdit(code, key, 8, ctrlKey, true);
}

function handleEffectSelectModeInput(code: string, key: string): void {
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.effectSelectIndex = cycleIndex(state.effectSelectIndex, EFFECT_SEQUENCE.length, code === 'ArrowDown' ? 'next' : 'prev');
    updateStatus(EFFECT_SEQUENCE[state.effectSelectIndex].label);
    audio.sfxUiBlip();
    return;
  }

  const nextByInitial = findNextIndexByInitial(
    EFFECT_SEQUENCE,
    state.effectSelectIndex,
    key,
    (effect) => effect.label,
  );
  if (nextByInitial >= 0) {
    state.effectSelectIndex = nextByInitial;
    updateStatus(EFFECT_SEQUENCE[state.effectSelectIndex].label);
    audio.sfxUiBlip();
    return;
  }

  if (code === 'Enter') {
    const selected = EFFECT_SEQUENCE[state.effectSelectIndex];
    const effect = audio.setOutboundEffect(selected.id);
    state.mode = 'normal';
    updateStatus(effect.label);
    audio.sfxUiBlip();
    return;
  }

  if (code === 'Escape') {
    state.mode = 'normal';
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

function handleListModeInput(code: string, key: string): void {
  if (state.sortedPeerIds.length === 0) {
    state.mode = 'normal';
    return;
  }

  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.listIndex = cycleIndex(state.listIndex, state.sortedPeerIds.length, code === 'ArrowDown' ? 'next' : 'prev');
    const peer = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!peer) return;
    updateStatus(
      `${peer.nickname}, ${distanceDirectionPhrase(state.player.x, state.player.y, peer.x, peer.y)}, ${peer.x}, ${peer.y}`,
    );
    return;
  }
  const nextByInitial = findNextIndexByInitial(
    state.sortedPeerIds,
    state.listIndex,
    key,
    (peerId) => state.peers.get(peerId)?.nickname ?? '',
  );
  if (nextByInitial >= 0) {
    state.listIndex = nextByInitial;
    const peer = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!peer) return;
    updateStatus(
      `${peer.nickname}, ${distanceDirectionPhrase(state.player.x, state.player.y, peer.x, peer.y)}, ${peer.x}, ${peer.y}`,
    );
    audio.sfxUiBlip();
    return;
  }

  if (code === 'Enter') {
    const peer = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!peer) return;
    if (state.player.x === peer.x && state.player.y === peer.y) {
      updateStatus('Already here.');
      return;
    }
    state.player.x = peer.x;
    state.player.y = peer.y;
    persistPlayerPosition();
    void audio.playSample(TELEPORT_SOUND_URL, FOOTSTEP_GAIN);
    signaling.send({ type: 'update_position', x: peer.x, y: peer.y });
    state.mode = 'normal';
    updateStatus(`Moved to ${peer.nickname}.`);
    return;
  }

  if (code === 'Escape') {
    state.mode = 'normal';
    updateStatus('Exit list mode.');
    audio.sfxUiCancel();
  }
}

function handleListItemsModeInput(code: string, key: string): void {
  if (state.sortedItemIds.length === 0) {
    state.mode = 'normal';
    return;
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.itemListIndex = cycleIndex(state.itemListIndex, state.sortedItemIds.length, code === 'ArrowDown' ? 'next' : 'prev');
    const item = state.items.get(state.sortedItemIds[state.itemListIndex]);
    if (!item) return;
    updateStatus(
      `${itemLabel(item)}, ${distanceDirectionPhrase(state.player.x, state.player.y, item.x, item.y)}, ${item.x}, ${item.y}`,
    );
    return;
  }
  const nextByInitial = findNextIndexByInitial(
    state.sortedItemIds,
    state.itemListIndex,
    key,
    (itemId) => {
      const item = state.items.get(itemId);
      return item ? itemLabel(item) : '';
    },
  );
  if (nextByInitial >= 0) {
    state.itemListIndex = nextByInitial;
    const item = state.items.get(state.sortedItemIds[state.itemListIndex]);
    if (!item) return;
    updateStatus(
      `${itemLabel(item)}, ${distanceDirectionPhrase(state.player.x, state.player.y, item.x, item.y)}, ${item.x}, ${item.y}`,
    );
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Enter') {
    const item = state.items.get(state.sortedItemIds[state.itemListIndex]);
    if (!item) return;
    if (state.player.x === item.x && state.player.y === item.y) {
      updateStatus('Already here.');
      return;
    }
    state.player.x = item.x;
    state.player.y = item.y;
    persistPlayerPosition();
    void audio.playSample(TELEPORT_SOUND_URL, FOOTSTEP_GAIN);
    signaling.send({ type: 'update_position', x: item.x, y: item.y });
    state.mode = 'normal';
    updateStatus(`Moved to ${itemLabel(item)}.`);
    return;
  }
  if (code === 'Escape') {
    state.mode = 'normal';
    updateStatus('Exit item list mode.');
    audio.sfxUiCancel();
  }
}

function handleAddItemModeInput(code: string, key: string): void {
  const itemTypeSequence = getItemTypeSequence();
  if (itemTypeSequence.length === 0) {
    state.mode = 'normal';
    updateStatus('No item types available.');
    audio.sfxUiCancel();
    return;
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.addItemTypeIndex = cycleIndex(state.addItemTypeIndex, itemTypeSequence.length, code === 'ArrowDown' ? 'next' : 'prev');
    updateStatus(`${itemTypeLabel(itemTypeSequence[state.addItemTypeIndex])}.`);
    audio.sfxUiBlip();
    return;
  }
  const nextByInitial = findNextIndexByInitial(
    itemTypeSequence,
    state.addItemTypeIndex,
    key,
    (itemType) => itemTypeLabel(itemType),
  );
  if (nextByInitial >= 0) {
    state.addItemTypeIndex = nextByInitial;
    updateStatus(`${itemTypeLabel(itemTypeSequence[state.addItemTypeIndex])}.`);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Space') {
    const itemType = itemTypeSequence[state.addItemTypeIndex];
    const tooltip = getItemTypeTooltip(itemType);
    updateStatus(tooltip ? tooltip : 'No tooltip available.');
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Enter') {
    signaling.send({ type: 'item_add', itemType: itemTypeSequence[state.addItemTypeIndex] });
    state.mode = 'normal';
    return;
  }
  if (code === 'Escape') {
    state.mode = 'normal';
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

function handleSelectItemModeInput(code: string, key: string): void {
  if (state.selectedItemIds.length === 0) {
    state.mode = 'normal';
    state.selectionContext = null;
    return;
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.selectedItemIndex = cycleIndex(state.selectedItemIndex, state.selectedItemIds.length, code === 'ArrowDown' ? 'next' : 'prev');
    const current = state.items.get(state.selectedItemIds[state.selectedItemIndex]);
    if (current) {
      updateStatus(itemLabel(current));
      audio.sfxUiBlip();
    }
    return;
  }
  const nextByInitial = findNextIndexByInitial(
    state.selectedItemIds,
    state.selectedItemIndex,
    key,
    (itemId) => {
      const item = state.items.get(itemId);
      return item ? itemLabel(item) : '';
    },
  );
  if (nextByInitial >= 0) {
    state.selectedItemIndex = nextByInitial;
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
    if (context === 'inspect') {
      beginItemProperties(selected, true);
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

function handleItemPropertiesModeInput(code: string, key: string): void {
  const itemId = state.selectedItemId;
  if (!itemId) {
    state.mode = 'normal';
    state.editingPropertyKey = null;
    state.itemPropertyOptionValues = [];
    state.itemPropertyOptionIndex = 0;
    return;
  }
  const item = state.items.get(itemId);
  if (!item) {
    state.mode = 'normal';
    state.editingPropertyKey = null;
    state.itemPropertyOptionValues = [];
    state.itemPropertyOptionIndex = 0;
    updateStatus('Item no longer exists.');
    audio.sfxUiCancel();
    return;
  }
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.itemPropertyIndex = cycleIndex(state.itemPropertyIndex, state.itemPropertyKeys.length, code === 'ArrowDown' ? 'next' : 'prev');
    const key = state.itemPropertyKeys[state.itemPropertyIndex];
    const value = getItemPropertyValue(item, key);
    updateStatus(`${itemPropertyLabel(key)}: ${value}`);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Space') {
    const selectedKey = state.itemPropertyKeys[state.itemPropertyIndex];
    updateStatus(describeItemPropertyHelp(item, selectedKey));
    audio.sfxUiBlip();
    return;
  }
  const nextByInitial = findNextIndexByInitial(
    state.itemPropertyKeys,
    state.itemPropertyIndex,
    key,
    (propertyKey) => propertyKey,
  );
  if (nextByInitial >= 0) {
    state.itemPropertyIndex = nextByInitial;
    const selectedKey = state.itemPropertyKeys[state.itemPropertyIndex];
    const value = getItemPropertyValue(item, selectedKey);
    updateStatus(`${itemPropertyLabel(selectedKey)}: ${value}`);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Enter') {
    const key = state.itemPropertyKeys[state.itemPropertyIndex];
    if (!isItemPropertyEditable(item, key)) {
      updateStatus(`${itemPropertyLabel(key)} is not editable.`);
      audio.sfxUiCancel();
      return;
    }
    if (key === 'enabled') {
      const nextEnabled = item.params.enabled === false;
      signaling.send({ type: 'item_update', itemId, params: { enabled: nextEnabled } });
      updateStatus(`enabled: ${nextEnabled ? 'on' : 'off'}`);
      audio.sfxUiBlip();
      return;
    }
    if (key === 'directional') {
      const nextDirectional = item.params.directional !== true;
      signaling.send({ type: 'item_update', itemId, params: { directional: nextDirectional } });
      updateStatus(`directional: ${nextDirectional ? 'on' : 'off'}`);
      audio.sfxUiBlip();
      return;
    }
    if (key === 'use24Hour') {
      const nextUse24Hour = item.params.use24Hour !== true;
      signaling.send({ type: 'item_update', itemId, params: { use24Hour: nextUse24Hour } });
      updateStatus(`${itemPropertyLabel(key)}: ${nextUse24Hour ? 'on' : 'off'}`);
      audio.sfxUiBlip();
      return;
    }
    if (getItemPropertyOptionValues(key)) {
      openItemPropertyOptionSelect(item, key);
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
    updateStatus(`Edit ${itemPropertyLabel(key)}: ${state.nicknameInput}`);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Escape') {
    state.mode = 'normal';
    state.selectedItemId = null;
    state.itemPropertyKeys = [];
    state.itemPropertyIndex = 0;
    state.editingPropertyKey = null;
    state.itemPropertyOptionValues = [];
    state.itemPropertyOptionIndex = 0;
    updateStatus('Closed item properties.');
    audio.sfxUiCancel();
  }
}

function handleItemPropertyEditModeInput(code: string, key: string, ctrlKey: boolean): void {
  const itemId = state.selectedItemId;
  const propertyKey = state.editingPropertyKey;
  if (!itemId || !propertyKey) {
    state.mode = 'normal';
    return;
  }
  const item = state.items.get(itemId);
  if (!item) {
    state.mode = 'normal';
    state.editingPropertyKey = null;
    updateStatus('Item no longer exists.');
    audio.sfxUiCancel();
    return;
  }
  if (code === 'ArrowUp' || code === 'ArrowDown') {
    const metadata = getItemPropertyMetadata(item.type, propertyKey);
    if (metadata?.valueType === 'number') {
      const range = metadata.range;
      const step = range?.step && range.step > 0 ? range.step : 1;
      const min = range?.min;
      const max = range?.max;
      const rawCurrent = Number(state.nicknameInput.trim());
      const paramCurrent = Number(item.params[propertyKey]);
      const currentValue = Number.isFinite(rawCurrent)
        ? rawCurrent
        : Number.isFinite(paramCurrent)
          ? paramCurrent
          : Number.isFinite(min)
            ? min
            : 0;
      const delta = code === 'ArrowUp' ? step : -step;
      const anchor = Number.isFinite(min) ? min : 0;
      const attempted = snapNumberToStep(currentValue + delta, step, anchor);
      let nextValue = attempted;
      if (Number.isFinite(min)) nextValue = Math.max(min, nextValue);
      if (Number.isFinite(max)) nextValue = Math.min(max, nextValue);
      state.nicknameInput = formatSteppedNumber(nextValue, step);
      state.cursorPos = state.nicknameInput.length;
      replaceTextOnNextType = false;
      updateStatus(state.nicknameInput);
      if (Math.abs(nextValue - currentValue) < 1e-9 || Math.abs(nextValue - attempted) > 1e-9) {
        audio.sfxUiCancel();
      } else {
        audio.sfxUiBlip();
      }
      return;
    }
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
    } else if (propertyKey === 'directional') {
      const normalized = value.toLowerCase();
      if (!['on', 'off', 'true', 'false', '1', '0', 'yes', 'no'].includes(normalized)) {
        updateStatus('directional must be on or off.');
        audio.sfxUiCancel();
        return;
      }
      const directional = ['on', 'true', '1', 'yes'].includes(normalized);
      signaling.send({ type: 'item_update', itemId, params: { directional } });
    } else if (propertyKey === 'mediaVolume') {
      const parsed = validateNumericItemPropertyInput(item, propertyKey, value, true);
      if (!parsed.ok) {
        updateStatus(parsed.message);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { mediaVolume: parsed.value } });
    } else if (propertyKey === 'emitVolume') {
      const parsed = validateNumericItemPropertyInput(item, propertyKey, value, true);
      if (!parsed.ok) {
        updateStatus(parsed.message);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { emitVolume: parsed.value } });
    } else if (propertyKey === 'emitSoundSpeed') {
      const parsed = validateNumericItemPropertyInput(item, propertyKey, value, true);
      if (!parsed.ok) {
        updateStatus(parsed.message);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { emitSoundSpeed: parsed.value } });
    } else if (propertyKey === 'emitSoundTempo') {
      const parsed = validateNumericItemPropertyInput(item, propertyKey, value, true);
      if (!parsed.ok) {
        updateStatus(parsed.message);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { emitSoundTempo: parsed.value } });
    } else if (propertyKey === 'mediaEffect' || propertyKey === 'emitEffect') {
      const normalized = value.trim().toLowerCase() as EffectId;
      if (!EFFECT_IDS.has(normalized)) {
        updateStatus(`${itemPropertyLabel(propertyKey)} must be one of: ${EFFECT_SEQUENCE.map((effect) => effect.id).join(', ')}.`);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { [propertyKey]: normalized } });
    } else if (propertyKey === 'mediaEffectValue' || propertyKey === 'emitEffectValue') {
      const parsed = validateNumericItemPropertyInput(item, propertyKey, value, false);
      if (!parsed.ok) {
        updateStatus(parsed.message);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { [propertyKey]: clampEffectLevel(parsed.value) } });
    } else if (propertyKey === 'facing') {
      const parsed = validateNumericItemPropertyInput(item, propertyKey, value, false);
      if (!parsed.ok) {
        updateStatus(parsed.message);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { facing: parsed.value } });
    } else if (propertyKey === 'emitRange') {
      const parsed = validateNumericItemPropertyInput(item, propertyKey, value, true);
      if (!parsed.ok) {
        updateStatus(parsed.message);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { emitRange: parsed.value } });
    } else if (propertyKey === 'useSound' || propertyKey === 'emitSound') {
      signaling.send({ type: 'item_update', itemId, params: { [propertyKey]: value } });
    } else if (propertyKey === 'spaces') {
      const spaces = value
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      if (spaces.length === 0) {
        updateStatus('spaces must include at least one comma-delimited value.');
        audio.sfxUiCancel();
        return;
      }
      if (spaces.length > 100) {
        updateStatus('spaces supports up to 100 values.');
        audio.sfxUiCancel();
        return;
      }
      if (spaces.some((token) => token.length > 80)) {
        updateStatus('each space must be 80 chars or less.');
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { spaces: spaces.join(', ') } });
    } else if (propertyKey === 'sides' || propertyKey === 'number') {
      const parsed = validateNumericItemPropertyInput(item, propertyKey, value, true);
      if (!parsed.ok) {
        updateStatus(parsed.message);
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { [propertyKey]: parsed.value } });
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
  applyTextInputEdit(code, key, 500, ctrlKey, true);
}

function handleItemPropertyOptionSelectModeInput(code: string, key: string): void {
  const itemId = state.selectedItemId;
  const propertyKey = state.editingPropertyKey;
  if (!itemId || !propertyKey || state.itemPropertyOptionValues.length === 0) {
    state.mode = 'itemProperties';
    state.editingPropertyKey = null;
    state.itemPropertyOptionValues = [];
    state.itemPropertyOptionIndex = 0;
    return;
  }

  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.itemPropertyOptionIndex = cycleIndex(
      state.itemPropertyOptionIndex,
      state.itemPropertyOptionValues.length,
      code === 'ArrowDown' ? 'next' : 'prev',
    );
    updateStatus(state.itemPropertyOptionValues[state.itemPropertyOptionIndex]);
    audio.sfxUiBlip();
    return;
  }
  const nextByInitial = findNextIndexByInitial(
    state.itemPropertyOptionValues,
    state.itemPropertyOptionIndex,
    key,
    (value) => value,
  );
  if (nextByInitial >= 0) {
    state.itemPropertyOptionIndex = nextByInitial;
    updateStatus(state.itemPropertyOptionValues[state.itemPropertyOptionIndex]);
    audio.sfxUiBlip();
    return;
  }

  if (code === 'Enter') {
    const selectedValue = state.itemPropertyOptionValues[state.itemPropertyOptionIndex];
    signaling.send({ type: 'item_update', itemId, params: { [propertyKey]: selectedValue } });
    state.mode = 'itemProperties';
    state.editingPropertyKey = null;
    state.itemPropertyOptionValues = [];
    state.itemPropertyOptionIndex = 0;
    return;
  }

  if (code === 'Escape') {
    state.mode = 'itemProperties';
    state.editingPropertyKey = null;
    state.itemPropertyOptionValues = [];
    state.itemPropertyOptionIndex = 0;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

function handleNicknameModeInput(code: string, key: string, ctrlKey: boolean): void {
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

  applyTextInputEdit(code, key, NICKNAME_MAX_LENGTH, ctrlKey, true);
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
    if (event.altKey) return;
    if (event.ctrlKey && !isTextEditingMode(state.mode)) return;

    const isNativePasteShortcut = event.ctrlKey && isTextEditingMode(state.mode) && code === 'KeyV';
    if ((state.mode !== 'normal' || !code.startsWith('Arrow')) && !isNativePasteShortcut) {
      event.preventDefault();
    }

    if (event.ctrlKey && isTextEditingMode(state.mode)) {
      if (code === 'KeyV') {
        return;
      }
      if (code === 'KeyC') {
        const text = state.nicknameInput;
        internalClipboardText = text;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        updateStatus('copied');
        return;
      }
      if (code === 'KeyX') {
        const text = state.nicknameInput;
        internalClipboardText = text;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        state.nicknameInput = '';
        state.cursorPos = 0;
        replaceTextOnNextType = false;
        updateStatus('cut');
        return;
      }
    }

    if (isTypingKey(code) && state.keysPressed[code]) return;

    if (state.mode === 'nickname') {
      handleNicknameModeInput(code, event.key, event.ctrlKey);
    } else if (state.mode === 'chat') {
      handleChatModeInput(code, event.key, event.ctrlKey);
    } else if (state.mode === 'micGainEdit') {
      handleMicGainEditModeInput(code, event.key, event.ctrlKey);
    } else if (state.mode === 'effectSelect') {
      handleEffectSelectModeInput(code, event.key);
    } else if (state.mode === 'helpView') {
      handleHelpViewModeInput(code);
    } else if (state.mode === 'listUsers') {
      handleListModeInput(code, event.key);
    } else if (state.mode === 'listItems') {
      handleListItemsModeInput(code, event.key);
    } else if (state.mode === 'addItem') {
      handleAddItemModeInput(code, event.key);
    } else if (state.mode === 'selectItem') {
      handleSelectItemModeInput(code, event.key);
    } else if (state.mode === 'itemProperties') {
      handleItemPropertiesModeInput(code, event.key);
    } else if (state.mode === 'itemPropertyEdit') {
      handleItemPropertyEditModeInput(code, event.key, event.ctrlKey);
    } else if (state.mode === 'itemPropertyOptionSelect') {
      handleItemPropertyOptionSelectModeInput(code, event.key);
    } else {
      handleNormalModeInput(code, event.shiftKey);
    }

    state.keysPressed[code] = true;
  });

  document.addEventListener('keyup', (event) => {
    state.keysPressed[event.code] = false;
  });

  document.addEventListener('paste', (event) => {
    if (document.activeElement !== dom.canvas) return;
    if (!state.running) return;
    const pasted = event.clipboardData?.getData('text') ?? internalClipboardText;
    if (!pasteIntoActiveTextInput(pasted)) return;
    event.preventDefault();
    updateStatus('pasted');
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
  const persistOnUnload = (): void => {
    if (!state.running) return;
    persistPlayerPosition();
  };
  window.addEventListener('pagehide', persistOnUnload);
  window.addEventListener('beforeunload', persistOnUnload);

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
