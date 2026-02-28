import './styles.css';
import { AudioEngine } from './audio/audioEngine';
import {
  EFFECT_SEQUENCE,
} from './audio/effects';
import {
  RadioStationRuntime,
  getProxyUrlForStream,
  shouldProxyStreamUrl,
} from './audio/radioStationRuntime';
import { ItemEmitRuntime } from './audio/itemEmitRuntime';
import { ClockAnnouncer } from './audio/clockAnnouncer';
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
  type GameMode,
  type WorldItem,
} from './state/gameState';
import {
  applyServerItemUiDefinitions,
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
import { createItemPropertyPresentation } from './items/itemPropertyPresentation';
import { ItemBehaviorRegistry } from './items/types/behaviorRegistry';
import { SettingsStore } from './settings/settingsStore';
import { runConnectFlow, runDisconnectFlow, type ConnectFlowDeps } from './session/connectionFlow';
import { MediaSession } from './session/mediaSession';
import { type AudioLayerState } from './types/audio';
import { setupUiHandlers as setupDomUiHandlers } from './ui/domBindings';
import { PeerManager } from './webrtc/peerManager';

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
const RECONNECT_DELAY_MS = 5_000;
const RECONNECT_MAX_ATTEMPTS = 3;
const AUDIO_SUBSCRIPTION_REFRESH_MS = 500;
const TELEPORT_SQUARES_PER_SECOND = 20;
const AUTH_POLICY_STORAGE_KEY = 'chgridAuthPolicy';

declare global {
  interface Window {
    CHGRID_WEB_VERSION?: string;
  }
}

type Dom = {
  connectionStatus: HTMLElement;
  appVersion: HTMLElement;
  loginView: HTMLElement;
  registerView: HTMLElement;
  authUsername: HTMLInputElement;
  authPassword: HTMLInputElement;
  registerUsername: HTMLInputElement;
  registerPassword: HTMLInputElement;
  registerPasswordConfirm: HTMLInputElement;
  registerEmail: HTMLInputElement;
  authPolicyHintRegister: HTMLParagraphElement;
  authSessionView: HTMLElement;
  authSessionText: HTMLParagraphElement;
  authModeSeparator: HTMLElement;
  showRegisterButton: HTMLButtonElement;
  updatesSection: HTMLElement;
  updatesToggle: HTMLButtonElement;
  updatesPanel: HTMLDivElement;
  connectButton: HTMLButtonElement;
  logoutButton: HTMLButtonElement;
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
  connectionStatus: requiredById('connectionStatus'),
  appVersion: requiredById('appVersion'),
  loginView: requiredById('loginView'),
  registerView: requiredById('registerView'),
  authUsername: requiredById('authUsername'),
  authPassword: requiredById('authPassword'),
  registerUsername: requiredById('registerUsername'),
  registerPassword: requiredById('registerPassword'),
  registerPasswordConfirm: requiredById('registerPasswordConfirm'),
  registerEmail: requiredById('registerEmail'),
  authPolicyHintRegister: requiredById('authPolicyHintRegister'),
  authSessionView: requiredById('authSessionView'),
  authSessionText: requiredById('authSessionText'),
  authModeSeparator: requiredById('authModeSeparator'),
  showRegisterButton: requiredById('showRegisterButton'),
  updatesSection: requiredById('updatesSection'),
  updatesToggle: requiredById('updatesToggle'),
  updatesPanel: requiredById('updatesPanel'),
  connectButton: requiredById('connectButton'),
  logoutButton: requiredById('logoutButton'),
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

type AuthPolicy = {
  usernameMinLength: number;
  usernameMaxLength: number;
  passwordMinLength: number;
  passwordMaxLength: number;
};

type AdminMenuAction = {
  id: string;
  label: string;
};

type AdminRoleSummary = {
  id: number;
  name: string;
  isSystem: boolean;
  userCount: number;
  permissions: string[];
};

type AdminUserSummary = {
  id: string;
  username: string;
  role: string;
  status: 'active' | 'disabled';
};

type AdminPendingUserMutation =
  | { action: 'set_role'; username: string; role: string }
  | { action: 'ban'; username: string }
  | { action: 'unban'; username: string };

/** Builds linearized help-view lines from sectioned help content. */
function buildHelpLines(help: HelpData): string[] {
  const lines: string[] = [];
  for (const section of help.sections) {
    lines.push(section.title);
    for (const item of section.items) {
      lines.push(`${item.keys}: ${item.description}`);
    }
  }
  return lines;
}

const APP_VERSION = String(window.CHGRID_WEB_VERSION ?? '').trim();
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
const ACTION_SOUND_URL = withBase('sounds/action.ogg');
const FOOTSTEP_SOUND_URLS = Array.from({ length: 11 }, (_, index) => withBase(`sounds/step-${index + 1}.ogg`));
const FOOTSTEP_GAIN = 0.7;
const TELEPORT_START_SOUND_URL = withBase('sounds/teleport_start.ogg');
const TELEPORT_START_GAIN = 0.1;
const TELEPORT_SOUND_URL = withBase('sounds/teleport.ogg');
const WALL_SOUND_URL = withBase('sounds/wall.ogg');

const state = createInitialState();
const renderer = new CanvasRenderer(dom.canvas);
const audio = new AudioEngine();
const settings = new SettingsStore();
let worldGridSize = GRID_SIZE;
let movementTickMs = MOVE_COOLDOWN_MS;
let lastWallCollisionDirection: string | null = null;
let statusTimeout: number | null = null;
let lastFocusedElement: Element | null = null;
let lastAnnouncementText = '';
let lastAnnouncementAt = 0;
let outputMode = settings.loadOutputMode();
let authMode: 'login' | 'register' = 'login';
let authSessionToken = settings.loadAuthSessionToken();
let authUsername = settings.loadAuthUsername();
let authPolicy: AuthPolicy | null = null;
let authRole = 'user';
let authPermissions = new Set<string>();
let voiceSendAllowed = true;
let pendingAuthRequest = false;
const messageBuffer: string[] = [];
let messageCursor = -1;
const radioRuntime = new RadioStationRuntime(audio, getItemSpatialConfig);
const itemEmitRuntime = new ItemEmitRuntime(audio, resolveIncomingSoundUrl, getItemSpatialConfig);
const clockAnnouncer = new ClockAnnouncer(audio, () => ({ x: state.player.x, y: state.player.y }));
let internalClipboardText = '';
let replaceTextOnNextType = false;
let pendingEscapeDisconnect = false;
let micGainLoopbackRestoreState: boolean | null = null;
let mainHelpViewerLines: string[] = [];
let helpViewerLines: string[] = [];
let helpViewerIndex = 0;
let helpViewerReturnMode: GameMode = 'normal';
let heartbeatTimerId: number | null = null;
let heartbeatNextPingId = -1;
let heartbeatAwaitingPong = false;
let reconnectInFlight = false;
let activeServerInstanceId: string | null = null;
let reloadScheduledForVersionMismatch = false;
let peerNegotiationReady = false;
let pendingSignalMessages: Array<Extract<IncomingMessage, { type: 'signal' }>> = [];
let peerListenGainByNickname = settings.loadPeerListenGains();
let audioLayers: AudioLayerState = {
  voice: true,
  item: true,
  media: true,
  world: true,
};
let lastSubscriptionRefreshAt = 0;
let lastSubscriptionRefreshTileX = Math.round(state.player.x);
let lastSubscriptionRefreshTileY = Math.round(state.player.y);
let subscriptionRefreshInFlight = false;
let subscriptionRefreshPending = false;
let suppressItemPropertyEchoUntilMs = 0;
let itemPropertiesShowAll = false;
let activeTeleportLoopStop: (() => void) | null = null;
let activeTeleportLoopToken = 0;
const adminMenuActions: AdminMenuAction[] = [];
let serverAdminMenuActions: AdminMenuAction[] = [];
let adminMenuIndex = 0;
let adminRoles: AdminRoleSummary[] = [];
let adminRoleIndex = 0;
let adminPermissionKeys: string[] = [];
let adminPermissionTooltips: Record<string, string> = {};
let adminRolePermissionIndex = 0;
let adminRoleDeleteReplacementIndex = 0;
let adminUsers: AdminUserSummary[] = [];
let adminUserIndex = 0;
let adminPendingUserAction: 'set_role' | 'ban' | 'unban' | null = null;
let adminSelectedRoleName = '';
let adminSelectedUsername = '';
let adminPendingUserMutation: AdminPendingUserMutation | null = null;
let activeTeleport:
  | {
      startX: number;
      startY: number;
      targetX: number;
      targetY: number;
      startedAtMs: number;
      durationMs: number;
      lastSyncAtMs: number;
      lastSentX: number;
      lastSentY: number;
      completionStatus: string;
    }
  | null = null;

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

const itemBehaviorRegistry = new ItemBehaviorRegistry({
  state,
  audio,
  signalingSend: (message) => signaling.send(message),
  updateStatus,
  openHelpViewer: (lines, returnMode) => openHelpViewer(lines, returnMode),
  withBase,
});

audio.setOutputMode(outputMode);

loadEffectLevels();
loadAudioLayerState();
loadMicInputGain();
loadMasterVolume();
void loadHelp();
void itemBehaviorRegistry.initialize();
void loadChangelog();

/** Fetches a required DOM element and casts it to the requested element type. */
function requiredById<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element: ${id}`);
  }
  return found as T;
}

const itemPropertyPresentation = createItemPropertyPresentation();
const getItemPropertyValue = itemPropertyPresentation.getItemPropertyValue;
const isItemPropertyEditable = itemPropertyPresentation.isItemPropertyEditable;
const describeItemPropertyHelp = itemPropertyPresentation.describeItemPropertyHelp;
const validateNumericItemPropertyInput = itemPropertyPresentation.validateNumericItemPropertyInput;

/** Toggles updates panel visibility and syncs associated ARIA state. */
function setUpdatesExpanded(expanded: boolean): void {
  dom.updatesToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  dom.updatesToggle.textContent = expanded ? 'Hide updates' : 'Show updates';
  dom.updatesPanel.hidden = !expanded;
  dom.updatesPanel.classList.toggle('hidden', !expanded);
}

/** Renders help sections into the footer help container and builds linearized viewer lines. */
function renderHelp(help: HelpData): void {
  const lines = buildHelpLines(help);
  dom.instructions.innerHTML = '';
  const heading = document.createElement('h2');
  heading.textContent = 'Help';
  dom.instructions.appendChild(heading);
  for (const section of help.sections) {
    const sectionHeading = document.createElement('h3');
    sectionHeading.textContent = section.title;
    dom.instructions.appendChild(sectionHeading);
    for (const item of section.items) {
      const line = document.createElement('p');
      const keys = document.createElement('b');
      keys.textContent = `${item.keys}:`;
      line.appendChild(keys);
      line.append(` ${item.description}`);
      dom.instructions.appendChild(line);
    }
  }
  mainHelpViewerLines = lines;
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
  if (!state.running) {
    return;
  }
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

/** Updates persistent connection/update status shown under the page heading. */
function setConnectionStatus(message: string): void {
  dom.connectionStatus.textContent = String(message).trim();
}

/** Sanitizes user nicknames to printable/safe characters and enforces max length. */
function sanitizeName(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, NICKNAME_MAX_LENGTH);
}

/** Normalizes auth username according to server policy. */
function sanitizeAuthUsername(value: string): string {
  const maxLength = authPolicy?.usernameMaxLength ?? 128;
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, Math.max(1, maxLength));
}

/** Normalizes and stores server-advertised auth policy limits, then refreshes auth UI hints. */
function applyAuthPolicy(policy: unknown): void {
  if (!policy || typeof policy !== 'object') return;
  const raw = policy as Partial<AuthPolicy>;
  const usernameMin = Number(raw.usernameMinLength);
  const usernameMax = Number(raw.usernameMaxLength);
  const passwordMin = Number(raw.passwordMinLength);
  const passwordMax = Number(raw.passwordMaxLength);
  if (
    !Number.isInteger(usernameMin) ||
    !Number.isInteger(usernameMax) ||
    !Number.isInteger(passwordMin) ||
    !Number.isInteger(passwordMax)
  ) {
    return;
  }
  if (usernameMin < 1 || usernameMax < usernameMin || passwordMin < 1 || passwordMax < passwordMin) {
    return;
  }
  authPolicy = {
    usernameMinLength: usernameMin,
    usernameMaxLength: usernameMax,
    passwordMinLength: passwordMin,
    passwordMaxLength: passwordMax,
  };
  localStorage.setItem(AUTH_POLICY_STORAGE_KEY, JSON.stringify(authPolicy));
  dom.authPolicyHintRegister.textContent = `Username, ${usernameMin}-${usernameMax} characters. Password, ${passwordMin}-${passwordMax} characters.`;
  dom.authUsername.minLength = usernameMin;
  dom.authUsername.maxLength = usernameMax;
  dom.registerUsername.minLength = usernameMin;
  dom.registerUsername.maxLength = usernameMax;
  dom.authPassword.minLength = passwordMin;
  dom.authPassword.maxLength = passwordMax;
  dom.registerPassword.minLength = passwordMin;
  dom.registerPassword.maxLength = passwordMax;
  dom.registerPasswordConfirm.minLength = passwordMin;
  dom.registerPasswordConfirm.maxLength = passwordMax;
  updateConnectAvailability();
}

/** Loads most recently-seen auth policy limits from local storage for pre-connect UI hints. */
function loadPersistedAuthPolicy(): void {
  const raw = localStorage.getItem(AUTH_POLICY_STORAGE_KEY);
  if (!raw) return;
  try {
    applyAuthPolicy(JSON.parse(raw));
  } catch {
    // Ignore malformed persisted policy and keep live server policy source of truth.
  }
}

/** Returns whether currently authenticated user has a specific permission key. */
function hasPermission(key: string): boolean {
  return authPermissions.has(key);
}

/** Applies latest role + permission set from server auth packets. */
function applyAuthPermissions(role: string | null | undefined, permissions: string[] | null | undefined): void {
  authRole = String(role || 'user').trim() || 'user';
  authPermissions = new Set((permissions || []).map((value) => String(value).trim()).filter((value) => value.length > 0));
  applyVoiceSendPermission();
}

/** Applies server-authored admin menu actions for current session. */
function applyServerAdminMenuActions(actions: Array<{ id: string; label: string }> | null | undefined): void {
  serverAdminMenuActions = (actions || [])
    .map((entry) => ({
      id: String(entry.id || '').trim(),
      label: String(entry.label || '').trim(),
    }))
    .filter((entry) => entry.id.length > 0 && entry.label.length > 0);
}

/** Applies server-authoritative voice.send permission immediately to local outbound track state. */
function applyVoiceSendPermission(): void {
  voiceSendAllowed = hasPermission('voice.send');
  if (voiceSendAllowed) {
    mediaSession.applyMuteToTrack(state.isMuted);
    return;
  }
  mediaSession.applyMuteToTrack(true);
}

/** Enables/disables the connect button based on state and nickname validity. */
function updateConnectAvailability(): void {
  const hasSessionToken = authSessionToken.trim().length > 0;
  const showLogout = state.running || hasSessionToken;
  dom.logoutButton.classList.toggle('hidden', !showLogout);
  dom.logoutButton.disabled = !showLogout;
  if (state.running) {
    dom.connectButton.textContent = 'Connect';
    dom.connectButton.disabled = true;
    dom.loginView.classList.add('hidden');
    dom.registerView.classList.add('hidden');
    dom.authSessionView.classList.add('hidden');
    return;
  }
  if (hasSessionToken) {
    const label = sanitizeAuthUsername(authUsername) || 'current account';
    dom.authSessionText.textContent = `Logged in as ${label}.`;
    dom.showRegisterButton.classList.add('hidden');
    dom.authModeSeparator.classList.add('hidden');
    dom.loginView.classList.add('hidden');
    dom.registerView.classList.add('hidden');
    dom.authSessionView.classList.remove('hidden');
  } else {
    dom.showRegisterButton.classList.remove('hidden');
    dom.authModeSeparator.classList.remove('hidden');
    dom.showRegisterButton.textContent = authMode === 'login' ? 'Register' : 'Login';
    dom.loginView.classList.toggle('hidden', authMode !== 'login');
    dom.registerView.classList.toggle('hidden', authMode !== 'register');
    dom.authSessionView.classList.add('hidden');
  }
  const usernameMin = authPolicy?.usernameMinLength ?? 1;
  const passwordMin = authPolicy?.passwordMinLength ?? 1;
  const hasLoginCredentials =
    sanitizeAuthUsername(dom.authUsername.value).length >= usernameMin && dom.authPassword.value.trim().length >= passwordMin;
  const hasRegisterCredentials =
    sanitizeAuthUsername(dom.registerUsername.value).length >= usernameMin &&
    dom.registerPassword.value.trim().length >= passwordMin &&
    dom.registerPassword.value === dom.registerPasswordConfirm.value;
  const authReady = hasSessionToken || (authMode === 'login' ? hasLoginCredentials : hasRegisterCredentials);
  dom.connectButton.textContent = hasSessionToken ? 'Connect' : authMode === 'login' ? 'Log In & Connect' : 'Register & Connect';
  dom.connectButton.disabled = mediaSession.isConnecting() || !authReady;
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

/** Loads persisted master output volume and applies default when missing. */
function loadMasterVolume(): void {
  const parsed = settings.loadMasterVolume();
  if (parsed === null) {
    audio.setMasterVolume(50);
    return;
  }
  audio.setMasterVolume(parsed);
}

/** Persists master output volume to local storage. */
function persistMasterVolume(value: number): void {
  settings.saveMasterVolume(value);
}

/** Normalizes nickname for local per-user listen-gain preference keys. */
function peerListenGainKey(nickname: string): string {
  return nickname.trim().toLowerCase();
}

/** Returns configured listen gain for a nickname (default 1.0). */
function getPeerListenGainForNickname(nickname: string): number {
  const key = peerListenGainKey(nickname);
  const raw = peerListenGainByNickname[key];
  if (!Number.isFinite(raw)) return 1;
  return clampMicInputGain(raw);
}

/** Persists local listen gain preference for a nickname. */
function setPeerListenGainForNickname(nickname: string, gain: number): void {
  const key = peerListenGainKey(nickname);
  peerListenGainByNickname = { ...peerListenGainByNickname, [key]: clampMicInputGain(gain) };
  settings.savePeerListenGains(peerListenGainByNickname);
}

/** Applies stored listen-gain preferences to currently known peer runtimes. */
function applyConfiguredPeerListenGains(): void {
  for (const [peerId, peerState] of state.peers.entries()) {
    peerManager.setPeerListenGain(peerId, getPeerListenGainForNickname(peerState.nickname));
  }
}

/** Applies current layer toggles to peer voice, media streams, and item emitters. */
async function applyAudioLayerState(): Promise<void> {
  audio.setVoiceLayerEnabled(audioLayers.voice);
  if (audioLayers.voice) {
    await peerManager.resumeRemoteAudio();
  } else {
    peerManager.suspendRemoteAudio();
  }
  const listenerPosition = { x: state.player.x, y: state.player.y };
  await radioRuntime.setLayerEnabled(audioLayers.media, state.items.values(), listenerPosition);
  await itemEmitRuntime.setLayerEnabled(audioLayers.item, state.items.values(), listenerPosition);
}

/** Refreshes distance-gated radio/item stream subscriptions for a listener position. */
async function refreshAudioSubscriptionsAt(listenerPosition: { x: number; y: number }, force = false): Promise<void> {
  await refreshAudioSubscriptionsForListeners([listenerPosition], force);
}

/** Refreshes distance-gated radio/item stream subscriptions for one or more listener positions. */
async function refreshAudioSubscriptionsForListeners(
  listenerPositions: Array<{ x: number; y: number }>,
  force = false,
): Promise<void> {
  if (!state.running) return;
  if (listenerPositions.length === 0) return;
  const now = Date.now();
  const anchorListener = listenerPositions[listenerPositions.length - 1];
  const tileX = Math.round(anchorListener.x);
  const tileY = Math.round(anchorListener.y);
  const moved = tileX !== lastSubscriptionRefreshTileX || tileY !== lastSubscriptionRefreshTileY;
  if (!force && !moved && now - lastSubscriptionRefreshAt < AUDIO_SUBSCRIPTION_REFRESH_MS) {
    return;
  }
  if (subscriptionRefreshInFlight) {
    subscriptionRefreshPending = true;
    return;
  }
  subscriptionRefreshInFlight = true;
  lastSubscriptionRefreshAt = now;
  lastSubscriptionRefreshTileX = tileX;
  lastSubscriptionRefreshTileY = tileY;
  try {
    await radioRuntime.sync(state.items.values(), listenerPositions);
    await itemEmitRuntime.sync(state.items.values(), listenerPositions);
  } finally {
    subscriptionRefreshInFlight = false;
    if (subscriptionRefreshPending) {
      subscriptionRefreshPending = false;
      void refreshAudioSubscriptions(true);
    }
  }
}

/** Refreshes distance-gated radio/item stream subscriptions on movement or timer cadence. */
async function refreshAudioSubscriptions(force = false): Promise<void> {
  if (activeTeleport) {
    await refreshAudioSubscriptionsForListeners(
      [
        { x: activeTeleport.startX, y: activeTeleport.startY },
        { x: activeTeleport.targetX, y: activeTeleport.targetY },
      ],
      force,
    );
    return;
  }
  await refreshAudioSubscriptionsAt({ x: state.player.x, y: state.player.y }, force);
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
  if (message === 'Connected.') {
    return;
  }
  if (message === 'Disconnected.' && state.running && !reconnectInFlight) {
    setConnectionStatus('Disconnected from server. Reconnecting...');
    pushChatMessage('Disconnected from server. Reconnecting...');
    void reconnectAfterSocketClose();
    return;
  }
  if (message === 'Disconnected.') {
    setConnectionStatus('Disconnected from server.');
    pushChatMessage('Disconnected from server.');
    return;
  }
  pushChatMessage(message);
}

/** Performs cache-busted navigation so the browser loads the newest client bundle. */
function reloadClientForVersion(version: string): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('v', version || 'unknown');
  nextUrl.searchParams.set('t', String(Date.now()));
  window.location.replace(nextUrl.toString());
}

/** Returns true when this page load came from the version-mismatch reload flow. */
function isVersionReloadedSession(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('v') && params.has('t');
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
  if (normalized.startsWith('server rebooting in ')) {
    return 'notify';
  }
  return null;
}

/** Resolves incoming sound references to playable URLs, including proxy routing when needed. */
function resolveIncomingSoundUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const lowered = raw.toLowerCase();
  if (lowered === 'none' || lowered === 'off') return '';
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
  if (target === 'prev' || target === 'next') {
    const atStart = messageCursor === 0;
    const atEnd = messageCursor === messageBuffer.length - 1;
    if (atStart || atEnd) {
      audio.sfxUiBlip();
    }
  }
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
function openHelpViewer(lines: string[], returnMode: GameMode = 'normal'): void {
  if (lines.length === 0) {
    updateStatus('Help unavailable.');
    audio.sfxUiCancel();
    return;
  }
  helpViewerLines = lines;
  helpViewerReturnMode = returnMode;
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
  itemPropertiesShowAll = showAll;
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
  if (state.itemPropertyKeys.length === 0) {
    updateStatus('No properties available.');
    audio.sfxUiCancel();
    state.mode = 'normal';
    state.selectedItemId = null;
    return;
  }
  const key = state.itemPropertyKeys[0];
  const value = getItemPropertyValue(item, key);
  updateStatus(`${itemPropertyLabel(key)}: ${value}`);
  audio.sfxUiBlip();
}

/** Recomputes visible property rows for the active item-property view after item updates. */
function recomputeActiveItemPropertyKeys(itemId: string): void {
  if (state.mode !== 'itemProperties' || state.selectedItemId !== itemId) {
    return;
  }
  const item = state.items.get(itemId);
  if (!item) {
    return;
  }
  const previousKey = state.itemPropertyKeys[state.itemPropertyIndex] ?? null;
  const nextKeys = itemPropertiesShowAll ? getInspectItemPropertyKeys(item) : getEditableItemPropertyKeys(item);
  state.itemPropertyKeys = nextKeys;
  if (nextKeys.length === 0) {
    state.itemPropertyIndex = 0;
    return;
  }
  if (previousKey && nextKeys.includes(previousKey)) {
    state.itemPropertyIndex = nextKeys.indexOf(previousKey);
    return;
  }
  state.itemPropertyIndex = Math.max(0, Math.min(state.itemPropertyIndex, nextKeys.length - 1));
}

/** Sends an item-use request for the selected item. */
function useItem(item: WorldItem): void {
  signaling.send({ type: 'item_use', itemId: item.id });
}

/** Sends an item secondary-use request for the selected item. */
function secondaryUseItem(item: WorldItem): void {
  signaling.send({ type: 'item_secondary_use', itemId: item.id });
}

/** Opens option-list selection mode for list-based item properties. */
function openItemPropertyOptionSelect(item: WorldItem, key: string): void {
  const options = getItemPropertyOptionValues(item.type, key);
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
  if (mode === 'adminRoleNameEdit') return 32;
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
  return (
    mode === 'nickname' ||
    mode === 'chat' ||
    mode === 'itemPropertyEdit' ||
    mode === 'micGainEdit' ||
    mode === 'adminRoleNameEdit'
  );
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

/** Formats a coordinate with up to 2 decimals while trimming trailing zeros. */
function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(2).replace(/\.?0+$/, '');
}

/** Picks one random footstep sample URL. */
function randomFootstepUrl(): string {
  return FOOTSTEP_SOUND_URLS[Math.floor(Math.random() * FOOTSTEP_SOUND_URLS.length)];
}

/** Stops active teleport loop audio, if one is running. */
function stopTeleportLoopAudio(): void {
  if (!activeTeleportLoopStop) return;
  activeTeleportLoopStop();
  activeTeleportLoopStop = null;
}

/** Starts animated teleport movement toward a target tile at fixed squares-per-second pace. */
function startTeleportTo(targetX: number, targetY: number, completionStatus: string): void {
  const startX = state.player.x;
  const startY = state.player.y;
  const distance = Math.hypot(targetX - startX, targetY - startY);
  const durationMs = Math.max(1, (distance / TELEPORT_SQUARES_PER_SECOND) * 1000);
  const nowMs = performance.now();
  activeTeleport = {
    startX,
    startY,
    targetX,
    targetY,
    startedAtMs: nowMs,
    durationMs,
    lastSyncAtMs: nowMs,
    lastSentX: Math.round(startX),
    lastSentY: Math.round(startY),
    completionStatus,
  };
  stopTeleportLoopAudio();
  activeTeleportLoopToken += 1;
  const loopToken = activeTeleportLoopToken;
  void audio.startLoopingSample(TELEPORT_START_SOUND_URL, TELEPORT_START_GAIN).then((stopLoop) => {
    if (!stopLoop) return;
    if (activeTeleport && loopToken === activeTeleportLoopToken) {
      activeTeleportLoopStop = stopLoop;
      return;
    }
    stopLoop();
  });
  void refreshAudioSubscriptionsForListeners(
    [
      { x: startX, y: startY },
      { x: targetX, y: targetY },
    ],
    true,
  );
  state.keysPressed.ArrowUp = false;
  state.keysPressed.ArrowDown = false;
  state.keysPressed.ArrowLeft = false;
  state.keysPressed.ArrowRight = false;
  lastWallCollisionDirection = null;
}

/** Advances active teleport animation, syncs intermediate server positions, and finalizes arrival. */
function updateTeleport(): void {
  if (!activeTeleport) return;
  const nowMs = performance.now();
  const elapsedMs = nowMs - activeTeleport.startedAtMs;
  const progress = Math.max(0, Math.min(1, elapsedMs / activeTeleport.durationMs));
  state.player.x = activeTeleport.startX + (activeTeleport.targetX - activeTeleport.startX) * progress;
  state.player.y = activeTeleport.startY + (activeTeleport.targetY - activeTeleport.startY) * progress;

  if (nowMs - activeTeleport.lastSyncAtMs >= movementTickMs) {
    activeTeleport.lastSyncAtMs = nowMs;
    const desiredX = Math.round(state.player.x);
    const desiredY = Math.round(state.player.y);
    const stepX = Math.sign(desiredX - activeTeleport.lastSentX);
    const stepY = Math.sign(desiredY - activeTeleport.lastSentY);
    const syncX = activeTeleport.lastSentX + stepX;
    const syncY = activeTeleport.lastSentY + stepY;
    if (syncX !== activeTeleport.lastSentX || syncY !== activeTeleport.lastSentY) {
      activeTeleport.lastSentX = syncX;
      activeTeleport.lastSentY = syncY;
      signaling.send({ type: 'update_position', x: syncX, y: syncY });
    }
  }

  if (progress < 1) {
    return;
  }
  const completionStatus = activeTeleport.completionStatus;
  state.player.x = activeTeleport.targetX;
  state.player.y = activeTeleport.targetY;
  signaling.send({ type: 'teleport_complete', x: activeTeleport.targetX, y: activeTeleport.targetY });
  activeTeleport = null;
  stopTeleportLoopAudio();
  void refreshAudioSubscriptions(true);
  void audio.playSample(TELEPORT_SOUND_URL, FOOTSTEP_GAIN);
  updateStatus(completionStatus);
}

/** Main animation/update loop for movement, spatial audio, and rendering. */
function gameLoop(): void {
  if (!state.running) return;
  updateTeleport();
  handleMovement();
  if (!activeTeleport) {
    void refreshAudioSubscriptions();
  }
  audio.updateSpatialAudio(peerManager.getPeers(), { x: state.player.x, y: state.player.y });
  audio.updateSpatialSamples({ x: state.player.x, y: state.player.y });
  radioRuntime.updateSpatialAudio(state.items, { x: state.player.x, y: state.player.y });
  itemEmitRuntime.updateSpatialAudio(state.items, { x: state.player.x, y: state.player.y });
  state.cursorVisible = Math.floor(Date.now() / 500) % 2 === 0;
  renderer.draw(state);
  requestAnimationFrame(gameLoop);
}

/** Applies held-arrow movement with bounds checks, tile cues, and server position sync. */
function handleMovement(): void {
  if (state.mode !== 'normal') return;
  if (activeTeleport) return;
  const now = Date.now();
  if (now - state.player.lastMoveTime < movementTickMs) return;

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
  state.player.lastMoveTime = now;
  void refreshAudioSubscriptions(true);
  void audio.playSample(randomFootstepUrl(), FOOTSTEP_GAIN, movementTickMs);
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
  applyVoiceSendPermission();
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
  await reconnectWithRetry('heartbeat');
}

/** Performs immediate reconnect when websocket closes unexpectedly. */
async function reconnectAfterSocketClose(): Promise<void> {
  await reconnectWithRetry('socketClose');
}

/** Reconnects after disconnect with delay and bounded retry attempts. */
async function reconnectWithRetry(reason: 'heartbeat' | 'socketClose'): Promise<void> {
  if (reconnectInFlight || !state.running) return;
  reconnectInFlight = true;
  stopHeartbeat();
  if (reason === 'heartbeat') {
    pushChatMessage('Connection stale. Reconnecting...');
  }
  disconnect();
  for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_DELAY_MS));
    await connect();
    const waitStartedAt = Date.now();
    while (!state.running && Date.now() - waitStartedAt < 4_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    if (state.running) {
      reconnectInFlight = false;
      return;
    }
    if (attempt < RECONNECT_MAX_ATTEMPTS) {
      pushChatMessage(`Reconnect attempt ${attempt} failed. Retrying in 5 seconds...`);
    }
  }
  pushChatMessage('Reconnect failed after 3 attempts. Press Connect to retry.');
  audio.sfxUiCancel();
  reconnectInFlight = false;
}

/** Switches pre-connect auth view between login and register modes. */
function setAuthMode(mode: 'login' | 'register'): void {
  authMode = mode;
  dom.loginView.classList.toggle('hidden', mode !== 'login');
  dom.registerView.classList.toggle('hidden', mode !== 'register');
  updateConnectAvailability();
}

/** Builds outbound auth packet from local token or active auth form. */
function buildAuthRequestPacket(): OutgoingMessage | null {
  const token = authSessionToken.trim();
  if (token) {
    return { type: 'auth_resume', sessionToken: token };
  }
  if (authMode === 'register') {
    const username = sanitizeAuthUsername(dom.registerUsername.value);
    const password = dom.registerPassword.value;
    const email = dom.registerEmail.value.trim();
    if (!username || !password || password !== dom.registerPasswordConfirm.value) return null;
    return { type: 'auth_register', username, password, ...(email ? { email } : {}) };
  }
  const username = sanitizeAuthUsername(dom.authUsername.value);
  const password = dom.authPassword.value;
  if (!username || !password) return null;
  return { type: 'auth_login', username, password };
}

/** Sends current auth request over signaling websocket after socket open. */
function sendAuthRequest(): void {
  const packet = buildAuthRequestPacket();
  if (!packet) {
    setConnectionStatus('Enter username and password.');
    mediaSession.setConnecting(false);
    updateConnectAvailability();
    signaling.disconnect();
    return;
  }
  pendingAuthRequest = true;
  setConnectionStatus('Authenticating...');
  signaling.send(packet);
}

/** Handles server auth-required prompts prior to world welcome. */
function handleAuthRequired(message: Extract<IncomingMessage, { type: 'auth_required' }>): void {
  applyAuthPolicy(message.authPolicy);
  applyAuthPermissions('user', []);
  applyServerAdminMenuActions([]);
  setConnectionStatus('Authentication required.');
  updateStatus(message.message);
}

/** Applies auth result state and terminates failed auth attempts quickly. */
async function handleAuthResult(message: Extract<IncomingMessage, { type: 'auth_result' }>): Promise<void> {
  pendingAuthRequest = false;
  applyAuthPolicy(message.authPolicy);
  if (!message.ok) {
    dom.authPassword.value = '';
    dom.registerPassword.value = '';
    dom.registerPasswordConfirm.value = '';
    if (message.message.toLowerCase().includes('session')) {
      authSessionToken = '';
      settings.saveAuthSessionToken('');
    }
    applyAuthPermissions('user', []);
    applyServerAdminMenuActions([]);
    setConnectionStatus(message.message);
    mediaSession.setConnecting(false);
    updateConnectAvailability();
    signaling.disconnect();
    return;
  }

  if (message.sessionToken) {
    authSessionToken = message.sessionToken;
    settings.saveAuthSessionToken(message.sessionToken);
  }
  if (message.username) {
    authUsername = message.username;
    settings.saveAuthUsername(message.username);
    dom.authUsername.value = message.username;
    dom.registerUsername.value = message.username;
  }
  if (message.nickname) {
    const resolved = sanitizeName(message.nickname);
    if (resolved) {
      state.player.nickname = resolved;
    }
  }
  applyAuthPermissions(message.role, message.permissions);
  applyServerAdminMenuActions(message.adminMenuActions);
  dom.authPassword.value = '';
  dom.registerPassword.value = '';
  dom.registerPasswordConfirm.value = '';
  setConnectionStatus('Authenticated. Joining world...');
}

/** Clears stored auth session and returns UI to login mode. */
function logOutAccount(): void {
  authSessionToken = '';
  authUsername = '';
  settings.saveAuthSessionToken('');
  settings.saveAuthUsername('');
  applyAuthPermissions('user', []);
  applyServerAdminMenuActions([]);
  if (state.running) {
    signaling.send({ type: 'auth_logout' });
    disconnect();
  }
  setAuthMode('login');
  updateStatus('Logged out.');
  updateConnectAvailability();
}

/** Handles server-pushed role/permission refresh events for the current session. */
function handleAuthPermissions(message: Extract<IncomingMessage, { type: 'auth_permissions' }>): void {
  const hadVoiceSend = voiceSendAllowed;
  applyAuthPermissions(message.role, message.permissions);
  applyServerAdminMenuActions(message.adminMenuActions);
  if (hadVoiceSend && !voiceSendAllowed) {
    updateStatus('Voice send permission revoked.');
  }
  if (!hadVoiceSend && voiceSendAllowed) {
    updateStatus('Voice send permission granted.');
  }
}

/** Returns available admin-menu root actions based on current permission set. */
function getAvailableAdminActions(): AdminMenuAction[] {
  return [...serverAdminMenuActions];
}

/** Handles server role-list response for admin menu flows. */
function handleAdminRolesList(message: Extract<IncomingMessage, { type: 'admin_roles_list' }>): void {
  adminRoles = [...message.roles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  adminPermissionKeys = [...message.permissionKeys].sort((a, b) => a.localeCompare(b));
  adminPermissionTooltips = { ...(message.permissionTooltips ?? {}) };
  if (adminPendingUserAction === 'set_role' && adminSelectedUsername) {
    state.mode = 'adminUserRoleSelect';
    const selectedUser = adminUsers.find((entry) => entry.username === adminSelectedUsername);
    const currentRoleIndex =
      selectedUser ? adminRoles.findIndex((entry) => entry.name === selectedUser.role) : -1;
    adminRoleIndex = currentRoleIndex >= 0 ? currentRoleIndex : 0;
    const first = adminRoles[0];
    if (first && adminRoles[adminRoleIndex]) {
      updateStatus(adminRoles[adminRoleIndex].name);
      audio.sfxUiBlip();
    } else {
      updateStatus('No roles available.');
      audio.sfxUiCancel();
      state.mode = 'normal';
      adminPendingUserAction = null;
      adminSelectedUsername = '';
    }
    return;
  }
  state.mode = 'adminRoleList';
  adminRoleIndex = 0;
  const first = adminRoles[0];
  if (first) {
    updateStatus(`${first.name}, ${first.userCount}.`);
  } else {
    updateStatus('No roles found.');
  }
  audio.sfxUiBlip();
}

/** Handles server user-list response for admin menu flows. */
function handleAdminUsersList(message: Extract<IncomingMessage, { type: 'admin_users_list' }>): void {
  adminUsers = [...message.users].sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }));
  if (adminUsers.length === 0) {
    updateStatus('No users available.');
    audio.sfxUiCancel();
    state.mode = 'normal';
    adminPendingUserAction = null;
    return;
  }
  state.mode = 'adminUserList';
  adminUserIndex = 0;
  const first = adminUsers[0];
  updateStatus(`${first.username}, ${first.role}, ${first.status}.`);
  audio.sfxUiBlip();
}

/** Handles structured admin action result packets. */
function handleAdminActionResult(message: Extract<IncomingMessage, { type: 'admin_action_result' }>): void {
  if (message.action === 'role_update_permissions') {
    return;
  }
  const suppressStatusMessage =
    message.ok && message.action === 'user_set_role' && adminPendingUserMutation?.action === 'set_role';
  if (!suppressStatusMessage) {
    updateStatus(message.message);
  }
  if (!message.ok) {
    adminPendingUserMutation = null;
    audio.sfxUiCancel();
    return;
  }

  if (adminPendingUserMutation) {
    if (adminPendingUserMutation.action === 'set_role') {
      const target = adminUsers.find((entry) => entry.username === adminPendingUserMutation.username);
      if (target) {
        target.role = adminPendingUserMutation.role;
      }
      if (state.mode === 'adminUserRoleSelect') {
        state.mode = 'adminUserList';
        adminPendingUserAction = 'set_role';
        const userIndex = adminUsers.findIndex((entry) => entry.username === adminPendingUserMutation.username);
        if (userIndex >= 0) {
          adminUserIndex = userIndex;
          const selected = adminUsers[adminUserIndex];
          updateStatus(`${selected.username}, ${selected.role}, ${selected.status}.`);
        }
      }
    } else if (adminPendingUserMutation.action === 'ban') {
      adminUsers = adminUsers.filter((entry) => entry.username !== adminPendingUserMutation.username);
      if (state.mode === 'adminUserList' && adminPendingUserAction === 'ban') {
        if (adminUsers.length > 0) {
          adminUserIndex = Math.max(0, Math.min(adminUserIndex, adminUsers.length - 1));
        } else {
          state.mode = 'adminMenu';
          adminPendingUserAction = null;
        }
      }
    } else if (adminPendingUserMutation.action === 'unban') {
      adminUsers = adminUsers.filter((entry) => entry.username !== adminPendingUserMutation.username);
      if (state.mode === 'adminUserList' && adminPendingUserAction === 'unban') {
        if (adminUsers.length > 0) {
          adminUserIndex = Math.max(0, Math.min(adminUserIndex, adminUsers.length - 1));
        } else {
          state.mode = 'adminMenu';
          adminPendingUserAction = null;
        }
      }
    }
    adminPendingUserMutation = null;
  }

  audio.sfxUiConfirm();
}

/** Builds dependencies shared by connect/disconnect flow helpers. */
function getConnectionFlowDeps(): ConnectFlowDeps {
  return {
    state,
    dom,
    sanitizeName,
    updateStatus: (message) => {
      if (!state.running) {
        setConnectionStatus(message);
        return;
      }
      if (message === 'Disconnected.') {
        setConnectionStatus('Disconnected.');
      } else if (message.startsWith('Connect failed.')) {
        setConnectionStatus(message);
      }
      if (reconnectInFlight && message === 'Disconnected.') {
        return;
      }
      pushChatMessage(message);
    },
    updateConnectAvailability,
    mediaIsConnecting: () => mediaSession.isConnecting(),
    mediaSetConnecting: (value) => mediaSession.setConnecting(value),
    mediaStopLocalMedia: () => stopLocalMedia(),
    signalingConnect: (handler) => signaling.connect(handler as (message: IncomingMessage) => Promise<void>),
    signalingSendAuth: () => sendAuthRequest(),
    signalingDisconnect: () => signaling.disconnect(),
    onMessage: (message) => onSignalingMessage(message as IncomingMessage),
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
  setConnectionStatus('Connecting...');
  await runConnectFlow(getConnectionFlowDeps());
}

/** Tears down active session state, media, peers, and UI back to pre-connect mode. */
function disconnect(): void {
  stopHeartbeat();
  runDisconnectFlow(getConnectionFlowDeps());
  setConnectionStatus('Disconnected.');
  pendingEscapeDisconnect = false;
  restoreLoopbackAfterMicGainEdit();
  subscriptionRefreshPending = false;
  subscriptionRefreshInFlight = false;
  lastSubscriptionRefreshAt = 0;
  lastSubscriptionRefreshTileX = Math.round(state.player.x);
  lastSubscriptionRefreshTileY = Math.round(state.player.y);
  stopTeleportLoopAudio();
  activeTeleport = null;
  peerNegotiationReady = false;
  pendingSignalMessages = [];
  itemBehaviorRegistry.cleanup();
}

/** Starts peer negotiation only after welcome + media setup sequencing is complete. */
async function activatePeerNegotiation(): Promise<void> {
  if (!state.running) return;
  if (peerNegotiationReady) return;
  peerNegotiationReady = true;
  for (const peer of state.peers.values()) {
    await peerManager.createOrGetPeer(peer.id, true, peer);
  }
  if (pendingSignalMessages.length === 0) return;
  const queued = pendingSignalMessages;
  pendingSignalMessages = [];
  for (const signal of queued) {
    await onAppMessage(signal);
  }
}

const onAppMessage = createOnMessageHandler({
  getWorldGridSize: () => worldGridSize,
  setWorldGridSize: (size) => {
    worldGridSize = size;
  },
  setMovementTickMs: (value) => {
    movementTickMs = Math.max(1, value);
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
  refreshAudioSubscriptions,
  cleanupItemAudio: (itemId) => {
    radioRuntime.cleanup(itemId);
    itemEmitRuntime.cleanup(itemId);
  },
  applyAudioLayerState,
  gameLoop,
  sanitizeName,
  randomFootstepUrl,
  playRemoteSpatialStepOrTeleport: (url, peerX, peerY) => {
    const gain = url === TELEPORT_START_SOUND_URL ? TELEPORT_START_GAIN : FOOTSTEP_GAIN;
    void audio.playSpatialSample(
      url,
      { x: peerX, y: peerY },
      { x: state.player.x, y: state.player.y },
      gain,
    );
  },
  handleItemActionResultStatus: (message) => itemBehaviorRegistry.onActionResultStatus(message),
  handleRemotePianoNote: (message) => itemBehaviorRegistry.onRemotePianoNote(message),
  handlePianoStatus: (message) => itemBehaviorRegistry.onPianoStatus(message),
  stopAllRemoteNotesForSender: (senderId) => itemBehaviorRegistry.stopAllRemoteNotesForSender(senderId),
  TELEPORT_SOUND_URL,
  TELEPORT_START_SOUND_URL,
  getAudioLayers: () => audioLayers,
  pushChatMessage,
  classifySystemMessageSound,
  ACTION_SOUND_URL,
  SYSTEM_SOUND_URLS,
  playSample: (url, gain = 1) => {
    void audio.playSample(url, gain);
  },
  updateStatus,
  audioUiBlip: () => audio.sfxUiBlip(),
  audioUiConfirm: () => audio.sfxUiConfirm(),
  audioUiCancel: () => audio.sfxUiCancel(),
  getCarriedItemId: () => getCarriedItem()?.id ?? null,
  recomputeActiveItemPropertyKeys,
  itemPropertyLabel,
  getItemPropertyValue,
  getItemById: (itemId) => state.items.get(itemId),
  shouldAnnounceItemPropertyEcho: () => Date.now() >= suppressItemPropertyEchoUntilMs,
  playLocateToneAt: (x, y) => audio.sfxLocate({ x: x - state.player.x, y: y - state.player.y }),
  resolveIncomingSoundUrl,
  playIncomingItemUseSound: (url, x, y, range) => {
    void audio.playSpatialSample(url, { x, y }, { x: state.player.x, y: state.player.y }, 1, range ?? HEARING_RADIUS);
  },
  playClockAnnouncement: (sounds, x, y, range) => {
    void clockAnnouncer.playSequence(sounds.map(resolveIncomingSoundUrl), x, y, range);
  },
  handleAuthRequired,
  handleAuthResult,
  handleAuthPermissions,
  handleAdminRolesList,
  handleAdminUsersList,
  handleAdminActionResult,
  isPeerNegotiationReady: () => peerNegotiationReady,
  enqueuePendingSignal: (message) => {
    pendingSignalMessages.push(message);
    if (pendingSignalMessages.length > 500) {
      pendingSignalMessages.splice(0, pendingSignalMessages.length - 500);
    }
  },
});

/** Handles signaling packets with heartbeat/restart metadata before app-level dispatch. */
async function onSignalingMessage(message: IncomingMessage): Promise<void> {
  if (message.type === 'pong' && message.clientSentAt < 0) {
    heartbeatAwaitingPong = false;
    return;
  }
  let restartAnnouncement: string | null = null;
  let connectedAnnouncement: string | null = null;
  if (message.type === 'welcome') {
    applyAuthPolicy(message.auth?.policy);
    applyAuthPermissions(message.auth?.role, message.auth?.permissions);
    const uiAdminActions =
      (message.uiDefinitions as { adminMenu?: { actions?: Array<{ id: string; label: string }> } } | undefined)?.adminMenu?.actions ??
      message.auth?.adminMenuActions;
    applyServerAdminMenuActions(uiAdminActions);
    const incomingInstanceId = String(message.serverInfo?.instanceId ?? '').trim() || null;
    const incomingVersion = String(message.serverInfo?.version ?? '').trim() || 'unknown';
    connectedAnnouncement = reconnectInFlight
      ? `Reconnected to server. Version ${incomingVersion}.`
      : `Connected to server. Version ${incomingVersion}.`;
    if (
      !reloadScheduledForVersionMismatch &&
      APP_VERSION &&
      incomingVersion &&
      incomingVersion !== 'unknown' &&
      incomingVersion !== APP_VERSION
    ) {
      reloadScheduledForVersionMismatch = true;
      pushChatMessage(`Server version ${incomingVersion} detected. Reloading client...`);
      window.setTimeout(() => {
        reloadClientForVersion(incomingVersion);
      }, 50);
      return;
    }
    if (activeServerInstanceId && incomingInstanceId && activeServerInstanceId !== incomingInstanceId) {
      restartAnnouncement = 'Server restarted.';
    }
    activeServerInstanceId = incomingInstanceId;
    startHeartbeat();
  }
  await onAppMessage(message);
  if (message.type === 'welcome') {
    void setupMediaAfterAuth();
  }
  itemBehaviorRegistry.onUseResultMessage(message);
  itemBehaviorRegistry.onWorldUpdate();
  applyConfiguredPeerListenGains();
  if (restartAnnouncement) {
    setConnectionStatus(restartAnnouncement);
    pushChatMessage(restartAnnouncement);
    audio.sfxUiConfirm();
  }
  if (connectedAnnouncement) {
    setConnectionStatus(connectedAnnouncement);
    pushChatMessage(connectedAnnouncement);
  }
}

/** Requests microphone access and initializes local media after successful auth/welcome. */
async function setupMediaAfterAuth(): Promise<void> {
  if (!state.running) return;
  const canProceed = await checkMicPermission();
  if (!canProceed) {
    setConnectionStatus('Microphone access is required.');
    await activatePeerNegotiation();
    return;
  }
  try {
    await populateAudioDevices();
    if (dom.audioInputSelect.options.length === 0) {
      setConnectionStatus('No audio input device found. Open Audio setup or connect a microphone.');
      await activatePeerNegotiation();
      return;
    }
    const inputDeviceId = dom.audioInputSelect.value || mediaSession.getPreferredInputDeviceId();
    await setupLocalMedia(inputDeviceId);
  } catch (error) {
    console.error(error);
    setConnectionStatus(describeMediaError(error));
  } finally {
    await activatePeerNegotiation();
  }
}

/** Toggles local microphone track mute state. */
function toggleMute(): void {
  if (!voiceSendAllowed) {
    updateStatus('Voice send is disabled for this account.');
    audio.sfxUiCancel();
    return;
  }
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
    case 'masterVolumeUp':
    case 'masterVolumeDown': {
      const step = command === 'masterVolumeUp' ? 5 : -5;
      const next = audio.adjustMasterVolume(step);
      persistMasterVolume(next);
      updateStatus(`Master volume ${next}`);
      audio.sfxEffectLevel(next === 50);
      return;
    }
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
      updateStatus(`${formatCoordinate(state.player.x)}, ${formatCoordinate(state.player.y)}`);
      audio.sfxUiBlip();
      return;
    case 'openMicGainEdit':
      if (!voiceSendAllowed) {
        updateStatus('Voice send is disabled for this account.');
        audio.sfxUiCancel();
        return;
      }
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
      if (!voiceSendAllowed) {
        updateStatus('Voice send is disabled for this account.');
        audio.sfxUiCancel();
        return;
      }
      void calibrateMicInputGain();
      return;
    case 'openAdminMenu': {
      const actions = getAvailableAdminActions();
      if (actions.length === 0) {
        return;
      }
      adminMenuActions.splice(0, adminMenuActions.length, ...actions);
      adminMenuIndex = 0;
      state.mode = 'adminMenu';
      updateStatus(`Admin: ${adminMenuActions[0].label}.`);
      audio.sfxUiBlip();
      return;
    }
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
    case 'secondaryUseItem': {
      const carried = getCarriedItem();
      if (carried) {
        secondaryUseItem(carried);
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
        secondaryUseItem(usable[0]);
        return;
      }
      beginItemSelection('secondaryUse', usable);
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
          const itemCount = state.sortedItemIds.length;
          const itemLabelText = itemCount === 1 ? 'item' : 'items';
          updateStatus(
            `${itemCount} ${itemLabelText}. ${itemLabel(first)}, ${distanceDirectionPhrase(state.player.x, state.player.y, first.x, first.y)}, ${first.x}, ${first.y}`,
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
          .sort((a, b) => a[1].nickname.localeCompare(b[1].nickname, undefined, { sensitivity: 'base' }))
          .map(([id]) => id);
        state.listIndex = 0;
        state.mode = 'listUsers';
        const first = state.peers.get(state.sortedPeerIds[0]);
        if (first) {
          const userCount = state.sortedPeerIds.length;
          const userLabelText = userCount === 1 ? 'user' : 'users';
          const gainPhrase = `volume ${formatSteppedNumber(getPeerListenGainForNickname(first.nickname), MIC_INPUT_GAIN_STEP)}`;
          updateStatus(
            `${userCount} ${userLabelText}. ${first.nickname}, ${gainPhrase}, ${distanceDirectionPhrase(state.player.x, state.player.y, first.x, first.y)}, ${first.x}, ${first.y}`,
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
      openHelpViewer(mainHelpViewerLines);
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
    state.mode = helpViewerReturnMode;
    updateStatus('Closed help.');
    audio.sfxUiCancel();
  }
}

/** Handles chat compose mode including submit/cancel and inline editing keys. */
function handleChatModeInput(code: string, key: string, ctrlKey: boolean): void {
  const editAction = getEditSessionAction(code);
  if (editAction === 'submit') {
    const rawMessage = state.nicknameInput;
    if (rawMessage.trim().length > 0) {
      signaling.send({ type: 'chat_message', message: rawMessage });
      state.mode = 'normal';
      state.nicknameInput = '';
      state.cursorPos = 0;
      if (!/^\/me(?:\s|$)/i.test(rawMessage)) {
        audio.sfxUiConfirm();
      }
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
    state.mode = 'adminMenu';
    updateStatus('Admin menu.');
    audio.sfxUiCancel();
  }
}

/** Handles list navigation for nearby/known users and teleport-on-select. */
function handleListModeInput(code: string, key: string): void {
  if (state.sortedPeerIds.length === 0) {
    state.mode = 'normal';
    return;
  }

  if (code === 'ArrowLeft' || code === 'ArrowRight') {
    const peerId = state.sortedPeerIds[state.listIndex];
    const entry = state.peers.get(peerId);
    if (!entry) return;
    const current = getPeerListenGainForNickname(entry.nickname);
    const delta = code === 'ArrowRight' ? MIC_INPUT_GAIN_STEP : -MIC_INPUT_GAIN_STEP;
    const attempted = snapNumberToStep(current + delta, MIC_INPUT_GAIN_STEP, MIC_CALIBRATION_MIN_GAIN);
    const next = clampMicInputGain(attempted);
    setPeerListenGainForNickname(entry.nickname, next);
    peerManager.setPeerListenGain(peerId, next);
    updateStatus(`${entry.nickname} volume ${formatSteppedNumber(next, MIC_INPUT_GAIN_STEP)}.`);
    if (Math.abs(next - current) < 1e-9 || Math.abs(next - attempted) > 1e-9) {
      audio.sfxUiCancel();
    } else {
      audio.sfxUiBlip();
    }
    return;
  }

  const control = handleListControlKey(
    code,
    key,
    state.sortedPeerIds,
    state.listIndex,
    (peerId) => state.peers.get(peerId)?.nickname ?? '',
  );
  if (control.type === 'move') {
    state.listIndex = control.index;
    const entry = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!entry) return;
    const gainPhrase = `volume ${formatSteppedNumber(getPeerListenGainForNickname(entry.nickname), MIC_INPUT_GAIN_STEP)}`;
    updateStatus(
      `${entry.nickname}, ${gainPhrase}, ${distanceDirectionPhrase(state.player.x, state.player.y, entry.x, entry.y)}, ${entry.x}, ${entry.y}`,
    );
    if (control.reason === 'initial') {
      audio.sfxUiBlip();
    }
    return;
  }

  if (control.type === 'select') {
    const entry = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!entry) return;
    if (state.player.x === entry.x && state.player.y === entry.y) {
      updateStatus('Already here.');
      return;
    }
    state.mode = 'normal';
    startTeleportTo(entry.x, entry.y, `Moved to ${entry.nickname}.`);
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
    state.mode = 'normal';
    startTeleportTo(item.x, item.y, `Moved to ${itemLabel(item)}.`);
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
    if (context === 'secondaryUse') {
      secondaryUseItem(selected);
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

/** Handles top-level Shift+Z admin menu action selection. */
function handleAdminMenuModeInput(code: string, key: string): void {
  if (adminMenuActions.length === 0) {
    state.mode = 'normal';
    return;
  }
  const control = handleListControlKey(code, key, adminMenuActions, adminMenuIndex, (entry) => entry.label);
  if (control.type === 'move') {
    adminMenuIndex = control.index;
    updateStatus(adminMenuActions[adminMenuIndex].label);
    audio.sfxUiBlip();
    return;
  }
  if (control.type === 'select') {
    const selected = adminMenuActions[adminMenuIndex];
    if (!selected) return;
    if (selected.id === 'manage_roles') {
      signaling.send({ type: 'admin_roles_list' });
      updateStatus('Loading roles...');
      return;
    }
    if (selected.id === 'change_user_role') {
      adminPendingUserAction = 'set_role';
      signaling.send({ type: 'admin_users_list', action: 'set_role' });
      updateStatus('Loading users...');
      return;
    }
    if (selected.id === 'ban_user') {
      adminPendingUserAction = 'ban';
      signaling.send({ type: 'admin_users_list', action: 'ban' });
      updateStatus('Loading users...');
      return;
    }
    if (selected.id === 'unban_user') {
      adminPendingUserAction = 'unban';
      signaling.send({ type: 'admin_users_list', action: 'unban' });
      updateStatus('Loading users...');
    }
    return;
  }
  if (control.type === 'cancel') {
    state.mode = 'normal';
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

/** Handles role list selection flow, including add-role entry. */
function handleAdminRoleListModeInput(code: string, key: string): void {
  const entries: Array<{ label: string; role?: AdminRoleSummary }> = [
    ...adminRoles.map((role) => ({ label: `${role.name}, ${role.userCount}`, role })),
    { label: 'Add role' },
  ];
  const control = handleListControlKey(code, key, entries, adminRoleIndex, (entry) => entry.label);
  if (control.type === 'move') {
    adminRoleIndex = control.index;
    updateStatus(entries[adminRoleIndex]?.label || '');
    audio.sfxUiBlip();
    return;
  }
  if (control.type === 'select') {
    const selected = entries[adminRoleIndex];
    if (!selected) return;
    if (!selected.role) {
      state.mode = 'adminRoleNameEdit';
      state.nicknameInput = '';
      state.cursorPos = 0;
      replaceTextOnNextType = false;
      updateStatus('New role name.');
      audio.sfxUiBlip();
      return;
    }
    adminSelectedRoleName = selected.role.name;
    adminRolePermissionIndex = 0;
    state.mode = 'adminRolePermissionList';
    updateStatus(`${adminSelectedRoleName} permissions.`);
    audio.sfxUiBlip();
    return;
  }
  if (control.type === 'cancel') {
    state.mode = 'normal';
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
  }
}

/** Handles role permission toggle and delete flow. */
function handleAdminRolePermissionListModeInput(code: string, key: string): void {
  const role = adminRoles.find((entry) => entry.name === adminSelectedRoleName);
  if (!role) {
    state.mode = 'adminRoleList';
    return;
  }
  const entries = [...adminPermissionKeys, '__delete_role__'];
  const control = handleListControlKey(code, key, entries, adminRolePermissionIndex, (entry) =>
    entry === '__delete_role__' ? `Delete role ${role.name}` : `${entry}: ${role.permissions.includes(entry) ? 'on' : 'off'}`,
  );
  if (control.type === 'move') {
    adminRolePermissionIndex = control.index;
    const value = entries[adminRolePermissionIndex];
    if (value === '__delete_role__') {
      updateStatus(`Delete role ${role.name}.`);
    } else {
      updateStatus(`${value}: ${role.permissions.includes(value) ? 'on' : 'off'}`);
    }
    audio.sfxUiBlip();
    return;
  }
  if (code === 'Space') {
    const value = entries[adminRolePermissionIndex];
    if (value === '__delete_role__') {
      updateStatus('Delete the current role and reassign affected users.');
    } else {
      updateStatus(adminPermissionTooltips[value] || 'No tooltip available.');
    }
    audio.sfxUiBlip();
    return;
  }
  if (control.type === 'select') {
    const value = entries[adminRolePermissionIndex];
    if (value === '__delete_role__') {
      if (role.name === 'admin' || role.name === 'user') {
        updateStatus('Admin and user roles cannot be deleted.');
        audio.sfxUiCancel();
        return;
      }
      const replacementCandidates = adminRoles.filter((entry) => entry.name !== role.name);
      if (replacementCandidates.length === 0) {
        updateStatus('No replacement role available.');
        audio.sfxUiCancel();
        return;
      }
      adminRoleDeleteReplacementIndex = 0;
      state.mode = 'adminRoleDeleteReplacement';
      updateStatus(`Replacement role: ${replacementCandidates[0].name}.`);
      audio.sfxUiBlip();
      return;
    }
    const nextPermissions = new Set(role.permissions);
    if (nextPermissions.has(value)) {
      nextPermissions.delete(value);
    } else {
      nextPermissions.add(value);
    }
    role.permissions = [...nextPermissions].sort((a, b) => a.localeCompare(b));
    signaling.send({ type: 'admin_role_update_permissions', role: role.name, permissions: role.permissions });
    updateStatus(`${value}: ${role.permissions.includes(value) ? 'on' : 'off'}`);
    audio.sfxUiBlip();
    return;
  }
  if (control.type === 'cancel') {
    state.mode = 'adminRoleList';
    updateStatus('Roles.');
    audio.sfxUiCancel();
  }
}

/** Handles replacement-role selection while deleting a role. */
function handleAdminRoleDeleteReplacementModeInput(code: string, key: string): void {
  const candidates = adminRoles.filter((entry) => entry.name !== adminSelectedRoleName);
  if (candidates.length === 0) {
    state.mode = 'adminRolePermissionList';
    return;
  }
  const control = handleListControlKey(code, key, candidates, adminRoleDeleteReplacementIndex, (entry) => entry.name);
  if (control.type === 'move') {
    adminRoleDeleteReplacementIndex = control.index;
    updateStatus(candidates[adminRoleDeleteReplacementIndex].name);
    audio.sfxUiBlip();
    return;
  }
  if (control.type === 'select') {
    const replacement = candidates[adminRoleDeleteReplacementIndex];
    signaling.send({
      type: 'admin_role_delete',
      role: adminSelectedRoleName,
      replacementRole: replacement.name,
    });
    state.mode = 'adminRoleList';
    updateStatus(`Deleting ${adminSelectedRoleName}...`);
    return;
  }
  if (control.type === 'cancel') {
    state.mode = 'adminRolePermissionList';
    updateStatus(`${adminSelectedRoleName} permissions.`);
    audio.sfxUiCancel();
  }
}

/** Handles user list selection for change-role/ban/unban flows. */
function handleAdminUserListModeInput(code: string, key: string): void {
  if (adminUsers.length === 0) {
    state.mode = 'normal';
    adminPendingUserAction = null;
    return;
  }
  const control = handleListControlKey(code, key, adminUsers, adminUserIndex, (entry) => `${entry.username}, ${entry.role}, ${entry.status}`);
  if (control.type === 'move') {
    adminUserIndex = control.index;
    const selected = adminUsers[adminUserIndex];
    updateStatus(`${selected.username}, ${selected.role}, ${selected.status}.`);
    audio.sfxUiBlip();
    return;
  }
  if (control.type === 'select') {
    const selected = adminUsers[adminUserIndex];
    if (!selected) return;
    adminSelectedUsername = selected.username;
    if (adminPendingUserAction === 'set_role') {
      signaling.send({ type: 'admin_roles_list' });
      updateStatus(`Select new role for ${selected.username}.`);
      return;
    }
    if (adminPendingUserAction === 'ban') {
      adminPendingUserMutation = { action: 'ban', username: selected.username };
      signaling.send({ type: 'admin_user_ban', username: selected.username });
      adminPendingUserAction = 'ban';
      return;
    }
    if (adminPendingUserAction === 'unban') {
      adminPendingUserMutation = { action: 'unban', username: selected.username };
      signaling.send({ type: 'admin_user_unban', username: selected.username });
      adminPendingUserAction = 'unban';
      return;
    }
    return;
  }
  if (control.type === 'cancel') {
    state.mode = 'adminMenu';
    adminPendingUserAction = null;
    updateStatus('Admin menu.');
    audio.sfxUiCancel();
  }
}

/** Handles role selection for a previously selected user target. */
function handleAdminUserRoleSelectModeInput(code: string, key: string): void {
  if (adminRoles.length === 0) {
    state.mode = 'normal';
    adminPendingUserAction = null;
    return;
  }
  const control = handleListControlKey(code, key, adminRoles, adminRoleIndex, (entry) => entry.name);
  if (control.type === 'move') {
    adminRoleIndex = control.index;
    updateStatus(adminRoles[adminRoleIndex].name);
    audio.sfxUiBlip();
    return;
  }
  if (control.type === 'select') {
    const selectedRole = adminRoles[adminRoleIndex];
    adminPendingUserMutation = { action: 'set_role', username: adminSelectedUsername, role: selectedRole.name };
    signaling.send({ type: 'admin_user_set_role', username: adminSelectedUsername, role: selectedRole.name });
    return;
  }
  if (control.type === 'cancel') {
    state.mode = 'adminUserList';
    updateStatus('Select user.');
    audio.sfxUiCancel();
  }
}

/** Handles text edit for new-role creation from admin role list. */
function handleAdminRoleNameEditModeInput(code: string, key: string, ctrlKey: boolean): void {
  const editAction = getEditSessionAction(code);
  if (editAction === 'submit') {
    const name = state.nicknameInput.trim().toLowerCase();
    if (!name) {
      updateStatus('Role name required.');
      audio.sfxUiCancel();
      return;
    }
    signaling.send({ type: 'admin_role_create', name });
    state.mode = 'adminRoleList';
    state.nicknameInput = '';
    state.cursorPos = 0;
    replaceTextOnNextType = false;
    updateStatus(`Creating role ${name}...`);
    return;
  }
  if (editAction === 'cancel') {
    state.mode = 'adminRoleList';
    state.nicknameInput = '';
    state.cursorPos = 0;
    replaceTextOnNextType = false;
    updateStatus('Cancelled.');
    audio.sfxUiCancel();
    return;
  }
  applyTextInputEdit(code, key, 32, ctrlKey, true);
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
  applyTextInputEdit,
  setReplaceTextOnNextType: (value) => {
    replaceTextOnNextType = value;
  },
  suppressItemPropertyEchoMs: (ms) => {
    suppressItemPropertyEchoUntilMs = Math.max(suppressItemPropertyEchoUntilMs, Date.now() + Math.max(0, ms));
  },
  onPreviewPropertyChange: (item, key, value) => {
    itemBehaviorRegistry.onPropertyPreviewChange(item, key, value);
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

/** Maps normalized `event.key` values to canonical `event.code` strings when code is unavailable. */
function codeFromKey(key: string, location: number): string | null {
  if (key === 'Escape' || key === 'Esc') return 'Escape';
  if (key === 'Enter' || key === 'Return') return 'Enter';
  if (key === 'Backspace') return 'Backspace';
  if (key === 'Delete' || key === 'Del') return 'Delete';
  if (key === 'ArrowUp' || key === 'Up') return 'ArrowUp';
  if (key === 'ArrowDown' || key === 'Down') return 'ArrowDown';
  if (key === 'ArrowLeft' || key === 'Left') return 'ArrowLeft';
  if (key === 'ArrowRight' || key === 'Right') return 'ArrowRight';
  if (key === 'Home') return 'Home';
  if (key === 'End') return 'End';
  if (key === 'PageUp') return 'PageUp';
  if (key === 'PageDown') return 'PageDown';
  if (key === 'Tab') return 'Tab';
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key.length === 1) {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    if (key === '!') return 'Digit1';
    if (key === '@') return 'Digit2';
    if (key === '#') return 'Digit3';
    if (key === '$') return 'Digit4';
    if (key === '%') return 'Digit5';
    if (key === '^') return 'Digit6';
    if (key === '&') return 'Digit7';
    if (key === '*') return 'Digit8';
    if (key === '(') return 'Digit9';
    if (key === ')') return 'Digit0';
    if (key === '+' && location === 3) return 'NumpadAdd';
    if (key === '-' && location === 3) return 'NumpadSubtract';
    if (key === '+' || key === '=') return 'Equal';
    if (key === '-' || key === '_') return 'Minus';
    if (key === '/' || key === '?') return 'Slash';
    if (key === ',' || key === '<') return 'Comma';
    if (key === '.' || key === '>') return 'Period';
    if (key === ';' || key === ':') return 'Semicolon';
    if (key === "'" || key === '"') return 'Quote';
    if (key === '[' || key === '{') return 'BracketLeft';
    if (key === ']' || key === '}') return 'BracketRight';
    if (key === '\\' || key === '|') return 'Backslash';
  }
  return null;
}

/** Returns best-effort canonical key code across desktop + Safari/iOS keyboard event variants. */
function normalizeInputCode(event: KeyboardEvent): string {
  if (event.code && event.code !== 'Unidentified') {
    return event.code;
  }
  return codeFromKey(event.key, event.location) ?? event.code ?? '';
}

/** Wires global keyboard/paste input handlers and routes events by current mode. */
function setupInputHandlers(): void {
  document.addEventListener('keydown', (event) => {
    const code = normalizeInputCode(event);
    if (!code) return;

    if (!dom.settingsModal.classList.contains('hidden') && code === 'Escape') {
      closeSettings();
      return;
    }

    if (!state.running) return;
    if (document.activeElement !== dom.canvas) return;
    if (event.altKey) return;
    if (event.ctrlKey && !isTextEditingMode(state.mode)) return;
    if (activeTeleport && code.startsWith('Arrow')) {
      event.preventDefault();
      return;
    }

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
        pianoUse: (currentCode) => {
          itemBehaviorRegistry.handleModeInput(state.mode, currentCode);
        },
        effectSelect: (currentCode, currentKey) => handleEffectSelectModeInput(currentCode, currentKey),
        helpView: (currentCode) => handleHelpViewModeInput(currentCode),
        listUsers: (currentCode, currentKey) => handleListModeInput(currentCode, currentKey),
        listItems: (currentCode, currentKey) => handleListItemsModeInput(currentCode, currentKey),
        addItem: (currentCode, currentKey) => handleAddItemModeInput(currentCode, currentKey),
        selectItem: (currentCode, currentKey) => handleSelectItemModeInput(currentCode, currentKey),
        adminMenu: (currentCode, currentKey) => handleAdminMenuModeInput(currentCode, currentKey),
        adminRoleList: (currentCode, currentKey) => handleAdminRoleListModeInput(currentCode, currentKey),
        adminRolePermissionList: (currentCode, currentKey) => handleAdminRolePermissionListModeInput(currentCode, currentKey),
        adminRoleDeleteReplacement: (currentCode, currentKey) => handleAdminRoleDeleteReplacementModeInput(currentCode, currentKey),
        adminUserList: (currentCode, currentKey) => handleAdminUserListModeInput(currentCode, currentKey),
        adminUserRoleSelect: (currentCode, currentKey) => handleAdminUserRoleSelectModeInput(currentCode, currentKey),
        adminRoleNameEdit: (currentCode, currentKey, currentCtrlKey) =>
          handleAdminRoleNameEditModeInput(currentCode, currentKey, currentCtrlKey),
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
    const code = normalizeInputCode(event);
    if (state.mode === 'pianoUse' && code) {
      itemBehaviorRegistry.handleModeKeyUp(state.mode, code);
    }
    if (code) {
      state.keysPressed[code] = false;
    }
    if (event.code && event.code !== code) {
      state.keysPressed[event.code] = false;
    }
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
  });
  dom.showRegisterButton.addEventListener('click', () => {
    if (authMode === 'login') {
      setAuthMode('register');
      dom.registerUsername.focus();
    } else {
      setAuthMode('login');
      dom.authUsername.focus();
    }
  });
  dom.logoutButton.addEventListener('click', () => {
    logOutAccount();
  });
  dom.authUsername.addEventListener('input', () => {
    dom.authUsername.value = sanitizeAuthUsername(dom.authUsername.value);
    updateConnectAvailability();
  });
  dom.authPassword.addEventListener('input', () => {
    updateConnectAvailability();
  });
  dom.registerUsername.addEventListener('input', () => {
    dom.registerUsername.value = sanitizeAuthUsername(dom.registerUsername.value);
    updateConnectAvailability();
  });
  dom.registerPassword.addEventListener('input', () => {
    updateConnectAvailability();
  });
  dom.registerPasswordConfirm.addEventListener('input', () => {
    updateConnectAvailability();
  });
  dom.registerEmail.addEventListener('input', () => {
    updateConnectAvailability();
  });

  const submitAuthOnEnter = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    if (dom.connectButton.disabled) return;
    event.preventDefault();
    connect();
  };
  dom.authUsername.addEventListener('keydown', submitAuthOnEnter);
  dom.authPassword.addEventListener('keydown', submitAuthOnEnter);
  dom.registerUsername.addEventListener('keydown', submitAuthOnEnter);
  dom.registerPassword.addEventListener('keydown', submitAuthOnEnter);
  dom.registerPasswordConfirm.addEventListener('keydown', submitAuthOnEnter);
  dom.registerEmail.addEventListener('keydown', submitAuthOnEnter);
}

setupInputHandlers();
setupUiHandlers();
dom.authUsername.value = sanitizeAuthUsername(authUsername);
dom.registerUsername.value = sanitizeAuthUsername(authUsername);
loadPersistedAuthPolicy();
setAuthMode('login');
updateConnectAvailability();
updateDeviceSummary();
setConnectionStatus(
  isVersionReloadedSession()
    ? 'Client updated, please reconnect.'
    : 'Welcome to the Chat Grid, your immersive audio playground. Configure your audio, then Log in or register to join the grid.',
);
