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
import { resolveMainModeCommand } from './input/mainCommandRouter';
import { dispatchModeInput } from './input/modeDispatcher';
import { handleListControlKey } from './input/listController';
import { getEditSessionAction } from './input/editSession';
import { formatSteppedNumber, snapNumberToStep } from './input/numeric';
import { type IncomingMessage, type OutgoingMessage } from './network/protocol';
import { createOnMessageHandler } from './network/messageHandlers';
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
import { createItemPropertyEditor } from './items/itemPropertyEditor';
import { NICKNAME_STORAGE_KEY, SettingsStore } from './settings/settingsStore';
import { runConnectFlow, runDisconnectFlow, type ConnectFlowDeps } from './session/connectionFlow';
import { MediaSession } from './session/mediaSession';
import { type AudioLayerState } from './types/audio';
import { setupUiHandlers as setupDomUiHandlers } from './ui/domBindings';
import { PeerManager } from './webrtc/peerManager';

const DEFAULT_DISPLAY_TIME_ZONE = 'America/Detroit';
const NICKNAME_MAX_LENGTH = 32;
const MIC_CALIBRATION_DURATION_MS = 5000;
const MIC_CALIBRATION_SAMPLE_INTERVAL_MS = 50;
const MIC_CALIBRATION_MIN_GAIN = 0.5;
const MIC_CALIBRATION_MAX_GAIN = 4;
const MIC_CALIBRATION_TARGET_RMS = 0.12;
const MIC_CALIBRATION_ACTIVE_RMS_THRESHOLD = 0.003;
const MIC_INPUT_GAIN_SCALE_MULTIPLIER = 2;
const MIC_INPUT_GAIN_STEP = 0.05;
const HEARTBEAT_INTERVAL_MS = 10_000;

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

const APP_VERSION = String(window.CHGRID_WEB_VERSION ?? '').trim();
const DISPLAY_TIME_ZONE = resolveDisplayTimeZone();
dom.appVersion.textContent = APP_VERSION
  ? `Another AI experiment with Jage. Version ${APP_VERSION}`
  : 'Another AI experiment with Jage. Version unknown';
const APP_BASE_URL = import.meta.env.BASE_URL || '/';
/** Resolves an app-relative path against the configured Vite base path. */
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
const settings = new SettingsStore();
let worldGridSize = GRID_SIZE;
let lastWallCollisionDirection: string | null = null;
let statusTimeout: number | null = null;
let lastFocusedElement: Element | null = null;
let lastAnnouncementText = '';
let lastAnnouncementAt = 0;
let outputMode = settings.loadOutputMode();
const messageBuffer: string[] = [];
let messageCursor = -1;
const radioRuntime = new RadioStationRuntime(audio, getItemSpatialConfig);
const itemEmitRuntime = new ItemEmitRuntime(audio, resolveIncomingSoundUrl, getItemSpatialConfig);
let internalClipboardText = '';
let replaceTextOnNextType = false;
let pendingEscapeDisconnect = false;
let micGainLoopbackRestoreState: boolean | null = null;
let helpViewerLines: string[] = [];
let helpViewerIndex = 0;
let heartbeatTimerId: number | null = null;
let heartbeatLastPongAt = 0;
let heartbeatNextPingId = -1;
let heartbeatAwaitingPong = false;
let reconnectInFlight = false;
let activeServerInstanceId: string | null = null;
let audioLayers: AudioLayerState = {
  voice: true,
  item: true,
  media: true,
  world: true,
};

const signalingProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const signalingUrl = `${signalingProtocol}://${window.location.host}/ws`;
const signaling = new SignalingClient(signalingUrl, handleSignalingStatus);

const peerManager = new PeerManager(
  audio,
  (targetId, payload) => {
    signaling.send({ type: 'signal', targetId, ...payload });
  },
  () => mediaSession.getOutboundStream(),
  updateStatus,
);
const mediaSession = new MediaSession({
  state,
  audio,
  peerManager,
  settings,
  dom,
  updateStatus,
  micCalibrationDurationMs: MIC_CALIBRATION_DURATION_MS,
  micCalibrationSampleIntervalMs: MIC_CALIBRATION_SAMPLE_INTERVAL_MS,
  micCalibrationMinGain: MIC_CALIBRATION_MIN_GAIN,
  micCalibrationMaxGain: MIC_CALIBRATION_MAX_GAIN,
  micCalibrationTargetRms: MIC_CALIBRATION_TARGET_RMS,
  micCalibrationActiveRmsThreshold: MIC_CALIBRATION_ACTIVE_RMS_THRESHOLD,
  micInputGainScaleMultiplier: MIC_INPUT_GAIN_SCALE_MULTIPLIER,
  micInputGainStep: MIC_INPUT_GAIN_STEP,
});
audio.setOutputMode(outputMode);

loadEffectLevels();
loadAudioLayerState();
loadMicInputGain();
void loadHelp();
void loadChangelog();

/** Fetches a required DOM element and casts it to the requested element type. */
function requiredById<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element: ${id}`);
  }
  return found as T;
}

/** Returns the configured display timezone when valid, otherwise the default fallback. */
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

/** Formats epoch milliseconds as `YYYY-MM-DD HH:mm` in the configured display timezone. */
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

/** Toggles updates panel visibility and syncs associated ARIA state. */
function setUpdatesExpanded(expanded: boolean): void {
  dom.updatesToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  dom.updatesToggle.textContent = expanded ? 'Hide updates' : 'Show updates';
  dom.updatesPanel.hidden = !expanded;
  dom.updatesPanel.classList.toggle('hidden', !expanded);
}

/** Renders help sections into the footer help container and builds linearized viewer lines. */
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

/** Loads runtime help content from `help.json` and applies it when available. */
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

/** Renders changelog sections into the collapsible updates panel. */
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

/** Loads changelog entries from `changelog.json` and wires the panel toggle button. */
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

/** Announces status text via ARIA with brief de-duplication and auto-clear timing. */
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

/** Sanitizes user nicknames to printable/safe characters and enforces max length. */
function sanitizeName(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, NICKNAME_MAX_LENGTH);
}

/** Enables/disables the connect button based on state and nickname validity. */
function updateConnectAvailability(): void {
  if (state.running) {
    dom.connectButton.disabled = true;
    return;
  }
  const hasNickname = sanitizeName(dom.preconnectNickname.value).length > 0;
  dom.connectButton.disabled = mediaSession.isConnecting() || !hasNickname;
}

/** Restores persisted outbound effect levels from local storage. */
function loadEffectLevels(): void {
  const parsed = settings.loadEffectLevels();
  if (!parsed) return;
  audio.setEffectLevels(parsed);
}

/** Persists current outbound effect levels to local storage. */
function persistEffectLevels(): void {
  settings.saveEffectLevels(audio.getEffectLevels());
}

/** Restores local audio-layer toggles and applies initial voice-layer state. */
function loadAudioLayerState(): void {
  audioLayers = settings.loadAudioLayers();
  audio.setVoiceLayerEnabled(audioLayers.voice);
}

/** Persists current audio-layer toggles to local storage. */
function persistAudioLayerState(): void {
  settings.saveAudioLayers(audioLayers);
}

/** Clamps microphone input gain to the supported calibration bounds. */
function clampMicInputGain(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(MIC_CALIBRATION_MIN_GAIN, Math.min(MIC_CALIBRATION_MAX_GAIN, value));
}

/** Loads persisted microphone input gain and applies default when missing. */
function loadMicInputGain(): void {
  const parsed = settings.loadMicInputGain();
  if (parsed === null) {
    audio.setOutboundInputGain(2);
    return;
  }
  audio.setOutboundInputGain(clampMicInputGain(parsed));
}

/** Persists microphone input gain to local storage. */
function persistMicInputGain(value: number): void {
  settings.saveMicInputGain(value);
}

/** Applies current layer toggles to peer voice, media streams, and item emitters. */
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

/** Toggles a single audio layer and applies the change immediately. */
function toggleAudioLayer(layer: keyof AudioLayerState): void {
  audioLayers = { ...audioLayers, [layer]: !audioLayers[layer] };
  persistAudioLayerState();
  void applyAudioLayerState();
  updateStatus(`${layer} layer ${audioLayers[layer] ? 'on' : 'off'}.`);
  audio.sfxUiBlip();
}

/** Routes signaling transport status messages through chat buffer + status output. */
function handleSignalingStatus(message: string): void {
  pushChatMessage(message);
}

/** Appends a chat/system line to the bounded status history buffer. */
function pushChatMessage(message: string): void {
  messageBuffer.push(message);
  if (messageBuffer.length > 300) {
    messageBuffer.shift();
  }
  messageCursor = messageBuffer.length - 1;
  updateStatus(message);
}

/** Classifies a system chat line into a corresponding notification sound, when applicable. */
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

/** Resolves incoming sound references to playable URLs, including proxy routing when needed. */
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

/** Navigates buffered chat lines and speaks the selected entry. */
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

/** Updates compact input/output device summary labels in the pre-connect UI. */
function updateDeviceSummary(): void {
  mediaSession.updateDeviceSummary();
}

/** Returns peer nicknames currently occupying the given grid cell. */
function getPeerNamesAtPosition(x: number, y: number): string[] {
  return Array.from(state.peers.values())
    .filter((peer) => peer.x === x && peer.y === y)
    .map((peer) => peer.nickname);
}

/** Returns a user-facing item label including type information. */
function itemLabel(item: WorldItem): string {
  return `${item.title} (${itemTypeLabel(item.type)})`;
}

/** Resolves effective spatial audio configuration for an item, with global fallbacks. */
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

/** Enters help-view mode and announces the first help line. */
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

/** Returns non-carried items occupying a given grid position. */
function getItemsAtPosition(x: number, y: number): WorldItem[] {
  return Array.from(state.items.values()).filter((item) => !item.carrierId && item.x === x && item.y === y);
}

/** Returns the item currently carried by the local player, if any. */
function getCarriedItem(): WorldItem | null {
  if (!state.player.id) return null;
  return Array.from(state.items.values()).find((item) => item.carrierId === state.player.id) || null;
}

/** Opens the shared item-selection flow for the provided context and items. */
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

/** Opens item property browsing/editing mode for one item. */
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

/** Sends an item-use request for the selected item. */
function useItem(item: WorldItem): void {
  signaling.send({ type: 'item_use', itemId: item.id });
}

/** Opens option-list selection mode for list-based item properties. */
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

/** Returns the active text-input max length for the current UI mode, if applicable. */
function textInputMaxLengthForMode(mode: typeof state.mode): number | null {
  if (mode === 'nickname') return NICKNAME_MAX_LENGTH;
  if (mode === 'chat') return 500;
  if (mode === 'itemPropertyEdit') return 500;
  if (mode === 'micGainEdit') return 8;
  return null;
}

/** Applies pasted text into whichever mode currently owns the shared text edit buffer. */
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

/** Whether the current mode uses the shared single-line text editing pipeline. */
function isTextEditingMode(mode: typeof state.mode): boolean {
  return mode === 'nickname' || mode === 'chat' || mode === 'itemPropertyEdit' || mode === 'micGainEdit';
}

/** Applies keyboard edits to the shared text buffer and emits cursor/deletion speech hints. */
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

/** Returns a formatted display value for an item property key, with per-key normalization. */
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

/** Infers value type for item-property help when metadata is missing. */
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

/** Provides tooltip fallbacks for inspect-only/system item properties. */
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

/** Returns whether a property is editable for the given item type. */
function isItemPropertyEditable(item: WorldItem, key: string): boolean {
  return getEditableItemPropertyKeys(item).includes(key);
}

/** Builds spoken tooltip/help text for the current item property row. */
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

/** Validates and normalizes numeric item-property edits using metadata ranges/steps. */
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

/** Returns singular/plural square wording for distance announcements. */
function squareWord(distance: number): string {
  return distance === 1 ? 'square' : 'squares';
}

/** Builds a spoken distance+direction phrase between two grid coordinates. */
function distanceDirectionPhrase(px: number, py: number, tx: number, ty: number): string {
  const distance = Math.round(Math.hypot(tx - px, ty - py));
  const direction = getDirection(px, py, tx, ty);
  if (direction === 'here') return 'here';
  return `${distance} ${squareWord(distance)} ${direction}`;
}

/** Persists current local player coordinates for reconnect/refresh restore. */
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

/** Picks one random footstep sample URL. */
function randomFootstepUrl(): string {
  return FOOTSTEP_SOUND_URLS[Math.floor(Math.random() * FOOTSTEP_SOUND_URLS.length)];
}

/** Main animation/update loop for movement, spatial audio, and rendering. */
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

/** Applies held-arrow movement with bounds checks, tile cues, and server position sync. */
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

/** Checks microphone permission state when Permissions API support is available. */
async function checkMicPermission(): Promise<boolean> {
  return mediaSession.checkMicPermission();
}

/** Starts local microphone capture and rebuilds the outbound track pipeline. */
async function setupLocalMedia(audioDeviceId = ''): Promise<void> {
  await mediaSession.setupLocalMedia(audioDeviceId);
}

/** Runs a short RMS sample to estimate and apply a usable microphone input gain. */
async function calibrateMicInputGain(): Promise<void> {
  await mediaSession.calibrateMicInputGain(clampMicInputGain, persistMicInputGain);
}

/** Stops local capture tracks and clears outbound stream references. */
function stopLocalMedia(): void {
  mediaSession.stopLocalMedia();
}

/** Maps browser media/capture errors to user-facing remediation text. */
function describeMediaError(error: unknown): string {
  return mediaSession.describeMediaError(error);
}

/** Restores loopback state captured when entering microphone gain edit mode. */
function restoreLoopbackAfterMicGainEdit(): void {
  if (micGainLoopbackRestoreState === null) {
    return;
  }
  audio.setLoopbackEnabled(micGainLoopbackRestoreState);
  micGainLoopbackRestoreState = null;
}

/** Stops heartbeat timer and clears in-memory heartbeat state. */
function stopHeartbeat(): void {
  if (heartbeatTimerId !== null) {
    window.clearInterval(heartbeatTimerId);
    heartbeatTimerId = null;
  }
  heartbeatLastPongAt = 0;
  heartbeatAwaitingPong = false;
}

/** Sends one heartbeat ping packet using reserved negative ids. */
function sendHeartbeatPing(): void {
  signaling.send({ type: 'ping', clientSentAt: heartbeatNextPingId });
  heartbeatNextPingId -= 1;
  heartbeatAwaitingPong = true;
}

/** Starts heartbeat timer for stale-connection detection. */
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatLastPongAt = Date.now();
  heartbeatAwaitingPong = false;
  sendHeartbeatPing();
  heartbeatTimerId = window.setInterval(() => {
    if (!state.running) return;
    if (heartbeatAwaitingPong) {
      void reconnectAfterHeartbeatTimeout();
      return;
    }
    sendHeartbeatPing();
  }, HEARTBEAT_INTERVAL_MS);
}

/** Performs one reconnect attempt when heartbeat timeout indicates stale signaling. */
async function reconnectAfterHeartbeatTimeout(): Promise<void> {
  if (reconnectInFlight || !state.running) return;
  reconnectInFlight = true;
  stopHeartbeat();
  pushChatMessage('Connection stale. Reconnecting...');
  disconnect();
  try {
    await connect();
  } finally {
    reconnectInFlight = false;
  }
}

/** Builds dependencies shared by connect/disconnect flow helpers. */
function getConnectionFlowDeps(): ConnectFlowDeps {
  return {
    state,
    dom,
    sanitizeName,
    updateStatus,
    updateConnectAvailability,
    settingsSaveNickname: (value) => settings.saveNickname(value),
    mediaIsConnecting: () => mediaSession.isConnecting(),
    mediaSetConnecting: (value) => mediaSession.setConnecting(value),
    mediaCheckMicPermission: () => checkMicPermission(),
    mediaPopulateAudioDevices: () => populateAudioDevices(),
    mediaGetPreferredInputDeviceId: () => mediaSession.getPreferredInputDeviceId(),
    mediaSetupLocalMedia: (audioDeviceId) => setupLocalMedia(audioDeviceId),
    mediaDescribeError: (error) => describeMediaError(error),
    mediaStopLocalMedia: () => stopLocalMedia(),
    signalingConnect: (handler) => signaling.connect(handler as (message: IncomingMessage) => Promise<void>),
    signalingDisconnect: () => signaling.disconnect(),
    onMessage: (message) => onSignalingMessage(message as IncomingMessage),
    worldGridSize,
    persistPlayerPosition,
    peerManagerCleanupAll: () => peerManager.cleanupAll(),
    radioCleanupAll: () => radioRuntime.cleanupAll(),
    emitCleanupAll: () => itemEmitRuntime.cleanupAll(),
    playLogoutSound: () => {
      void audio.playSample(SYSTEM_SOUND_URLS.logout, 1);
    },
  };
}

/** Performs end-to-end connect flow: validation, media setup, then signaling connection. */
async function connect(): Promise<void> {
  await runConnectFlow(getConnectionFlowDeps());
}

/** Tears down active session state, media, peers, and UI back to pre-connect mode. */
function disconnect(): void {
  stopHeartbeat();
  runDisconnectFlow(getConnectionFlowDeps());
  pendingEscapeDisconnect = false;
  restoreLoopbackAfterMicGainEdit();
}

const onAppMessage = createOnMessageHandler({
  getWorldGridSize: () => worldGridSize,
  setWorldGridSize: (size) => {
    worldGridSize = size;
  },
  setConnecting: (value) => {
    mediaSession.setConnecting(value);
    updateConnectAvailability();
  },
  rendererSetGridSize: (size) => renderer.setGridSize(size),
  applyServerItemUiDefinitions: (defs) => applyServerItemUiDefinitions(defs as Parameters<typeof applyServerItemUiDefinitions>[0]),
  state,
  dom,
  signalingSend: (message) => signaling.send(message as OutgoingMessage),
  peerManager,
  radioRuntime,
  itemEmitRuntime,
  applyAudioLayerState,
  gameLoop,
  sanitizeName,
  randomFootstepUrl,
  playRemoteSpatialStepOrTeleport: (url, peerX, peerY) => {
    void audio.playSpatialSample(
      url,
      { x: peerX - state.player.x, y: peerY - state.player.y },
      FOOTSTEP_GAIN,
    );
  },
  TELEPORT_SOUND_URL,
  audioLayers,
  pushChatMessage,
  classifySystemMessageSound,
  SYSTEM_SOUND_URLS,
  playSample: (url, gain = 1) => {
    void audio.playSample(url, gain);
  },
  updateStatus,
  audioUiBlip: () => audio.sfxUiBlip(),
  audioUiConfirm: () => audio.sfxUiConfirm(),
  audioUiCancel: () => audio.sfxUiCancel(),
  NICKNAME_STORAGE_KEY,
  getCarriedItemId: () => getCarriedItem()?.id ?? null,
  itemPropertyLabel,
  getItemPropertyValue,
  getItemById: (itemId) => state.items.get(itemId),
  playLocateToneAt: (x, y) => audio.sfxLocate({ x: x - state.player.x, y: y - state.player.y }),
  resolveIncomingSoundUrl,
  playIncomingItemUseSound: (url, x, y) => {
    void audio.playSpatialSample(url, { x: x - state.player.x, y: y - state.player.y }, 1);
  },
});

/** Handles signaling packets with heartbeat/restart metadata before app-level dispatch. */
async function onSignalingMessage(message: IncomingMessage): Promise<void> {
  if (message.type === 'pong' && message.clientSentAt < 0) {
    heartbeatLastPongAt = Date.now();
    heartbeatAwaitingPong = false;
    return;
  }
  let restartAnnouncement: string | null = null;
  if (message.type === 'welcome') {
    const incomingInstanceId = String(message.serverInfo?.instanceId ?? '').trim() || null;
    const incomingVersion = String(message.serverInfo?.version ?? '').trim() || 'unknown';
    if (activeServerInstanceId && incomingInstanceId && activeServerInstanceId !== incomingInstanceId) {
      restartAnnouncement = `Server restarted, version ${incomingVersion}.`;
    }
    activeServerInstanceId = incomingInstanceId;
    startHeartbeat();
  }
  await onAppMessage(message);
  if (restartAnnouncement) {
    pushChatMessage(restartAnnouncement);
    audio.sfxUiConfirm();
  }
}

/** Toggles local microphone track mute state. */
function toggleMute(): void {
  state.isMuted = !state.isMuted;
  mediaSession.applyMuteToTrack(state.isMuted);
  updateStatus(state.isMuted ? 'Muted.' : 'Unmuted.');
}

/** Handles command-mode keybindings while in main gameplay mode. */
function handleNormalModeInput(code: string, shiftKey: boolean): void {
  if (code !== 'Escape' && pendingEscapeDisconnect) {
    pendingEscapeDisconnect = false;
  }
  const command = resolveMainModeCommand(code, shiftKey);
  if (!command) return;

  switch (command) {
    case 'editNickname':
      state.mode = 'nickname';
      state.nicknameInput = state.player.nickname;
      state.cursorPos = state.player.nickname.length;
      replaceTextOnNextType = true;
      updateStatus(`Nickname edit: ${state.nicknameInput}`);
      audio.sfxUiBlip();
      return;
    case 'toggleMute':
      toggleMute();
      return;
    case 'toggleOutputMode':
      outputMode = audio.toggleOutputMode();
      mediaSession.saveOutputMode(outputMode);
      updateStatus(outputMode === 'mono' ? 'Mono output.' : 'Stereo output.');
      audio.sfxUiBlip();
      return;
    case 'toggleLoopback': {
      const enabled = audio.toggleLoopback();
      updateStatus(enabled ? 'Loopback on.' : 'Loopback off.');
      audio.sfxUiBlip();
      return;
    }
    case 'toggleVoiceLayer':
      toggleAudioLayer('voice');
      return;
    case 'toggleItemLayer':
      toggleAudioLayer('item');
      return;
    case 'toggleMediaLayer':
      toggleAudioLayer('media');
      return;
    case 'toggleWorldLayer':
      toggleAudioLayer('world');
      return;
    case 'openEffectSelect': {
      const currentEffect = audio.getCurrentEffect();
      const currentIndex = EFFECT_SEQUENCE.findIndex((effect) => effect.id === currentEffect.id);
      state.effectSelectIndex = currentIndex >= 0 ? currentIndex : 0;
      state.mode = 'effectSelect';
      updateStatus(`Select effect: ${EFFECT_SEQUENCE[state.effectSelectIndex].label}`);
      audio.sfxUiBlip();
      return;
    }
    case 'effectValueUp':
    case 'effectValueDown': {
      const step = command === 'effectValueUp' ? 5 : -5;
      const adjusted = audio.adjustCurrentEffectLevel(step);
      if (!adjusted) return;
      persistEffectLevels();
      audio.sfxEffectLevel(adjusted.value === adjusted.defaultValue);
      updateStatus(`${adjusted.label} ${adjusted.value}`);
      return;
    }
    case 'speakCoordinates':
      updateStatus(`${state.player.x}, ${state.player.y}`);
      audio.sfxUiBlip();
      return;
    case 'openMicGainEdit':
      state.mode = 'micGainEdit';
      state.nicknameInput = formatSteppedNumber(audio.getOutboundInputGain(), MIC_INPUT_GAIN_STEP);
      state.cursorPos = state.nicknameInput.length;
      replaceTextOnNextType = true;
      micGainLoopbackRestoreState = audio.isLoopbackEnabled();
      audio.setLoopbackEnabled(true);
      updateStatus(`Set microphone gain: ${state.nicknameInput}`);
      audio.sfxUiBlip();
      return;
    case 'calibrateMicrophone':
      void calibrateMicInputGain();
      return;
    case 'useItem': {
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
    case 'speakUsers': {
      const allUsers = [state.player.nickname, ...Array.from(state.peers.values()).map((p) => p.nickname)];
      const label = allUsers.length === 1 ? 'user' : 'users';
      updateStatus(`${allUsers.length} ${label}: ${allUsers.join(', ')}`);
      audio.sfxUiBlip();
      return;
    }
    case 'addItem': {
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
    case 'locateOrListItems':
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
      {
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
    case 'pickupDropOrDelete': {
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
    case 'editOrInspectItem': {
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
    case 'pingServer':
      signaling.send({ type: 'ping', clientSentAt: Date.now() });
      return;
    case 'locateOrListUsers':
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
      {
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
    case 'openHelp':
      openHelpViewer();
      return;
    case 'openChat':
      state.mode = 'chat';
      state.nicknameInput = '';
      state.cursorPos = 0;
      replaceTextOnNextType = false;
      updateStatus('Chat.');
      audio.sfxUiBlip();
      return;
    case 'chatPrev':
      navigateChatBuffer('prev');
      return;
    case 'chatNext':
      navigateChatBuffer('next');
      return;
    case 'chatFirst':
      navigateChatBuffer('first');
      return;
    case 'chatLast':
      navigateChatBuffer('last');
      return;
    case 'escape':
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

/** Handles linear help viewer navigation and exit keys. */
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

/** Handles chat compose mode including submit/cancel and inline editing keys. */
function handleChatModeInput(code: string, key: string, ctrlKey: boolean): void {
  const editAction = getEditSessionAction(code);
  if (editAction === 'submit') {
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

  if (editAction === 'cancel') {
    state.mode = 'normal';
    state.nicknameInput = '';
    state.cursorPos = 0;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
    return;
  }

  applyTextInputEdit(code, key, 500, ctrlKey);
}

/** Handles direct microphone gain editing mode with keyboard stepping and validation. */
function handleMicGainEditModeInput(code: string, key: string, ctrlKey: boolean): void {
  if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'PageUp' || code === 'PageDown') {
    const raw = Number(state.nicknameInput.trim());
    const base = Number.isFinite(raw) ? raw : audio.getOutboundInputGain();
    const multiplier = code === 'PageUp' || code === 'PageDown' ? 10 : 1;
    const delta = (code === 'ArrowUp' || code === 'PageUp' ? MIC_INPUT_GAIN_STEP : -MIC_INPUT_GAIN_STEP) * multiplier;
    const attempted = snapNumberToStep(base + delta, MIC_INPUT_GAIN_STEP, MIC_CALIBRATION_MIN_GAIN);
    const next = clampMicInputGain(attempted);
    state.nicknameInput = formatSteppedNumber(next, MIC_INPUT_GAIN_STEP);
    state.cursorPos = state.nicknameInput.length;
    replaceTextOnNextType = false;
    audio.setOutboundInputGain(next);
    updateStatus(state.nicknameInput);
    if (Math.abs(next - base) < 1e-9 || Math.abs(next - attempted) > 1e-9) {
      audio.sfxUiCancel();
    } else {
      audio.sfxUiBlip();
    }
    return;
  }

  const editAction = getEditSessionAction(code);
  if (editAction === 'submit') {
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
    restoreLoopbackAfterMicGainEdit();
    updateStatus(`Microphone gain set to ${formatSteppedNumber(applied, MIC_INPUT_GAIN_STEP)}.`);
    audio.sfxUiConfirm();
    return;
  }

  if (editAction === 'cancel') {
    state.mode = 'normal';
    replaceTextOnNextType = false;
    restoreLoopbackAfterMicGainEdit();
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
    return;
  }

  applyTextInputEdit(code, key, 8, ctrlKey, true);
}

/** Handles effect menu list navigation and selection. */
function handleEffectSelectModeInput(code: string, key: string): void {
  const control = handleListControlKey(code, key, EFFECT_SEQUENCE, state.effectSelectIndex, (effect) => effect.label);
  if (control.type === 'move') {
    state.effectSelectIndex = control.index;
    updateStatus(EFFECT_SEQUENCE[state.effectSelectIndex].label);
    audio.sfxUiBlip();
    return;
  }

  if (control.type === 'select') {
    const selected = EFFECT_SEQUENCE[state.effectSelectIndex];
    const effect = audio.setOutboundEffect(selected.id);
    state.mode = 'normal';
    updateStatus(effect.label);
    audio.sfxUiBlip();
    return;
  }

  if (control.type === 'cancel') {
    state.mode = 'normal';
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

/** Handles list navigation for nearby/known users and teleport-on-select. */
function handleListModeInput(code: string, key: string): void {
  if (state.sortedPeerIds.length === 0) {
    state.mode = 'normal';
    return;
  }

  const control = handleListControlKey(code, key, state.sortedPeerIds, state.listIndex, (peerId) => state.peers.get(peerId)?.nickname ?? '');
  if (control.type === 'move') {
    state.listIndex = control.index;
    const peer = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!peer) return;
    updateStatus(
      `${peer.nickname}, ${distanceDirectionPhrase(state.player.x, state.player.y, peer.x, peer.y)}, ${peer.x}, ${peer.y}`,
    );
    if (control.reason === 'initial') {
      audio.sfxUiBlip();
    }
    return;
  }

  if (control.type === 'select') {
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

  if (control.type === 'cancel') {
    state.mode = 'normal';
    updateStatus('Exit list mode.');
    audio.sfxUiCancel();
  }
}

/** Handles item list navigation and teleport-on-select. */
function handleListItemsModeInput(code: string, key: string): void {
  if (state.sortedItemIds.length === 0) {
    state.mode = 'normal';
    return;
  }

  const control = handleListControlKey(code, key, state.sortedItemIds, state.itemListIndex, (itemId) => {
    const item = state.items.get(itemId);
    return item ? itemLabel(item) : '';
  });
  if (control.type === 'move') {
    state.itemListIndex = control.index;
    const item = state.items.get(state.sortedItemIds[state.itemListIndex]);
    if (!item) return;
    updateStatus(
      `${itemLabel(item)}, ${distanceDirectionPhrase(state.player.x, state.player.y, item.x, item.y)}, ${item.x}, ${item.y}`,
    );
    if (control.reason === 'initial') {
      audio.sfxUiBlip();
    }
    return;
  }
  if (control.type === 'select') {
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
  if (control.type === 'cancel') {
    state.mode = 'normal';
    updateStatus('Exit item list mode.');
    audio.sfxUiCancel();
  }
}

/** Handles add-item type selection and item-type tooltip readout. */
function handleAddItemModeInput(code: string, key: string): void {
  const itemTypeSequence = getItemTypeSequence();
  if (itemTypeSequence.length === 0) {
    state.mode = 'normal';
    updateStatus('No item types available.');
    audio.sfxUiCancel();
    return;
  }
  const control = handleListControlKey(code, key, itemTypeSequence, state.addItemTypeIndex, (itemType) => itemTypeLabel(itemType));
  if (control.type === 'move') {
    state.addItemTypeIndex = control.index;
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
  if (control.type === 'select') {
    signaling.send({ type: 'item_add', itemType: itemTypeSequence[state.addItemTypeIndex] });
    state.mode = 'normal';
    return;
  }
  if (control.type === 'cancel') {
    state.mode = 'normal';
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

/** Handles generic selected-item list flow used by pickup/delete/edit/use/inspect contexts. */
function handleSelectItemModeInput(code: string, key: string): void {
  if (state.selectedItemIds.length === 0) {
    state.mode = 'normal';
    state.selectionContext = null;
    return;
  }
  const control = handleListControlKey(code, key, state.selectedItemIds, state.selectedItemIndex, (itemId) => {
    const item = state.items.get(itemId);
    return item ? itemLabel(item) : '';
  });
  if (control.type === 'move') {
    state.selectedItemIndex = control.index;
    const current = state.items.get(state.selectedItemIds[state.selectedItemIndex]);
    if (current) {
      updateStatus(itemLabel(current));
      audio.sfxUiBlip();
    }
    return;
  }
  if (control.type === 'select') {
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
  if (control.type === 'cancel') {
    state.mode = 'normal';
    state.selectionContext = null;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

const itemPropertyEditor = createItemPropertyEditor({
  state,
  signalingSend: (message) => signaling.send(message as OutgoingMessage),
  getItemPropertyValue,
  itemPropertyLabel,
  isItemPropertyEditable,
  getItemPropertyOptionValues,
  openItemPropertyOptionSelect,
  describeItemPropertyHelp,
  getItemPropertyMetadata,
  validateNumericItemPropertyInput,
  clampEffectLevel,
  effectIds: EFFECT_IDS as Set<string>,
  effectSequenceIdsCsv: EFFECT_SEQUENCE.map((effect) => effect.id).join(', '),
  applyTextInputEdit,
  setReplaceTextOnNextType: (value) => {
    replaceTextOnNextType = value;
  },
  updateStatus,
  sfxUiBlip: () => audio.sfxUiBlip(),
  sfxUiCancel: () => audio.sfxUiCancel(),
});

/** Handles nickname edit mode submission/cancel and text editing keys. */
function handleNicknameModeInput(code: string, key: string, ctrlKey: boolean): void {
  const editAction = getEditSessionAction(code);
  if (editAction === 'submit') {
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

  if (editAction === 'cancel') {
    state.mode = 'normal';
    replaceTextOnNextType = false;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
    return;
  }

  applyTextInputEdit(code, key, NICKNAME_MAX_LENGTH, ctrlKey, true);
}

/** Returns whether a key code should be treated as a repeat-suppressed typing key. */
function isTypingKey(code: string): boolean {
  return code.startsWith('Key') || code === 'Space';
}

/** Wires global keyboard/paste input handlers and routes events by current mode. */
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

    dispatchModeInput({
      mode: state.mode,
      code,
      key: event.key,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      handlers: {
        nickname: handleNicknameModeInput,
        chat: handleChatModeInput,
        micGainEdit: handleMicGainEditModeInput,
        effectSelect: (currentCode, currentKey) => handleEffectSelectModeInput(currentCode, currentKey),
        helpView: (currentCode) => handleHelpViewModeInput(currentCode),
        listUsers: (currentCode, currentKey) => handleListModeInput(currentCode, currentKey),
        listItems: (currentCode, currentKey) => handleListItemsModeInput(currentCode, currentKey),
        addItem: (currentCode, currentKey) => handleAddItemModeInput(currentCode, currentKey),
        selectItem: (currentCode, currentKey) => handleSelectItemModeInput(currentCode, currentKey),
        itemProperties: (currentCode, currentKey) => itemPropertyEditor.handleItemPropertiesModeInput(currentCode, currentKey),
        itemPropertyEdit: (currentCode, currentKey, currentCtrlKey) =>
          itemPropertyEditor.handleItemPropertyEditModeInput(currentCode, currentKey, currentCtrlKey),
        itemPropertyOptionSelect: (currentCode, currentKey) =>
          itemPropertyEditor.handleItemPropertyOptionSelectModeInput(currentCode, currentKey),
      },
      onNormalMode: handleNormalModeInput,
    });

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

/** Enumerates audio devices, updates selectors, and persists preferred choices. */
async function populateAudioDevices(): Promise<void> {
  await mediaSession.populateAudioDevices();
}

/** Opens settings modal and focuses device controls. */
function openSettings(): void {
  lastFocusedElement = document.activeElement;
  dom.settingsModal.classList.remove('hidden');
  void populateAudioDevices();
  dom.audioInputSelect.focus();
}

/** Closes settings modal and restores focus back to prior element or game canvas. */
function closeSettings(): void {
  dom.settingsModal.classList.add('hidden');
  if (lastFocusedElement instanceof HTMLElement) {
    lastFocusedElement.focus();
  } else {
    dom.canvas.focus();
  }
}

/** Wires button/form handlers and lifecycle hooks for the main UI shell. */
function setupUiHandlers(): void {
  setupDomUiHandlers({
    dom,
    sanitizeName,
    nicknameStorageKey: NICKNAME_STORAGE_KEY,
    updateConnectAvailability,
    connect,
    disconnect,
    openSettings,
    closeSettings,
    updateStatus,
    sfxUiBlip: () => audio.sfxUiBlip(),
    setupLocalMedia,
    setPreferredInput: (id, name) => {
      mediaSession.setPreferredInput(id, name);
    },
    setPreferredOutput: (id, name) => {
      mediaSession.setPreferredOutput(id, name);
    },
    updateDeviceSummary,
    setOutputDevice: (id) => peerManager.setOutputDevice(id),
    persistOnUnload: () => {
      if (!state.running) return;
      persistPlayerPosition();
    },
  });
}

setupInputHandlers();
setupUiHandlers();
const storedNickname = sanitizeName(settings.loadNickname());
dom.preconnectNickname.value = storedNickname;
if (storedNickname) {
  state.player.nickname = storedNickname;
}
updateConnectAvailability();
updateDeviceSummary();
updateStatus('Welcome to the Chat Grid. Press the Settings button to configure your audio, then Connect to join the grid.');
