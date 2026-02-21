import './styles.css';
import { AudioEngine } from './audio/audioEngine';
import {
  EFFECT_IDS,
  EFFECT_SEQUENCE,
  clampEffectLevel,
  type EffectId,
} from './audio/effects';
import { RADIO_CHANNEL_OPTIONS, RadioStationRuntime, normalizeRadioChannel, normalizeRadioEffect, normalizeRadioEffectValue } from './audio/radioStationRuntime';
import { applyTextInput } from './input/textInput';
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
const DEFAULT_DISPLAY_TIME_ZONE = 'America/Detroit';
const NICKNAME_STORAGE_KEY = 'spatialChatNickname';
const NICKNAME_MAX_LENGTH = 32;

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

const APP_VERSION = String(window.CHGRID_WEB_VERSION ?? '').trim();
const DISPLAY_TIME_ZONE = resolveDisplayTimeZone();
dom.appVersion.textContent = APP_VERSION
  ? `Another AI experiment with Jage. Version ${APP_VERSION}`
  : 'Another AI experiment with Jage. Version unknown';
const ITEM_TYPE_SEQUENCE: ItemType[] = ['radio_station', 'dice', 'wheel'];
const ITEM_TYPE_GLOBAL_PROPERTIES: Record<ItemType, Record<string, string | number | boolean>> = {
  radio_station: { useCooldownMs: 1000 },
  dice: { useCooldownMs: 1000 },
  wheel: { useCooldownMs: 4000 },
};
const EDITABLE_ITEM_PROPERTY_KEYS = new Set([
  'title',
  'streamUrl',
  'enabled',
  'channel',
  'volume',
  'effect',
  'effectValue',
  'spaces',
  'sides',
  'number',
]);
const OPTION_ITEM_PROPERTY_VALUES: Partial<Record<string, string[]>> = {
  effect: EFFECT_SEQUENCE.map((effect) => effect.id),
  channel: [...RADIO_CHANNEL_OPTIONS],
};
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
const radioRuntime = new RadioStationRuntime(audio);
let replaceTextOnNextType = false;
let pendingEscapeDisconnect = false;

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
  if (type === 'radio_station') return 'radio';
  return type;
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

function getEditableItemPropertyKeys(item: WorldItem): string[] {
  const keys = ['title'];
  if (item.type === 'radio_station') {
    keys.push('streamUrl', 'enabled', 'channel', 'volume', 'effect', 'effectValue');
  } else if (item.type === 'dice') {
    keys.push('sides', 'number');
  } else if (item.type === 'wheel') {
    keys.push('spaces');
  }
  return keys;
}

function getInspectItemPropertyKeys(item: WorldItem): string[] {
  const editableKeys = getEditableItemPropertyKeys(item);
  const seen = new Set(editableKeys);
  const allKeys: string[] = [...editableKeys];

  const baseKeys = ['type', 'x', 'y', 'carrierId', 'version', 'createdBy', 'createdAt', 'updatedAt', 'capabilities', 'useSound'];
  for (const key of baseKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  const paramKeys = Object.keys(item.params).sort((a, b) => a.localeCompare(b));
  for (const key of paramKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  const globalKeys = Object.keys(ITEM_TYPE_GLOBAL_PROPERTIES[item.type] ?? {}).sort((a, b) => a.localeCompare(b));
  for (const key of globalKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  return allKeys;
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
  updateStatus(`${key}: ${value}`);
  audio.sfxUiBlip();
}

function useItem(item: WorldItem): void {
  signaling.send({ type: 'item_use', itemId: item.id });
}

function openItemPropertyOptionSelect(item: WorldItem, key: string): void {
  const options = OPTION_ITEM_PROPERTY_VALUES[key];
  if (!options || options.length === 0) {
    return;
  }
  state.mode = 'itemPropertyOptionSelect';
  state.editingPropertyKey = key;
  state.itemPropertyOptionValues = options;
  const currentValue = getItemPropertyValue(item, key);
  const currentIndex = options.indexOf(currentValue);
  state.itemPropertyOptionIndex = currentIndex >= 0 ? currentIndex : 0;
  updateStatus(`Select ${key}: ${state.itemPropertyOptionValues[state.itemPropertyOptionIndex]}`);
  audio.sfxUiBlip();
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

function textInputMaxLengthForMode(mode: typeof state.mode): number | null {
  if (mode === 'nickname') return NICKNAME_MAX_LENGTH;
  if (mode === 'chat') return 500;
  if (mode === 'itemPropertyEdit') return 500;
  return null;
}

function normalizePastedText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, ' ')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

function pasteIntoActiveTextInput(raw: string): boolean {
  const maxLength = textInputMaxLengthForMode(state.mode);
  if (maxLength === null) {
    return false;
  }
  const text = normalizePastedText(raw);
  if (!text) {
    return true;
  }
  const available = Math.max(0, maxLength - state.nicknameInput.length);
  if (available <= 0) {
    return true;
  }
  const insert = text.slice(0, available);
  state.nicknameInput =
    state.nicknameInput.slice(0, state.cursorPos) + insert + state.nicknameInput.slice(state.cursorPos);
  state.cursorPos += insert.length;
  replaceTextOnNextType = false;
  return true;
}

function mapTextInputKey(code: string, key: string): string {
  if (code === 'ArrowLeft') return 'arrowleft';
  if (code === 'ArrowRight') return 'arrowright';
  if (code === 'Backspace') return 'backspace';
  if (code === 'Home') return 'home';
  if (code === 'End') return 'end';
  return key;
}

function applyTextInputEdit(code: string, key: string, maxLength: number, allowReplaceOnNextType = false): void {
  const beforeText = state.nicknameInput;
  const beforeCursor = state.cursorPos;
  const mappedKey = mapTextInputKey(code, key);

  if (allowReplaceOnNextType && shouldReplaceCurrentText(code, key)) {
    state.nicknameInput = key;
    state.cursorPos = key.length;
    return;
  }

  const result = applyTextInput(mappedKey, state.nicknameInput, state.cursorPos, maxLength);
  state.nicknameInput = result.newString;
  state.cursorPos = result.newCursorPos;
  if (code === 'Backspace') {
    announceBackspaceDeletedCharacter(beforeText, beforeCursor);
  }
  if (code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Home' || code === 'End') {
    announceCursorCharacter(state.nicknameInput, state.cursorPos);
  }
}

function describeCharacter(ch: string): string {
  if (ch === ' ') return 'space';
  if (ch === '\t') return 'tab';
  if (ch === '.') return 'period';
  if (ch === ',') return 'comma';
  if (ch === ':') return 'colon';
  if (ch === ';') return 'semicolon';
  if (ch === '!') return 'exclamation mark';
  if (ch === '?') return 'question mark';
  if (ch === "'") return 'apostrophe';
  if (ch === '"') return 'quote';
  if (ch === '/') return 'slash';
  if (ch === '\\') return 'backslash';
  if (ch === '-') return 'dash';
  if (ch === '_') return 'underscore';
  if (ch === '=') return 'equals';
  if (ch === '+') return 'plus';
  if (ch === '*') return 'asterisk';
  if (ch === '&') return 'ampersand';
  if (ch === '@') return 'at sign';
  if (ch === '#') return 'hash';
  if (ch === '%') return 'percent';
  if (ch === '$') return 'dollar sign';
  if (ch === '^') return 'caret';
  if (ch === '|') return 'pipe';
  if (ch === '~') return 'tilde';
  if (ch === '`') return 'backtick';
  if (ch === '(') return 'left parenthesis';
  if (ch === ')') return 'right parenthesis';
  if (ch === '[') return 'left bracket';
  if (ch === ']') return 'right bracket';
  if (ch === '{') return 'left brace';
  if (ch === '}') return 'right brace';
  if (ch === '<') return 'less than';
  if (ch === '>') return 'greater than';
  return ch;
}

function getItemPropertyValue(item: WorldItem, key: string): string {
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
  if (key === 'useSound') return item.useSound ?? 'none';
  if (key === 'enabled') return item.params.enabled === false ? 'off' : 'on';
  if (key === 'channel') return normalizeRadioChannel(item.params.channel);
  if (key === 'effect') return normalizeRadioEffect(item.params.effect);
  if (key === 'effectValue') return String(normalizeRadioEffectValue(item.params.effectValue));
  const globalValue = ITEM_TYPE_GLOBAL_PROPERTIES[item.type]?.[key];
  if (globalValue !== undefined) return String(globalValue);
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
  if (nextX < 0 || nextY < 0 || nextX >= GRID_SIZE || nextY >= GRID_SIZE) {
    state.player.lastMoveTime = now;
    void audio.playSample(WALL_SOUND_URL, 1);
    return;
  }

  state.player.x = nextX;
  state.player.y = nextY;
  persistPlayerPosition();
  state.player.lastMoveTime = now;
  void audio.playSample(randomFootstepUrl(), FOOTSTEP_GAIN);
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
    persistPlayerPosition();
  }

  signaling.disconnect();
  stopLocalMedia();

  peerManager.cleanupAll();
  radioRuntime.cleanupAll();
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
      await radioRuntime.sync(state.items.values());

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
        void audio.playSpatialSample(
          soundUrl,
          { x: peer.x - state.player.x, y: peer.y - state.player.y },
          FOOTSTEP_GAIN,
        );
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
      await radioRuntime.sync(state.items.values());
      break;
    }

    case 'item_remove': {
      state.items.delete(message.itemId);
      state.carriedItemId = getCarriedItem()?.id ?? null;
      radioRuntime.cleanup(message.itemId);
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

  applyTextInputEdit(code, key, 500);
}

function handleEffectSelectModeInput(code: string, key: string): void {
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.effectSelectIndex =
      code === 'ArrowDown'
        ? (state.effectSelectIndex + 1) % EFFECT_SEQUENCE.length
        : (state.effectSelectIndex - 1 + EFFECT_SEQUENCE.length) % EFFECT_SEQUENCE.length;
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
    const distance = Math.round(Math.hypot(peer.x - state.player.x, peer.y - state.player.y));
    updateStatus(
      `${peer.nickname}, ${distance} ${squareWord(distance)} ${getDirection(state.player.x, state.player.y, peer.x, peer.y)}, ${peer.x}, ${peer.y}`,
    );
    audio.sfxUiBlip();
    return;
  }

  if (code === 'Enter') {
    const peer = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!peer) return;
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
    const distance = Math.round(Math.hypot(item.x - state.player.x, item.y - state.player.y));
    updateStatus(
      `${itemLabel(item)}, ${distance} ${squareWord(distance)} ${getDirection(state.player.x, state.player.y, item.x, item.y)}, ${item.x}, ${item.y}`,
    );
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Enter') {
    const item = state.items.get(state.sortedItemIds[state.itemListIndex]);
    if (!item) return;
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
  if (code === 'ArrowDown' || code === 'ArrowUp') {
    state.addItemTypeIndex =
      code === 'ArrowDown'
        ? (state.addItemTypeIndex + 1) % ITEM_TYPE_SEQUENCE.length
        : (state.addItemTypeIndex - 1 + ITEM_TYPE_SEQUENCE.length) % ITEM_TYPE_SEQUENCE.length;
    updateStatus(`${itemTypeLabel(ITEM_TYPE_SEQUENCE[state.addItemTypeIndex])}.`);
    audio.sfxUiBlip();
    return;
  }
  const nextByInitial = findNextIndexByInitial(
    ITEM_TYPE_SEQUENCE,
    state.addItemTypeIndex,
    key,
    (itemType) => itemTypeLabel(itemType),
  );
  if (nextByInitial >= 0) {
    state.addItemTypeIndex = nextByInitial;
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

function handleSelectItemModeInput(code: string, key: string): void {
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
    updateStatus(`${selectedKey}: ${value}`);
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Enter') {
    const key = state.itemPropertyKeys[state.itemPropertyIndex];
    if (!EDITABLE_ITEM_PROPERTY_KEYS.has(key)) {
      updateStatus(`${key} is not editable.`);
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
    if (OPTION_ITEM_PROPERTY_VALUES[key]) {
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
    updateStatus(`Edit ${key}: ${state.nicknameInput}`);
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
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        updateStatus('effectValue must be a number between 0 and 100.');
        audio.sfxUiCancel();
        return;
      }
      signaling.send({ type: 'item_update', itemId, params: { effectValue: clampEffectLevel(parsed) } });
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
  applyTextInputEdit(code, key, 500, true);
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
    state.itemPropertyOptionIndex =
      code === 'ArrowDown'
        ? (state.itemPropertyOptionIndex + 1) % state.itemPropertyOptionValues.length
        : (state.itemPropertyOptionIndex - 1 + state.itemPropertyOptionValues.length) % state.itemPropertyOptionValues.length;
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

  applyTextInputEdit(code, key, NICKNAME_MAX_LENGTH, true);
}

function isTypingKey(code: string): boolean {
  return code.startsWith('Key') || code === 'Space';
}

function findNextIndexByInitial<T>(
  entries: readonly T[],
  currentIndex: number,
  key: string,
  labelFor: (entry: T) => string,
): number {
  if (entries.length === 0 || key.length !== 1 || !/[a-z]/i.test(key)) {
    return -1;
  }
  const target = key.toLowerCase();
  for (let step = 1; step <= entries.length; step += 1) {
    const candidateIndex = (currentIndex + step) % entries.length;
    const label = labelFor(entries[candidateIndex]).trim().toLowerCase();
    if (label.startsWith(target)) {
      return candidateIndex;
    }
  }
  return -1;
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
    } else if (state.mode === 'effectSelect') {
      handleEffectSelectModeInput(code, event.key);
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
      handleItemPropertyEditModeInput(code, event.key);
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
    const pasted = event.clipboardData?.getData('text') ?? '';
    if (!pasteIntoActiveTextInput(pasted)) return;
    event.preventDefault();
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
