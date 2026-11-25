import { formatCoordinate, formatLocationReadout } from './state/locationReadout';
import './styles.css';
import { resolveArrowMovement } from './input/movement';
import { AudioEngine, type SpatialAudioPosition } from './audio/audioEngine';
import { resolveWorldItemSourcePosition } from './audio/worldItemPosition';
import {
  EFFECT_SEQUENCE,
} from './audio/effects';
import {
  RadioStationRuntime,
} from './audio/radioStationRuntime';
import { getProxyUrlForMedia, shouldProxyExternalMediaUrl } from './audio/mediaUrl';
import { withAppBase as withBase } from './appPath';
import { ItemEmitRuntime } from './audio/itemEmitRuntime';
import { AmbianceRuntime } from './audio/ambianceRuntime';
import { TeleportTransitionController } from './audio/teleportTransition';
import { ElevatorAudioRuntime } from './items/types/elevator/runtime';
import { AcousticZoneRuntime, elevatorAcousticZoneId, worldItemAcousticZoneId } from './audio/acousticZones';
import { WorldAudioRouter, WORLD_FOOTSTEP_GAIN } from './audio/worldAudio';
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
import { formatCommandMenuLabel, type CommandDescriptor, type ModeInput } from './input/commandTypes';
import { getAvailableMainModeCommands } from './input/mainModeCommands';
import { describeHeldItems, formatCarryingSuffix, getCarriedItems } from './items/carriedItems';
import { getInteractionItems } from './items/itemTargets';
import { resolveMainModeCommand, type MainModeCommand } from './input/mainCommandRouter';
import { dispatchModeInput } from './input/modeDispatcher';
import { handleListControlKey, handleMenuRowKey } from './input/listController';
import { createAdminController, type AdminMenuAction } from './input/adminController';
import { createDoorControls } from './input/doorControls';
import { adjacentDoors } from './state/structureGeometry';
import { createWorldBuilderController } from './input/worldBuilderController';
import { setupKeyboardInputHandlers } from './input/keyboardController';
import {
  setupMobileControls,
  type MobileCommand,
  type MobileController,
  type MobileTextEntry,
} from './input/mobileController';
import { getEditSessionAction } from './input/editSession';
import { createOptionSelector } from './input/optionSelector';
import { createElevatorControls } from './items/types/elevator/controls';
import { createConfirmationController } from './input/confirmationController';
import { formatSteppedNumber, snapNumberToStep } from './input/numeric';
import { adjustPropertyValue, applyNumericPropertyKey, announcePropertyValue } from './input/propertyControls';
import { type IncomingMessage, type OutgoingMessage } from './network/protocol';
import { createOnMessageHandler } from './network/messageHandlers';
import { SignalingClient } from './network/signalingClient';
import { nextHeartbeatState } from './network/reconnectPolicy';
import { CanvasRenderer } from './render/canvasRenderer';
import { canWalkTo, listTeleportTravel, nearestLanding, platformAt } from './state/platformGeometry';
import type { FootstepSet } from './state/platformGeometry';
import { footstepSample } from './audio/footsteps';
import {
  GRID_SIZE,
  MOVE_COOLDOWN_MS,
  createInitialState,
  getDirection,
  getFacingDirection,
  getNearestItem,
  getNearestItemPosition,
  getNearestPeer,
  isItemOnFloor,
  itemOccupiesPosition,
  hasItemBounds,
  itemBounds,
  type StructurePreset,
  type GameMode,
  type PeerState,
  type WorldItem,
} from './state/gameState';
import {
  adjacentWallDescriptions,
  blockingWallForMove,
  buildWallEdgeIndex,
  wallsCrossedForMove,
  wallAcousticMixBetween,
} from './state/structureGeometry';
import {
  applyServerItemUiDefinitions,
  getItemManagementActionMetadata,
  getServerMainModeCommandMetadata,
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
import { createItemInteractionController } from './items/itemInteractionController';
import { createItemPropertyEditor } from './items/itemPropertyEditor';
import { createItemPropertyPresentation } from './items/itemPropertyPresentation';
import { ItemBehaviorRegistry } from './items/types/behaviorRegistry';
import { SettingsStore } from './settings/settingsStore';
import { VoiceMutePreferences } from './settings/voiceMutePreferences';
import { getUserActions } from './input/userActions';
import { createAuthController } from './session/authController';
import { runConnectFlow, runDisconnectFlow, type ConnectFlowDeps } from './session/connectionFlow';
import { RECONNECT_MAX_ATTEMPTS, runReconnectAttempts } from './session/reconnect';
import { MediaSession } from './session/mediaSession';
import { type AudioLayerState } from './types/audio';
import { setupUiHandlers as setupDomUiHandlers } from './ui/domBindings';
import { formatLastSeen } from './ui/lastSeen';
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
const MIC_GAIN_METADATA = {
  valueType: 'number',
  range: { min: MIC_CALIBRATION_MIN_GAIN, max: MIC_CALIBRATION_MAX_GAIN, step: MIC_INPUT_GAIN_STEP },
};
const HEARTBEAT_INTERVAL_MS = 10_000;
const AUDIO_SUBSCRIPTION_REFRESH_MS = 500;
const AUTH_POLICY_STORAGE_KEY = 'chgridAuthPolicy';

declare global {
  interface Window {
    CHGRID_RELEASE_VERSION?: string;
    CHGRID_CLIENT_REVISION?: string;
  }
}

type Dom = {
  gridTitle: HTMLElement;
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
  helpSection: HTMLElement;
  helpToggle: HTMLButtonElement;
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
  mobileControls: HTMLElement;
  mobileControlsBody: HTMLElement;
  mobileControlsToggle: HTMLButtonElement;
  mobileControlsEnabled: HTMLInputElement;
  mobileUp: HTMLButtonElement;
  mobileDown: HTMLButtonElement;
  mobileLeft: HTMLButtonElement;
  mobileRight: HTMLButtonElement;
  mobileUse: HTMLButtonElement;
  mobileBack: HTMLButtonElement;
  mobileChat: HTMLButtonElement;
  mobileCommands: HTMLButtonElement;
  mobileMute: HTMLButtonElement;
  mobileCommandDialog: HTMLDialogElement;
  mobileSelectedUserRow: HTMLButtonElement;
  mobileCommandTitle: HTMLElement;
  mobileCommandList: HTMLElement;
  mobileCommandClose: HTMLButtonElement;
  mobileTextEntry: HTMLFormElement;
  mobileTextEntryLabel: HTMLLabelElement;
  mobileTextInput: HTMLInputElement;
  mobileTextSubmit: HTMLButtonElement;
  mobileTextCancel: HTMLButtonElement;
};

const dom: Dom = {
  gridTitle: requiredById('gridTitle'),
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
  helpSection: requiredById('helpSection'),
  helpToggle: requiredById('helpToggle'),
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
  mobileControls: requiredById('mobileControls'),
  mobileControlsBody: requiredById('mobileControlsBody'),
  mobileControlsToggle: requiredById('mobileControlsToggle'),
  mobileControlsEnabled: requiredById('mobileControlsEnabled'),
  mobileUp: requiredById('mobileUp'),
  mobileDown: requiredById('mobileDown'),
  mobileLeft: requiredById('mobileLeft'),
  mobileRight: requiredById('mobileRight'),
  mobileUse: requiredById('mobileUse'),
  mobileBack: requiredById('mobileBack'),
  mobileChat: requiredById('mobileChat'),
  mobileCommands: requiredById('mobileCommands'),
  mobileMute: requiredById('mobileMute'),
  mobileCommandDialog: requiredById('mobileCommandDialog'),
  mobileSelectedUserRow: requiredById('mobileSelectedUserRow'),
  mobileCommandTitle: requiredById('mobileCommandTitle'),
  mobileCommandList: requiredById('mobileCommandList'),
  mobileCommandClose: requiredById('mobileCommandClose'),
  mobileTextEntry: requiredById('mobileTextEntry'),
  mobileTextEntryLabel: requiredById('mobileTextEntryLabel'),
  mobileTextInput: requiredById('mobileTextInput'),
  mobileTextSubmit: requiredById('mobileTextSubmit'),
  mobileTextCancel: requiredById('mobileTextCancel'),
};

type ChangelogSection = {
  date: string;
  items: Array<string | { text: string; thanks: string }>;
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

/** Announces standardized menu entry as `Title. First option.` */
function announceMenuEntry(title: string, firstOption: string): void {
  const trimmedTitle = title.trim();
  const trimmedOption = firstOption.trim();
  const titleSuffix = /[.!?]$/.test(trimmedTitle) ? '' : '.';
  const optionSuffix = /[.!?]$/.test(trimmedOption) ? '' : '.';
  updateStatus(`${trimmedTitle}${titleSuffix} ${trimmedOption}${optionSuffix}`);
  audio.sfxUiBlip();
}

const APP_RELEASE_VERSION = String(window.CHGRID_RELEASE_VERSION ?? '').trim();
const APP_CLIENT_REVISION = String(window.CHGRID_CLIENT_REVISION ?? '').trim();
const APP_DISPLAY_VERSION = [APP_RELEASE_VERSION, APP_CLIENT_REVISION].filter((value) => value.length > 0).join(' ').trim();
dom.appVersion.textContent = APP_DISPLAY_VERSION
  ? `Another AI experiment with Jage. Version ${APP_DISPLAY_VERSION}`
  : 'Another AI experiment with Jage. Version unknown';
const DEFAULT_GRID_NAME = 'Chat Grid';
const DEFAULT_WELCOME_MESSAGE =
  'Welcome to the Chat Grid, your immersive audio playground. Configure your audio, then Log in or register to join the grid.';
const SYSTEM_SOUND_URLS = {
  logon: withBase('sounds/logon.ogg'),
  logout: withBase('sounds/logout.ogg'),
  notify: withBase('sounds/notify.ogg'),
} as const;
const AUTH_SESSION_COOKIE_SET_URL = withBase('auth/session/set');
const AUTH_SESSION_COOKIE_CLEAR_URL = withBase('auth/session/clear');
const AUTH_SESSION_COOKIE_CLIENT_HEADER = 'X-Chgrid-Auth-Client';
const ACTION_SOUND_URL = withBase('sounds/action.ogg');
let footstepSets: FootstepSet[] = [];
const TELEPORT_START_SOUND_URL = withBase('sounds/teleport_start.ogg');
const TELEPORT_START_GAIN = 0.1;
const TELEPORT_SOUND_URL = withBase('sounds/teleport.ogg');
const WALL_SOUND_URL = withBase('sounds/wall.ogg');

const state = createInitialState();
const renderer = new CanvasRenderer(dom.canvas);
const audio = new AudioEngine();
const settings = new SettingsStore();
const voiceMutes = new VoiceMutePreferences(settings);
let worldGridSize = GRID_SIZE;
let movementTickMs = MOVE_COOLDOWN_MS;
let wallEdgeIndex = buildWallEdgeIndex(state.structures.values());
let lastWallCollisionDirection: string | null = null;
let statusTimeout: number | null = null;
let lastFocusedElement: Element | null = null;
let lastAnnouncementText = '';
let lastAnnouncementAt = 0;
let outputMode = settings.loadOutputMode();
let activeGridName = DEFAULT_GRID_NAME;
let activeWelcomeMessage = DEFAULT_WELCOME_MESSAGE;
const messageBuffer: string[] = [];
let messageCursor = -1;
const acousticZoneRuntime = new AcousticZoneRuntime();
let audioLayers: AudioLayerState = {
  voice: true,
  item: true,
  media: true,
  world: true,
};

function wallAcousticMixTo(sourceX: number, sourceY: number, sourceZ: number) {
  return wallAcousticMixBetween(
    state.structures.values(),
    { x: state.player.x, y: state.player.y, z: state.player.z },
    { x: sourceX, y: sourceY, z: sourceZ },
    wallEdgeIndex,
  );
}

function resolveWorldAcousticMix(source: SpatialAudioPosition, listener: SpatialAudioPosition) {
  const wall = wallAcousticMixBetween(state.structures.values(), listener, source, wallEdgeIndex);
  return {
    gain: acousticZoneRuntime.transmission(listener.acousticZoneId, source.acousticZoneId, state.items) * wall.gain,
    lowpassHz: wall.lowpassHz,
  };
}

function itemAcousticMix(item: WorldItem) {
  return resolveWorldAcousticMix({
    ...resolveWorldItemSourcePosition(item, state.player.z, state.player.x, state.player.y),
    acousticZoneId: worldItemAcousticZoneId(item, state),
  }, state.player);
}

const ambianceRuntime = new AmbianceRuntime(audio, resolveWorldAcousticMix);
const radioRuntime = new RadioStationRuntime(
  audio,
  getItemSpatialConfig,
  itemAcousticMix,
  (item) => acousticZoneRuntime.couldConnect(
    state.player.acousticZoneId,
    worldItemAcousticZoneId(item, state),
    state.items,
  ),
);
const itemEmitRuntime = new ItemEmitRuntime(
  audio,
  resolveIncomingSoundUrl,
  getItemSpatialConfig,
  itemAcousticMix,
  (item) => acousticZoneRuntime.couldConnect(
    state.player.acousticZoneId,
    worldItemAcousticZoneId(item, state),
    state.items,
  ),
);
const elevatorAudioRuntime = new ElevatorAudioRuntime(
  audio,
  resolveIncomingSoundUrl,
  getItemSpatialConfig,
  () => state.elevatorItemId,
  (item) => resolveWorldAcousticMix({
    x: item.x, y: item.y, z: Number(item.params.currentZ), acousticZoneId: elevatorAcousticZoneId(item.id),
  }, state.player),
);
const worldAudio = new WorldAudioRouter(
  audio,
  () => ({
    x: state.player.x,
    y: state.player.y,
    z: state.player.z,
    acousticZoneId: state.player.acousticZoneId,
  }),
  () => audioLayers.world,
  resolveWorldAcousticMix,
  (source, listener) => acousticZoneRuntime.canTransmit(
    listener.acousticZoneId,
    source.acousticZoneId,
    state.items,
  ),
);
let replaceTextOnNextType = false;
let pendingEscapeDisconnect = false;
let micGainLoopbackRestoreState: boolean | null = null;
let mainHelpViewerLines: string[] = [];
let helpViewerLines: string[] = [];
let helpViewerIndex = 0;
let helpViewerReturnMode: GameMode = 'normal';
const commandPaletteCommands: Array<CommandDescriptor & { run: () => void | Promise<void> }> = [];
let commandPaletteIndex = 0;
let commandPaletteReturnMode: GameMode = 'normal';
let heartbeatTimerId: number | null = null;
let heartbeatNextPingId = -1;
let heartbeatAwaitingPong = false;
let heartbeatMissedPongs = 0;
let reconnectInFlight = false;
let reconnectAbort: AbortController | null = null;
let connectionAbort: AbortController | null = null;
let activeServerInstanceId: string | null = null;
let reloadScheduledForVersionMismatch = false;
let peerListenGainByNickname = settings.loadPeerListenGains();
let lastSubscriptionRefreshAt = 0;
let lastSubscriptionRefreshTileX = Math.round(state.player.x);
let lastSubscriptionRefreshTileY = Math.round(state.player.y);
let lastSubscriptionRefreshTileZ = state.player.z;
let subscriptionRefreshInFlight = false;
let subscriptionRefreshPending = false;
let activeTeleportLoopStop: (() => void) | null = null;
let activeTeleportLoopToken = 0;
let mobileControls: MobileController | null = null;
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
      syncIntermediatePositions: boolean;
      completionStatus: string;
    }
  | null = null;

const signalingProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const signalingUrl = `${signalingProtocol}://${window.location.host}${withBase('ws')}`;
const signaling = new SignalingClient(signalingUrl, handleSignalingStatus);

const peerManager = new PeerManager(audio, updateStatus, {
  isSessionRunning: () => state.running,
  requestToken: () => signaling.send({ type: 'livekit_token_request' }),
});

peerManager.setVoiceMuteResolver((peer) => voiceMutes.isMuted(state.peers.get(peer.id) ?? peer));

const teleportTransition = new TeleportTransitionController({
  setWorldTransitionGain: (gain, durationMs) => audio.setWorldTransitionGain(gain, durationMs),
  onStart: () => {
    activeTeleport = null;
    stopTeleportLoopAudio();
    const token = ++activeTeleportLoopToken;
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) state.keysPressed[key] = false;
    lastWallCollisionDirection = null;
    void audio.startLoopingSample(TELEPORT_START_SOUND_URL, TELEPORT_START_GAIN).then((stop) => {
      if (teleportTransition.isActive() && token === activeTeleportLoopToken) activeTeleportLoopStop = stop;
      else stop?.();
    });
  },
  onArrive: () => { void refreshAudioSubscriptions(true); },
  onComplete: () => {
    stopTeleportLoopAudio();
    activeTeleportLoopToken += 1;
    void audio.playSample(TELEPORT_SOUND_URL, WORLD_FOOTSTEP_GAIN);
  },
  onCancel: () => {
    stopTeleportLoopAudio();
    activeTeleportLoopToken += 1;
    updateStatus('Teleport cancelled.');
  },
});

/** Synchronizes voice subscriptions with the server-authoritative acoustic zones. */
function refreshAcousticModel(): void {
  acousticZoneRuntime.sync(state.items.values());
  peerManager.setSubscriptionResolver((peer) => acousticZoneRuntime.couldConnect(
    state.player.acousticZoneId,
    peer.acousticZoneId,
    state.items,
  ));
}
const mediaSession = new MediaSession({
  isVoiceSendAllowed: () => authController.getVoiceSendAllowed(),
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
  getWallAcousticMix: (sourceX, sourceY, sourceZ) => wallAcousticMixTo(sourceX, sourceY, sourceZ),
});

audio.setOutputMode(outputMode);
audio.setSpatialMode(settings.loadSpatialMode());

loadEffectLevels();
loadAudioLayerState();
loadMicInputGain();
loadMasterVolume();
void loadHelp();
void itemBehaviorRegistry.initialize();
void loadChangelog();
void loadClientBranding();

function applyGridBranding(gridName: string | null | undefined, welcomeMessage: string | null | undefined): void {
  const nextGridName = String(gridName ?? '').trim() || DEFAULT_GRID_NAME;
  const nextWelcomeMessage = String(welcomeMessage ?? '').trim() || DEFAULT_WELCOME_MESSAGE;
  activeGridName = nextGridName;
  activeWelcomeMessage = nextWelcomeMessage;
  document.title = nextGridName;
  dom.gridTitle.textContent = nextGridName;
  dom.focusGridButton.textContent = nextGridName;
  dom.canvas.setAttribute('aria-label', `${nextGridName}, press question mark for help.`);
}

async function loadClientBranding(): Promise<void> {
  try {
    const response = await fetch(withBase('client_branding.json'), { cache: 'no-store' });
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as { gridName?: unknown; welcomeMessage?: unknown };
    applyGridBranding(
      typeof data.gridName === 'string' ? data.gridName : null,
      typeof data.welcomeMessage === 'string' ? data.welcomeMessage : null,
    );
    if (!state.running && !isVersionReloadedSession()) {
      setConnectionStatus(activeWelcomeMessage);
    }
  } catch {
    // Branding falls back to built-in defaults when deploy-time branding is unavailable.
  }
}

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
const authController = createAuthController({
  dom,
  authPolicyStorageKey: AUTH_POLICY_STORAGE_KEY,
  authSessionCookieSetUrl: AUTH_SESSION_COOKIE_SET_URL,
  authSessionCookieClearUrl: AUTH_SESSION_COOKIE_CLEAR_URL,
  authSessionCookieClientHeader: AUTH_SESSION_COOKIE_CLIENT_HEADER,
  initialAuthUsername: settings.loadAuthUsername(),
  isRunning: () => state.running,
  isMuted: () => state.isMuted,
  isConnecting: () => mediaSession.isConnecting(),
  setConnecting: (value) => mediaSession.setConnecting(value),
  applyMuteToTrack: (muted) => {
    mediaSession.applyMuteToTrack(muted);
  },
  signalingSend: (message) => signaling.send(message),
  disconnect,
  saveAuthUsername: (username) => {
    settings.saveAuthUsername(username);
  },
  setConnectionStatus,
  updateStatus,
  pushChatMessage,
  onServerAdminMenuActions: (actions) => {
    adminController.setServerAdminMenuActions(actions);
  },
});
const adminController = createAdminController({
  state,
  signalingSend: (message) => signaling.send(message),
  announceMenuEntry,
  updateStatus,
  sfxUiBlip: () => audio.sfxUiBlip(),
  sfxUiCancel: () => audio.sfxUiCancel(),
  applyTextInputEdit,
  setReplaceTextOnNextType: (value) => {
    replaceTextOnNextType = value;
  },
});
const optionSelector = createOptionSelector({
  state,
  announceMenuEntry,
  updateStatus,
  blip: () => audio.sfxUiBlip(),
  cancel: () => audio.sfxUiCancel(),
});
const elevatorControls = createElevatorControls({
  state,
  choose: (request) => optionSelector.open(request),
  closeChoice: (request) => optionSelector.close(request),
  refreshChoice: (active, next) => optionSelector.refresh(active, next),
  send: (packet) => signaling.send(packet),
  updateStatus,
});
const confirmationController = createConfirmationController({
  state,
  announceMenuEntry,
  updateStatus,
  blip: () => audio.sfxUiBlip(),
  cancel: () => audio.sfxUiCancel(),
});
const doorControls = createDoorControls({
  blip: () => audio.sfxUiBlip(),
  textState: state,
  applyTextInputEdit,
  setReplaceTextOnNextType: (value) => { replaceTextOnNextType = value; },
  setMode: (mode) => { state.mode = mode; },
  getWall: (id) => state.structures.get(id),
  send: (message) => signaling.send(message),
  choose: (request) => optionSelector.open(request),
  confirm: (request) => confirmationController.open(request),
  status: updateStatus, normal: () => { state.mode = 'normal'; },
  focusGrid: () => dom.canvas.focus(), hasPlatform: (x, y, z) => Boolean(platformAt(state.platforms, x, y, z)),
  cue: (success) => success ? audio.sfxUiConfirm() : audio.sfxUiCancel(),
  keypadSound: (name) => audio.playSample(resolveIncomingSoundUrl(`/sounds/${name}.ogg`), 1, 0, true),
});
const worldBuilderController = createWorldBuilderController({
  editDoors: doorControls.edit,
  state,
  hasPermission: (key) => authController.hasPermission(key),
  send: (message) => signaling.send(message),
  updateStatus,
  announceMenuEntry,
  blip: () => audio.sfxUiBlip(),
  confirm: () => audio.sfxUiConfirm(),
  cancel: () => audio.sfxUiCancel(),
  applyTextInputEdit,
  setReplaceTextOnNextType: (value) => {
    replaceTextOnNextType = value;
  },
  openOptionSelector: (request) => optionSelector.open(request),
  openConfirmation: (request) => confirmationController.open(request),
});
const itemInteractionController = createItemInteractionController({
  onBeginProperties: () => itemPropertyEditor.reset(),
  state,
  signalingSend: (message) => signaling.send(message),
  announceMenuEntry,
  updateStatus,
  sfxUiBlip: () => audio.sfxUiBlip(),
  sfxUiCancel: () => audio.sfxUiCancel(),
  hasPermission: (key) => authController.hasPermission(key),
  getAuthUserId: () => authController.getAuthUserId(),
  getItemManagementActionMetadata,
  itemLabel,
  getEditableItemPropertyKeys,
  getInspectItemPropertyKeys,
  getItemPropertyValue,
  itemPropertyLabel,
  useItem: (item) => useItem(item),
  pickupDropItem,
  secondaryUseItem: (item) => secondaryUseItem(item),
  openConfirmation: (request) => confirmationController.open(request),
});

/** Toggles updates panel visibility and syncs associated ARIA state. */
function setUpdatesExpanded(expanded: boolean): void {
  dom.updatesToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  dom.updatesToggle.textContent = expanded ? 'Hide updates' : 'Show updates';
  dom.updatesPanel.hidden = !expanded;
  dom.updatesPanel.classList.toggle('hidden', !expanded);
}

/** Toggles help panel visibility and syncs associated ARIA state. */
function setHelpExpanded(expanded: boolean): void {
  dom.helpToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  dom.helpToggle.textContent = expanded ? 'Hide help' : 'Show help';
  dom.instructions.hidden = !expanded;
  dom.instructions.classList.toggle('hidden', !expanded);
}

/** Renders help sections into the footer help container and builds linearized viewer lines. */
function renderHelp(help: HelpData): void {
  const lines = buildHelpLines(help);
  dom.instructions.innerHTML = '';
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
  dom.helpSection.classList.remove('hidden');
  setHelpExpanded(false);
}

/** Loads runtime help content from `help.json` and applies it when available. */
async function loadHelp(): Promise<void> {
  try {
    const response = await fetch(withBase('help.json'), { cache: 'no-store' });
    if (!response.ok) {
      dom.helpSection.classList.add('hidden');
      return;
    }
    const help = (await response.json()) as HelpData;
    if (!Array.isArray(help.sections) || help.sections.length === 0) {
      dom.helpSection.classList.add('hidden');
      return;
    }
    renderHelp(help);
    dom.helpToggle.addEventListener('click', () => {
      const expanded = dom.helpToggle.getAttribute('aria-expanded') === 'true';
      setHelpExpanded(!expanded);
    });
  } catch {
    dom.helpSection.classList.add('hidden');
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
      if (typeof item === 'string') {
        li.textContent = item;
      } else {
        const profile = document.createElement('a');
        profile.href = `https://github.com/${encodeURIComponent(item.thanks)}`;
        profile.textContent = `@${item.thanks}`;
        li.append(item.text, ' Thanks ', profile, '.');
      }
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

/** Enables/disables the connect button based on state and nickname validity. */
function updateConnectAvailability(): void {
  authController.updateConnectAvailability();
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
  ambianceRuntime.update(state.ambiances.values(), state.player, audioLayers.world && state.running);
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
  ambianceRuntime.update(state.ambiances.values(), state.player, audioLayers.world && state.running);
  audio.setVoiceLayerEnabled(audioLayers.voice);
  if (audioLayers.voice) {
    await peerManager.resumeRemoteAudio();
  } else {
    peerManager.suspendRemoteAudio();
  }
  const listenerPosition = { x: state.player.x, y: state.player.y, z: state.player.z };
  await radioRuntime.setLayerEnabled(audioLayers.media, state.items.values(), listenerPosition);
  await itemEmitRuntime.setLayerEnabled(audioLayers.item, state.items.values(), listenerPosition);
  await elevatorAudioRuntime.setLayerEnabled(audioLayers.item, state.items.values(), listenerPosition);
}

/** Refreshes distance-gated radio/item stream subscriptions for a listener position. */
async function refreshAudioSubscriptionsAt(listenerPosition: { x: number; y: number; z: number }, force = false): Promise<void> {
  await refreshAudioSubscriptionsForListeners([listenerPosition], force);
}

/** Refreshes distance-gated radio/item stream subscriptions for one or more listener positions. */
async function refreshAudioSubscriptionsForListeners(
  listenerPositions: Array<{ x: number; y: number; z: number }>,
  force = false,
): Promise<void> {
  if (!state.running) return;
  if (listenerPositions.length === 0) return;
  const now = Date.now();
  const anchorListener = listenerPositions[listenerPositions.length - 1];
  const tileX = Math.round(anchorListener.x);
  const tileY = Math.round(anchorListener.y);
  const tileZ = Math.round(anchorListener.z);
  const moved = tileX !== lastSubscriptionRefreshTileX || tileY !== lastSubscriptionRefreshTileY || tileZ !== lastSubscriptionRefreshTileZ;
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
  lastSubscriptionRefreshTileZ = tileZ;
  try {
    await radioRuntime.sync(state.items.values(), listenerPositions);
    await itemEmitRuntime.sync(state.items.values(), listenerPositions);
    await elevatorAudioRuntime.sync(state.items.values(), anchorListener);
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
        { x: activeTeleport.startX, y: activeTeleport.startY, z: state.player.z },
        { x: activeTeleport.targetX, y: activeTeleport.targetY, z: state.player.z },
      ],
      force,
    );
    return;
  }
  await refreshAudioSubscriptionsAt({ x: state.player.x, y: state.player.y, z: state.player.z }, force);
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
function reloadClientForVersion(versionToken: string): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('v', versionToken || 'unknown');
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
    return shouldProxyExternalMediaUrl(raw) ? getProxyUrlForMedia(raw) : raw;
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
    .filter((peer) => peer.x === x && peer.y === y && peer.z === state.player.z)
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
  return Array.from(state.items.values()).filter(
    (item) => !item.carrierId && itemOccupiesPosition(item, x, y, state.player.z),
  );
}

/** Formats a complete world location for speech and lists. */
function locationPhrase(x: number, y: number, z: number): string {
  return formatLocationReadout(state, { x, y, z });
}

/** Formats a user's floor for cross-floor teleport feedback. */
function floorPositionPhrase(x: number, y: number, z: number): string {
  const configuredFloor = platformAt(state.platforms, x, y, z)?.name;
  if (configuredFloor) return `on ${configuredFloor}`;
  return `at height ${formatCoordinate(z)}`;
}

/** Returns held items and items occupying the current square for action selection. */
function getCurrentInteractionItems(): WorldItem[] {
  return getInteractionItems(state.items.values(), state.player);
}

/** Opens the shared item-selection flow for the provided context and items. */
function beginItemSelection(
  context: 'pickupDrop' | 'delete' | 'edit' | 'use' | 'secondaryUse' | 'inspect' | 'manage',
  items: WorldItem[],
): void {
  itemInteractionController.beginItemSelection(context, items);
}

/** Builds available item-management actions for one selected item. */
function itemManagementOptionsFor(item: WorldItem) {
  return itemInteractionController.getManagementOptions(item);
}

/** Opens item-management options for one selected item. */
function beginItemManagement(item: WorldItem): void {
  itemInteractionController.beginItemManagement(item);
}

/** Opens item property browsing/editing mode for one item. */
function beginItemProperties(item: WorldItem, showAll = false): void {
  itemInteractionController.beginItemProperties(item, showAll);
}

/** Recomputes visible property rows for the active item-property view after item updates. */
function recomputeActiveItemPropertyKeys(itemId: string): void {
  itemInteractionController.recomputeActiveItemPropertyKeys(itemId);
}

/** Sends an item-use request for the selected item. */
function useItem(item: WorldItem): void {
  signaling.send({ type: 'item_use', itemId: item.id });
}

/** Sends an item secondary-use request for the selected item. */
function secondaryUseItem(item: WorldItem): void {
  signaling.send({ type: 'item_secondary_use', itemId: item.id });
}

/** Returns the active text-input max length for the current UI mode, if applicable. */
function textInputMaxLengthForMode(mode: typeof state.mode): number | null {
  if (mode === 'doorSettingsEdit' && !doorControls.isSecretSettingsEdit()) return doorControls.getSettingsTextEntry()?.maxLength ?? null;
  if (mode === 'nickname') return NICKNAME_MAX_LENGTH;
  if (mode === 'chat') return 500;
  if (mode === 'itemPropertyEdit') return 500;
  if (mode === 'micGainEdit') return 8;
  if (mode === 'adminRoleNameEdit') return 32;
  if (mode === 'checkpointLabel') return 100;
  if (mode === 'worldBuilderPlatformEdit') return worldBuilderController.getEditingPlatformMaxLength();
  if (mode === 'worldBuilderPropertyEdit') return 200;
  if (mode === 'worldBuilderAmbianceEdit' || mode === 'worldBuilderRegionEdit') return 100;
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
    (mode === 'doorSettingsEdit' && !doorControls.isSecretSettingsEdit()) ||
    mode === 'nickname' ||
    mode === 'chat' ||
    mode === 'itemPropertyEdit' ||
    mode === 'micGainEdit' ||
    mode === 'adminRoleNameEdit' ||
    mode === 'checkpointLabel' ||
    mode === 'worldBuilderPropertyEdit' ||
    mode === 'worldBuilderAmbianceEdit' ||
    mode === 'worldBuilderPlatformEdit' ||
    mode === 'worldBuilderRegionEdit'
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

/** Picks one random footstep sample URL. */
function randomFootstepUrl(x: number, y: number, z: number): string {
  return resolveIncomingSoundUrl(footstepSample(footstepSets, platformAt(state.platforms, x, y, z)?.footstepSet));
}

/** Stops active teleport loop audio, if one is running. */
function stopTeleportLoopAudio(): void {
  if (!activeTeleportLoopStop) return;
  activeTeleportLoopStop();
  activeTeleportLoopStop = null;
}

/** Starts animated teleport movement toward a target tile at fixed squares-per-second pace. */
function startTeleportTo(targetX: number, targetY: number, completionStatus: string): void {
  if (teleportTransition.isActive()) return;
  const startX = state.player.x;
  const startY = state.player.y;
  const travel = listTeleportTravel(state.platforms, state.player, targetX, targetY);
  if (!travel) {
    updateStatus('No platform at that destination.');
    audio.sfxUiCancel();
    return;
  }
  const nowMs = performance.now();
  activeTeleport = {
    startX,
    startY,
    targetX,
    targetY,
    startedAtMs: nowMs,
    ...travel,
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
      { x: startX, y: startY, z: state.player.z },
      { x: targetX, y: targetY, z: state.player.z },
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

  if (
    activeTeleport.syncIntermediatePositions
    && nowMs - activeTeleport.lastSyncAtMs >= movementTickMs
  ) {
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
      signaling.send({ type: 'update_position', x: syncX, y: syncY, z: state.player.z });
    }
  }

  if (progress < 1) {
    return;
  }
  const completionStatus = activeTeleport.completionStatus;
  state.player.x = activeTeleport.targetX;
  state.player.y = activeTeleport.targetY;
  signaling.send({ type: 'teleport_complete', x: activeTeleport.targetX, y: activeTeleport.targetY, z: state.player.z });
  activeTeleport = null;
  stopTeleportLoopAudio();
  void refreshAudioSubscriptions(true);
  void audio.playSample(TELEPORT_SOUND_URL, WORLD_FOOTSTEP_GAIN);
  updateStatus(completionStatus);
}

/** Main animation/update loop for movement, spatial audio, and rendering. */
function gameLoop(): void {
  mobileControls?.sync();
  if (!state.running) return;
  updateTeleport();
  handleMovement();
  if (!activeTeleport) {
    void refreshAudioSubscriptions();
  }
  const listenerPosition = {
    x: state.player.x,
    y: state.player.y,
    z: state.player.z,
    acousticZoneId: state.player.acousticZoneId,
  };
  peerManager.setListenerPosition(listenerPosition.x, listenerPosition.y, listenerPosition.z);
  acousticZoneRuntime.sync(state.items.values());
  for (const peer of peerManager.getPeers()) {
    const acoustic = resolveWorldAcousticMix(peer, listenerPosition);
    peerManager.setPeerAcousticMix(peer.id, acoustic.gain, acoustic.lowpassHz);
  }
  audio.setListenerFacing(state.player.facingDeg);
  ambianceRuntime.update(state.ambiances.values(), listenerPosition, audioLayers.world);
  audio.updateSpatialAudio(peerManager.getPeers(), listenerPosition);
  audio.updateSpatialSamples(listenerPosition);
  radioRuntime.updateSpatialAudio(state.items, listenerPosition);
  itemEmitRuntime.updateSpatialAudio(state.items, listenerPosition);
  elevatorAudioRuntime.updateSpatialAudio(state.items, listenerPosition);
  state.cursorVisible = Math.floor(Date.now() / 500) % 2 === 0;
  renderer.draw(state);
  requestAnimationFrame(gameLoop);
}

/** Applies held-arrow movement with bounds checks, tile cues, and server position sync. */
function handleMovement(): void {
  if (state.mode !== 'normal') return;
  if (activeTeleport || teleportTransition.isActive()) return;
  if (state.elevatorItemId) return;
  const now = Date.now();
  if (now - state.player.lastMoveTime < movementTickMs) return;

  const { dx, dy } = resolveArrowMovement(
    state.keysPressed,
    state.player.facingDeg,
    audio.getSpatialMode() === 'hrtf',
  );

  if (dx === 0 && dy === 0) {
    lastWallCollisionDirection = null;
    return;
  }

  const nextX = state.player.x + dx;
  const nextY = state.player.y + dy;
  const attemptedDirection = `${dx},${dy}`;
  if (!canWalkTo(state.platforms, state.player.x, state.player.y, state.player.z, nextX, nextY)) {
    state.player.lastMoveTime = now;
    if (lastWallCollisionDirection !== attemptedDirection) {
      void audio.playSample(WALL_SOUND_URL, 1);
      lastWallCollisionDirection = attemptedDirection;
    }
    return;
  }
  const blockingWall = blockingWallForMove(
    state.structures.values(),
    state.player.x,
    state.player.y,
    state.player.z,
    nextX,
    nextY,
    wallEdgeIndex,
  );
  if (blockingWall) {
    state.player.lastMoveTime = now;
    if (lastWallCollisionDirection !== attemptedDirection) {
      const contactSound = blockingWall.contactSound.trim();
      if (contactSound) {
        void audio.playSample(resolveIncomingSoundUrl(contactSound), 1);
      }
      signaling.send({ type: 'update_position', x: nextX, y: nextY, z: state.player.z });
      lastWallCollisionDirection = attemptedDirection;
    }
    return;
  }

  const crossedWalls = wallsCrossedForMove(
    state.structures.values(),
    state.player.x,
    state.player.y,
    state.player.z,
    nextX,
    nextY,
    wallEdgeIndex,
  );
  for (const crossedWall of crossedWalls) {
    const contactSound = crossedWall.contactSound.trim();
    if (contactSound) {
      void audio.playSample(resolveIncomingSoundUrl(contactSound), 1);
    }
  }

  const itemsToAnnounce = getItemsAtPosition(nextX, nextY).filter(
    (item) => item.type !== 'widget' || !itemOccupiesPosition(item, state.player.x, state.player.y, state.player.z),
  );
  state.player.x = nextX;
  state.player.y = nextY;
  lastWallCollisionDirection = null;
  state.player.lastMoveTime = now;
  void refreshAudioSubscriptions(true);
  void audio.playSample(randomFootstepUrl(nextX, nextY, state.player.z), WORLD_FOOTSTEP_GAIN, movementTickMs);
  signaling.send({ type: 'update_position', x: nextX, y: nextY, z: state.player.z });

  const namesOnTile = getPeerNamesAtPosition(nextX, nextY);
  const tileAnnouncements: string[] = [];
  if (namesOnTile.length > 0) {
    tileAnnouncements.push(namesOnTile.join(', '));
    audio.sfxTileUserPing();
  }
  if (itemsToAnnounce.length > 0) {
    tileAnnouncements.push(itemsToAnnounce.map((item) => itemLabel(item)).join(', '));
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
  authController.applyVoiceSendPermission();
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
  heartbeatMissedPongs = 0;
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
    const heartbeat = nextHeartbeatState(heartbeatMissedPongs, !heartbeatAwaitingPong);
    heartbeatMissedPongs = heartbeat.missedPongs;
    if (heartbeat.stale) {
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
  doorControls.close();
  // Tear down the interrupted session before starting a cancellable retry sequence.
  disconnect();
  const controller = new AbortController();
  reconnectAbort = controller;
  reconnectInFlight = true;
  dom.disconnectButton.classList.remove('hidden');
  if (reason === 'heartbeat') {
    pushChatMessage('Connection stale. Reconnecting...');
  }
  try {
    const connected = await runReconnectAttempts({
      signal: controller.signal,
      connect: () => connectAttempt(controller),
      onRetry: (attempt, delayMs) => {
        const seconds = Math.round(delayMs / 1000);
        pushChatMessage(`Reconnect attempt ${attempt} failed. Retrying in ${seconds} seconds...`);
      },
    });
    if (!connected && !controller.signal.aborted) {
      pushChatMessage(`Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Press Connect to retry.`);
      audio.sfxUiCancel();
    }
  } finally {
    if (reconnectAbort === controller) {
      reconnectAbort = null;
      reconnectInFlight = false;
      if (!state.running) dom.disconnectButton.classList.add('hidden');
    }
  }
}

/** Sends current auth request over signaling websocket after socket open. */
function sendAuthRequest(): void {
  authController.sendAuthRequest();
}

/** Handles server auth-required prompts prior to world welcome. */
function handleAuthRequired(message: Extract<IncomingMessage, { type: 'auth_required' }>): void {
  applyGridBranding(message.gridName, message.welcomeMessage);
  const expectedClientRevision = String(message.expectedClientRevision ?? '').trim();
  if (!reloadScheduledForVersionMismatch && expectedClientRevision && expectedClientRevision !== APP_CLIENT_REVISION) {
    reloadScheduledForVersionMismatch = true;
    const serverVersion = String(message.serverVersion ?? '').trim() || 'unknown';
    pushChatMessage(
      `Server ${serverVersion} expects client ${expectedClientRevision}. Reloading client...`,
    );
    window.setTimeout(() => {
      reloadClientForVersion(expectedClientRevision);
    }, 50);
    return;
  }
  authController.handleAuthRequired(message);
}

/** Applies auth result state and terminates failed auth attempts quickly. */
async function handleAuthResult(message: Extract<IncomingMessage, { type: 'auth_result' }>): Promise<void> {
  if (message.nickname) {
    const resolved = sanitizeName(message.nickname);
    if (resolved) {
      state.player.nickname = resolved;
    }
  }
  await authController.handleAuthResult(message);
}

/** Handles server-pushed role/permission refresh events for the current session. */
function handleAuthPermissions(message: Extract<IncomingMessage, { type: 'auth_permissions' }>): void {
  authController.handleAuthPermissions(message);
}

/** Returns available admin-menu root actions based on current permission set. */
function getAvailableAdminActions(): AdminMenuAction[] {
  return adminController.getAvailableAdminActions();
}

/** Handles server role-list response for admin menu flows. */
function handleAdminRolesList(message: Extract<IncomingMessage, { type: 'admin_roles_list' }>): void {
  adminController.handleAdminRolesList(message);
}

/** Handles server user-list response for admin menu flows. */
function handleAdminUsersList(message: Extract<IncomingMessage, { type: 'admin_users_list' }>): void {
  adminController.handleAdminUsersList(message);
}

/** Handles server transfer-target list response for item-management transfer flow. */
function handleItemTransferTargets(message: Extract<IncomingMessage, { type: 'item_transfer_targets' }>): void {
  itemInteractionController.handleItemTransferTargets(message);
}

/** Handles server hand-target list response for item-management handoff flow. */
function handleItemHandTargets(message: Extract<IncomingMessage, { type: 'item_hand_targets' }>): void {
  itemInteractionController.handleItemHandTargets(message);
}

/** Handles structured admin action result packets. */
function handleAdminActionResult(message: Extract<IncomingMessage, { type: 'admin_action_result' }>): void {
  adminController.handleAdminActionResult(message);
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
    signalingConnect: (handler, onDisconnected) => signaling.connect(handler as (message: IncomingMessage) => Promise<void>, onDisconnected),
    signalingSendAuth: () => sendAuthRequest(),
    signalingDisconnect: () => signaling.disconnect(),
    onMessage: (message, onWelcome) => onSignalingMessage(message as IncomingMessage, onWelcome),
    peerManagerCleanupAll: () => {
      peerManager.cleanupAll();
      voiceMutes.clearSession();
    },
    radioCleanupAll: () => radioRuntime.cleanupAll(),
    emitCleanupAll: () => {
      teleportTransition.reset();
      stopTeleportLoopAudio();
      activeTeleportLoopToken += 1;
      activeTeleport = null;
      ambianceRuntime.cleanup();
      state.ambiances.clear();
      itemEmitRuntime.cleanupAll();
      elevatorAudioRuntime.cleanupAll();
    },
    playLogoutSound: () => {
      void audio.playSample(SYSTEM_SOUND_URLS.logout, 1);
    },
  };
}

/** Performs end-to-end connect flow: validation, media setup, then signaling connection. */
async function connect(): Promise<void> {
  if (state.running) return;
  doorControls.close();
  cancelReconnect();
  connectionAbort?.abort();
  await connectAttempt(new AbortController());
}

/** Waits for one complete signaling/authentication attempt. */
async function connectAttempt(controller: AbortController): Promise<boolean> {
  connectionAbort = controller;
  setConnectionStatus('Connecting...');
  return runConnectFlow(getConnectionFlowDeps(), controller.signal);
}

/** Cancels automatic retries, including any pending connection attempt. */
function cancelReconnect(): void {
  reconnectAbort?.abort();
  reconnectAbort = null;
  reconnectInFlight = false;
}

/** Tears down active session state, media, peers, and UI back to pre-connect mode. */
function disconnect(): void {
  itemPropertyEditor.reset();
  elevatorControls.reset();
  worldBuilderController.resetPlatformEditor();
  cancelReconnect();
  connectionAbort?.abort();
  connectionAbort = null;
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
  itemInteractionController.reset();
  worldBuilderController.resetCheckpoints();
  itemBehaviorRegistry.cleanup();
}

/** Connects the authenticated browser to its LiveKit voice room. */
async function connectLiveKit(url: string, token: string): Promise<void> {
  try {
    if (!await peerManager.connectToRoom(url, token)) return;
    for (const peer of state.peers.values()) peerManager.ensurePeer(peer.id, peer);
  } catch (error) {
    console.error('LiveKit connection failed:', error);
  }
}

const onAppMessage = createOnMessageHandler({
  getWorldGridSize: () => worldGridSize,
  setWorldGridSize: (size) => {
    worldGridSize = size;
  },
  setStructurePresets: (presets: StructurePreset[]) => worldBuilderController.setPresets(presets),
  setAmbianceTypes: (types) => {
    ambianceRuntime.setTypes(types.map((type) => ({ ...type, url: resolveIncomingSoundUrl(type.url) })));
    worldBuilderController.setAmbianceTypes(types);
  },
  setFootstepSets: (sets) => {
    footstepSets = sets;
    worldBuilderController.setFootstepSets(sets);
  },
  refreshStructureGeometry: () => {
    wallEdgeIndex = buildWallEdgeIndex(state.structures.values());
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
  peerManager,
  refreshAudioSubscriptions,
  refreshAcousticModel,
  cleanupItemAudio: (itemId) => {
    radioRuntime.cleanup(itemId);
    itemEmitRuntime.cleanup(itemId);
    elevatorAudioRuntime.cleanup(itemId);
  },
  applyAudioLayerState,
  gameLoop,
  sanitizeName,
  randomFootstepUrl,
  playWorldSound: (url, source) => worldAudio.playSample(url, source),
  playWorldSoundSequence: (urls, source) => {
    void worldAudio.playSequence(urls, source);
  },
  handleItemActionResultStatus: (message) => itemPropertyEditor.handleActionResult(message) || itemBehaviorRegistry.onActionResultStatus(message),
  handleItemBehaviorIncomingMessage: (message) => itemBehaviorRegistry.onIncomingMessage(message),
  handleItemBehaviorPeerLeft: (senderId) => itemBehaviorRegistry.onPeerLeft(senderId),
  TELEPORT_SOUND_URL,
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
  recomputeActiveItemPropertyKeys,
  getItemPropertyValue,
  getItemById: (itemId) => state.items.get(itemId),
  shouldAnnounceItemPropertyEcho: (itemId) => itemPropertyEditor.shouldAnnounceEcho(itemId),
  playLocateToneAt: (x, y) => audio.sfxLocate({ x: x - state.player.x, y: y - state.player.y }),
  resolveIncomingSoundUrl,
  handleAuthRequired,
  handleAuthResult,
  handleAuthPermissions,
  handleAdminRolesList,
  handleAdminUsersList,
  handleAdminActionResult,
  handleItemTransferTargets,
  handleItemHandTargets,
  handleDoorResult: doorControls.result,
  handleCheckpointResult: (message) => worldBuilderController.handleCheckpointResult(message),
  handleElevatorStatus: (message) => elevatorControls.handleStatus(message),
  handleWorldRestored: () => {
    itemPropertyEditor.reset();
    elevatorControls.reset();
    worldBuilderController.resetPlatformEditor();
    worldBuilderController.resetCheckpoints(true);
    doorControls.close();
    teleportTransition.reset();
    stopTeleportLoopAudio();
    activeTeleportLoopToken += 1;
    activeTeleport = null;
    radioRuntime.cleanupAll();
    ambianceRuntime.cleanup();
    itemEmitRuntime.cleanupAll();
    elevatorAudioRuntime.cleanupAll();
    itemInteractionController.reset();
    itemBehaviorRegistry.cleanup();
    state.mode = 'normal';
    state.editingPropertyKey = null;
    state.keysPressed = {};
    state.elevatorItemId = null;
  },
  handleStructureActionResult: (message) => worldBuilderController.handleActionResult(message),
  handleRegionActionResult: (message) => worldBuilderController.handleRegionActionResult(message),
  handlePlatformActionResult: (message) => worldBuilderController.handlePlatformActionResult(message),
  handlePlatformGeometryChanged: () => {
    if (!activeTeleport) return;
    const originSupported = platformAt(state.platforms, activeTeleport.startX, activeTeleport.startY, state.player.z);
    const targetSupported = platformAt(state.platforms, activeTeleport.targetX, activeTeleport.targetY, state.player.z);
    if (originSupported && targetSupported) return;
    state.player.x = activeTeleport.lastSentX;
    state.player.y = activeTeleport.lastSentY;
    activeTeleport = null;
    activeTeleportLoopToken += 1;
    stopTeleportLoopAudio();
    state.keysPressed = {};
    void refreshAudioSubscriptions(true);
  },
  handleAmbianceActionResult: (message) => worldBuilderController.handleAmbianceActionResult(message),
  handleTeleportTransition: (message) => teleportTransition.handle(message),
  connectToLiveKit: (url, token) => {
    void connectLiveKit(url, token);
  },
});

/** Handles signaling packets with heartbeat/restart metadata before app-level dispatch. */
async function onSignalingMessage(message: IncomingMessage, onWelcome?: () => void): Promise<void> {
  if (message.type === 'pong') {
    heartbeatMissedPongs = 0;
    heartbeatAwaitingPong = false;
    if (message.clientSentAt < 0) return;
  }
  let restartAnnouncement: string | null = null;
  let connectedAnnouncement: string | null = null;
  let playSelfLoginSound = false;
  if (message.type === 'welcome') {
    itemPropertyEditor.reset();
    applyGridBranding(message.serverInfo?.gridName, message.serverInfo?.welcomeMessage);
    const uiAdminActions =
      (message.uiDefinitions as { adminMenu?: { actions?: Array<{ id: string; label: string }> } } | undefined)?.adminMenu?.actions ??
      message.auth?.adminMenuActions;
    authController.applyWelcomeAuth(message.auth, uiAdminActions);
    voiceMutes.setScope(signalingUrl, authController.getAuthUserId());
    const incomingInstanceId = String(message.serverInfo?.instanceId ?? '').trim() || null;
    const incomingServerVersion = String(message.serverInfo?.serverVersion ?? '').trim() || 'unknown';
    const expectedClientRevision = String(message.serverInfo?.expectedClientRevision ?? '').trim();
    connectedAnnouncement = reconnectInFlight
      ? `Reconnected to server. Version ${incomingServerVersion}.`
      : `Connected to server. Version ${incomingServerVersion}.`;
    playSelfLoginSound = !reconnectInFlight;
    if (
      !reloadScheduledForVersionMismatch &&
      expectedClientRevision &&
      expectedClientRevision !== APP_CLIENT_REVISION
    ) {
      reloadScheduledForVersionMismatch = true;
      pushChatMessage(`Server expects client ${expectedClientRevision}. Reloading client...`);
      window.setTimeout(() => {
        reloadClientForVersion(expectedClientRevision);
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
    onWelcome?.();
    signaling.send({ type: 'welcome_ready' });
    await setupMediaAfterAuth();
    if (playSelfLoginSound) {
      void audio.playSample(SYSTEM_SOUND_URLS.logon, 1);
    }
  }
  itemBehaviorRegistry.onUseResultMessage(message);
  itemBehaviorRegistry.onWorldUpdate();
  elevatorControls.reconcile();
  worldBuilderController.reconcilePlatforms();
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
    return;
  }
  try {
    await populateAudioDevices();
    if (dom.audioInputSelect.options.length === 0) {
      setConnectionStatus('No audio input device found. Open Audio setup or connect a microphone.');
      return;
    }
    const inputDeviceId = dom.audioInputSelect.value || mediaSession.getPreferredInputDeviceId();
    await setupLocalMedia(inputDeviceId);
  } catch (error) {
    console.error(error);
    setConnectionStatus(describeMediaError(error));
  }
}

/** Toggles local microphone track mute state. */
function toggleMute(): void {
  if (!authController.getVoiceSendAllowed()) {
    updateStatus('Voice send is disabled for this account.');
    audio.sfxUiCancel();
    return;
  }
  state.isMuted = !state.isMuted;
  mediaSession.applyMuteToTrack(state.isMuted);
  updateStatus(state.isMuted ? 'Muted.' : 'Unmuted.');
}

function getCurrentSquareItems(): WorldItem[] {
  return getItemsAtPosition(state.player.x, state.player.y);
}

function getUsableInteractionItems(): WorldItem[] {
  if (state.elevatorItemId) {
    const elevator = state.items.get(state.elevatorItemId);
    return elevator ? [elevator] : [];
  }
  return getCurrentInteractionItems().filter((item) => item.capabilities.includes('usable'));
}

function getManageableInteractionItems(): WorldItem[] {
  return getCurrentInteractionItems().filter((item) => itemManagementOptionsFor(item).length > 0);
}

function canEditCurrentItem(): boolean {
  return getCurrentInteractionItems().length > 0;
}

function canInspectCurrentItem(): boolean {
  return canEditCurrentItem();
}

function openNicknameEditor(): void {
  state.mode = 'nickname';
  state.nicknameInput = state.player.nickname;
  state.cursorPos = state.player.nickname.length;
  replaceTextOnNextType = true;
  updateStatus(`Nickname edit: ${state.nicknameInput}`);
  audio.sfxUiBlip();
}

function toggleOutputModeCommand(): void {
  outputMode = audio.toggleOutputMode();
  mediaSession.saveOutputMode(outputMode);
  updateStatus(outputMode === 'mono' ? 'Mono output.' : 'Stereo output.');
  audio.sfxUiBlip();
}

function turnCommand(direction: 'left' | 'right'): void {
  signaling.send({ type: 'turn', direction });
}

function toggleHrtfCommand(): void {
  const mode = audio.getSpatialMode() === 'hrtf' ? 'standard' : 'hrtf';
  audio.setSpatialMode(mode);
  settings.saveSpatialMode(mode);
  updateStatus(mode === 'hrtf' ? (outputMode === 'mono' ? 'HRTF on. Mono output is active.' : 'HRTF on.') : 'HRTF off.');
  audio.sfxUiBlip();
}

function toggleLoopbackCommand(): void {
  const enabled = audio.toggleLoopback();
  updateStatus(enabled ? 'Loopback on.' : 'Loopback off.');
  audio.sfxUiBlip();
}

function adjustMasterVolumeCommand(step: number): void {
  const next = audio.adjustMasterVolume(step);
  persistMasterVolume(next);
  updateStatus(`Master volume ${next}`);
  audio.sfxEffectLevel(next === 50);
}

function openEffectSelectCommand(): void {
  const currentEffect = audio.getCurrentEffect();
  const currentIndex = EFFECT_SEQUENCE.findIndex((effect) => effect.id === currentEffect.id);
  state.effectSelectIndex = currentIndex >= 0 ? currentIndex : 0;
  state.mode = 'effectSelect';
  announceMenuEntry('Effects', EFFECT_SEQUENCE[state.effectSelectIndex].label);
}

function adjustEffectValueCommand(step: number): void {
  const adjusted = audio.adjustCurrentEffectLevel(step);
  if (!adjusted) return;
  persistEffectLevels();
  audio.sfxEffectLevel(adjusted.value === adjusted.defaultValue);
  updateStatus(`${adjusted.label} ${adjusted.value}`);
}

function speakFacingCommand(): void {
  updateStatus(`Facing ${getFacingDirection(state.player.facingDeg)}.`);
  audio.sfxUiBlip();
}

function speakCoordinatesCommand(): void {
  const adjacentWalls = adjacentWallDescriptions(
    state.structures.values(),
    state.player.x,
    state.player.y,
    state.player.z,
  );
  const structurePhrase = adjacentWalls.length > 0 ? ` Structures: ${adjacentWalls.join(', ')}.` : '';
  updateStatus(`${locationPhrase(state.player.x, state.player.y, state.player.z)}.${structurePhrase}`);
  audio.sfxUiBlip();
}

function openMicGainEditCommand(): void {
  if (!authController.getVoiceSendAllowed()) {
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
  announceMenuEntry('Microphone gain', state.nicknameInput);
}

function calibrateMicrophoneCommand(): void {
  if (!authController.getVoiceSendAllowed()) {
    updateStatus('Voice send is disabled for this account.');
    audio.sfxUiCancel();
    return;
  }
  void calibrateMicInputGain();
}

function openAdminMenuCommand(): void {
  adminController.openAdminMenu();
}

function openWorldBuilderCommand(): void {
  worldBuilderController.open();
}

function localDoors() {
  if (state.elevatorItemId) return [];
  return adjacentDoors(state.structures.values(), state.player.x, state.player.y, state.player.z);
}

function chooseDoorOrItem(secondary: boolean): boolean {
  const doors = localDoors().filter(({door}) => !secondary || door.unlockMode === 'keypad');
  if (!doors.length) return false;
  const items = getUsableInteractionItems();
  if (doors.length === 1 && items.length === 0) {
    doorControls.use(doors[0], secondary);
    return true;
  }
  const options = [
    ...doors.map(({door, direction}) => ({id:'door/' + door.id, label:
      (secondary ? (door.isLocked ? 'Unlock ' : 'Lock ') : '') + door.title + ', ' + direction})),
    ...items.map(item => ({id:'item/' + item.id, label:itemLabel(item)})),
  ];
  optionSelector.open({title:secondary ? 'Secondary action' : 'Use', options,
    onCancel:() => { state.mode = 'normal'; },
    onSelect(id) {
      state.mode = 'normal';
      const target = doors.find(d => 'door/' + d.door.id === id);
      if (target) { doorControls.use(target, secondary); return; }
      const item = items.find(candidate => 'item/' + candidate.id === id);
      if (item) {
        if (secondary) secondaryUseItem(item);
        else useItem(item);
      }
    }});
  return true;
}

function useItemCommand(): void {
  if (chooseDoorOrItem(false)) return;
  const usable = getUsableInteractionItems();
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
}

function secondaryUseItemCommand(): void {
  if (chooseDoorOrItem(true)) return;
  const usable = getUsableInteractionItems();
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
}

function speakUsersCommand(): void {
  const allUsers = [state.player.nickname, ...Array.from(state.peers.values()).map((peer) => peer.nickname)];
  const label = allUsers.length === 1 ? 'user' : 'users';
  updateStatus(`${allUsers.length} ${label}: ${allUsers.join(', ')}`);
  audio.sfxUiBlip();
}

function addItemCommand(): void {
  const itemTypeSequence = getItemTypeSequence();
  if (itemTypeSequence.length === 0) {
    updateStatus('No item types available.');
    audio.sfxUiCancel();
    return;
  }
  state.addItemTypeIndex = Math.max(0, Math.min(state.addItemTypeIndex, itemTypeSequence.length - 1));
  state.mode = 'addItem';
  announceMenuEntry('Add item', itemTypeLabel(itemTypeSequence[state.addItemTypeIndex]));
}

function listItemsCommand(): void {
  state.sortedItemIds = Array.from(state.items.entries())
    .filter(([, item]) => !item.carrierId && isItemOnFloor(item, state.player.z))
    .sort((a, b) => {
      const positionA = getNearestItemPosition(a[1], state.player.x, state.player.y);
      const positionB = getNearestItemPosition(b[1], state.player.x, state.player.y);
      return Math.hypot(positionA.x - state.player.x, positionA.y - state.player.y)
        - Math.hypot(positionB.x - state.player.x, positionB.y - state.player.y);
    })
    .map(([id]) => id);
  if (state.sortedItemIds.length === 0) {
    updateStatus('No items to list.');
    audio.sfxUiCancel();
    return;
  }
  state.itemListIndex = 0;
  state.mode = 'listItems';
  const first = state.items.get(state.sortedItemIds[0]);
  if (!first) {
    audio.sfxUiCancel();
    return;
  }
  const firstPosition = getNearestItemPosition(first, state.player.x, state.player.y);
  const itemCount = state.sortedItemIds.length;
  const itemLabelText = itemCount === 1 ? 'item' : 'items';
  announceMenuEntry(
    `${itemCount} ${itemLabelText}`,
    `${itemLabel(first)}, ${distanceDirectionPhrase(state.player.x, state.player.y, firstPosition.x, firstPosition.y)}, ${locationPhrase(firstPosition.x, firstPosition.y, state.player.z)}`,
  );
}

function locateNearestItemCommand(): void {
  const nearest = getNearestItem(state);
  if (!nearest.itemId) {
    updateStatus('No items to locate.');
    audio.sfxUiCancel();
    return;
  }
  const item = state.items.get(nearest.itemId);
  if (!item) return;
  const position = getNearestItemPosition(item, state.player.x, state.player.y);
  audio.sfxLocate({ x: position.x - state.player.x, y: position.y - state.player.y });
  updateStatus(`${itemLabel(item)}, ${distanceDirectionPhrase(state.player.x, state.player.y, position.x, position.y)}, ${locationPhrase(position.x, position.y, state.player.z)}`);
}

/** Sends pickup or drop intent for the selected item using its current server state. */
function pickupDropItem(item: WorldItem): void {
  if (state.player.id && item.carrierId === state.player.id) {
    signaling.send({ type: 'item_drop', itemId: item.id, x: state.player.x, y: state.player.y, z: state.player.z });
  } else {
    signaling.send({ type: 'item_pickup', itemId: item.id });
  }
}

function pickupDropItemCommand(): void {
  const items = getCurrentInteractionItems().filter(
    (item) => item.carrierId === state.player.id || item.capabilities.includes('carryable'),
  );
  if (items.length === 0) {
    updateStatus('No items to pick up or drop.');
    audio.sfxUiCancel();
    return;
  }
  if (items.length === 1) {
    pickupDropItem(items[0]);
    return;
  }
  beginItemSelection('pickupDrop', items);
}

function openItemManagementCommand(): void {
  const manageable = getManageableInteractionItems();
  if (manageable.length === 0) {
    updateStatus('No items.');
    audio.sfxUiCancel();
    return;
  }
  if (manageable.length === 1) {
    beginItemManagement(manageable[0]);
    return;
  }
  beginItemSelection('manage', manageable);
}

function editItemCommand(): void {
  const items = getCurrentInteractionItems();
  if (items.length === 0) {
    updateStatus('No editable item here.');
    audio.sfxUiCancel();
    return;
  }
  if (items.length === 1) {
    beginItemProperties(items[0]);
    return;
  }
  beginItemSelection('edit', items);
}

function inspectItemCommand(): void {
  const items = getCurrentInteractionItems();
  if (items.length === 0) {
    updateStatus('No item to inspect.');
    audio.sfxUiCancel();
    return;
  }
  if (items.length === 1) {
    beginItemProperties(items[0], true);
    return;
  }
  beginItemSelection('inspect', items);
}

function pingServerCommand(): void {
  signaling.send({ type: 'ping', clientSentAt: Date.now() });
}

function selectedUser(): PeerState | undefined {
  return state.peers.get(state.sortedPeerIds[state.listIndex]);
}

function userListLabel(peer: PeerState): string {
  return voiceMutes.isMuted(peer) ? `${peer.nickname}, voice muted for you` : peer.nickname;
}

function describeUserListRow(peer: PeerState): string {
  const volume = formatSteppedNumber(getPeerListenGainForNickname(peer.nickname), MIC_INPUT_GAIN_STEP);
  const direction = peer.z === state.player.z
    ? distanceDirectionPhrase(state.player.x, state.player.y, peer.x, peer.y)
    : 'different floor';
  return `${userListLabel(peer)}, ${formatLastSeen(null, true)}, volume ${volume}, ${direction}, ${locationPhrase(peer.x, peer.y, peer.z)}${formatCarryingSuffix(state.items.values(), peer.id)}`;
}

function listUsersCommand(): void {
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
  if (!first) {
    audio.sfxUiCancel();
    return;
  }
  const userCount = state.sortedPeerIds.length;
  const userLabelText = userCount === 1 ? 'user' : 'users';
  announceMenuEntry(`${userCount} ${userLabelText}`, describeUserListRow(first));
}

function locateNearestUserCommand(): void {
  const nearest = getNearestPeer(state);
  if (!nearest.peerId) {
    updateStatus('No users to locate.');
    audio.sfxUiCancel();
    return;
  }
  const peer = state.peers.get(nearest.peerId);
  if (!peer) return;
  audio.sfxLocate({ x: peer.x - state.player.x, y: peer.y - state.player.y });
  updateStatus(`${peer.nickname}, ${distanceDirectionPhrase(state.player.x, state.player.y, peer.x, peer.y)}, ${locationPhrase(peer.x, peer.y, peer.z)}${formatCarryingSuffix(state.items.values(), peer.id)}`);
}

function openHelpCommand(): void {
  openHelpViewer(mainHelpViewerLines);
}

function openChatCommand(): void {
  state.mode = 'chat';
  state.nicknameInput = '';
  state.cursorPos = 0;
  replaceTextOnNextType = false;
  updateStatus('Chat.');
  audio.sfxUiBlip();
}

function escapeCommand(): void {
  if (pendingEscapeDisconnect) {
    pendingEscapeDisconnect = false;
    disconnect();
    return;
  }
  pendingEscapeDisconnect = true;
  updateStatus('Press Escape again to disconnect.');
  audio.sfxUiCancel();
}

const mainModeCommandHandlers: Record<MainModeCommand, () => void> = {
  editNickname: openNicknameEditor,
  toggleMute,
  toggleOutputMode: toggleOutputModeCommand,
  toggleHrtf: toggleHrtfCommand,
  turnLeft: () => turnCommand('left'),
  turnRight: () => turnCommand('right'),
  toggleLoopback: toggleLoopbackCommand,
  toggleVoiceLayer: () => toggleAudioLayer('voice'),
  toggleItemLayer: () => toggleAudioLayer('item'),
  toggleMediaLayer: () => toggleAudioLayer('media'),
  toggleWorldLayer: () => toggleAudioLayer('world'),
  masterVolumeUp: () => adjustMasterVolumeCommand(5),
  masterVolumeDown: () => adjustMasterVolumeCommand(-5),
  openEffectSelect: openEffectSelectCommand,
  effectValueUp: () => adjustEffectValueCommand(5),
  effectValueDown: () => adjustEffectValueCommand(-5),
  speakCoordinates: speakCoordinatesCommand,
  speakFacing: speakFacingCommand,
  openMicGainEdit: openMicGainEditCommand,
  calibrateMicrophone: calibrateMicrophoneCommand,
  useItem: useItemCommand,
  secondaryUseItem: secondaryUseItemCommand,
  speakUsers: speakUsersCommand,
  addItem: addItemCommand,
  locateNearestItem: locateNearestItemCommand,
  listItems: listItemsCommand,
  pickupDropItem: pickupDropItemCommand,
  speakHeldItems: () => updateStatus(describeHeldItems(state.items.values(), state.player.id)),
  openItemManagement: openItemManagementCommand,
  editItem: editItemCommand,
  inspectItem: inspectItemCommand,
  pingServer: pingServerCommand,
  locateNearestUser: locateNearestUserCommand,
  listUsers: listUsersCommand,
  openHelp: openHelpCommand,
  openChat: openChatCommand,
  openAdminMenu: openAdminMenuCommand,
  openWorldBuilder: openWorldBuilderCommand,
  chatPrev: () => navigateChatBuffer('prev'),
  chatNext: () => navigateChatBuffer('next'),
  chatFirst: () => navigateChatBuffer('first'),
  chatLast: () => navigateChatBuffer('last'),
  escape: escapeCommand,
};

function getAvailableCommandPaletteEntriesForMode(mode: GameMode): Array<CommandDescriptor & { run: () => void | Promise<void> }> {
  if (mode === 'listUsers') {
    return getUserActions(state.sortedPeerIds[state.listIndex], {
      getPeer: (id) => state.peers.get(id),
      isMuted: (peer) => voiceMutes.isMuted(peer),
      toggleMute: (peer) => {
        voiceMutes.toggleMute(peer);
        peerManager.refreshVoiceMutes();
      },
      announce: updateStatus,
    });
  }
  if (mode === 'normal') {
    const descriptors = getAvailableMainModeCommands({
      voiceSendAllowed: authController.getVoiceSendAllowed(),
      mainHelpAvailable: mainHelpViewerLines.length > 0,
      hasAdminActions: getAvailableAdminActions().length > 0,
      hasWorldBuilder: ['world.structure.edit', 'world.platform.edit', 'world.checkpoint.capture', 'world.checkpoint.view'].some((permission) => authController.hasPermission(permission)),
      itemTypeCount: getItemTypeSequence().length,
      visibleItemCount: Array.from(state.items.values()).filter((item) => !item.carrierId).length,
      userCount: state.peers.size,
      chatMessageCount: messageBuffer.length,
      hasCarriedItem: getCarriedItems(state.items.values(), state.player.id).length > 0,
      squareItemCount: getCurrentSquareItems().length,
      usableItemCount: getUsableInteractionItems().length,
      nearbyDoorCount: localDoors().length,
      nearbyKeypad: localDoors().some(({door}) => door.unlockMode === 'keypad'),
      manageableItemCount: getManageableInteractionItems().length,
      hasEditableItemTarget: canEditCurrentItem(),
      hasInspectableItemTarget: canInspectCurrentItem(),
    });
    return [...elevatorControls.commands(), ...descriptors.map((descriptor) => ({
      ...descriptor,
      label: getServerMainModeCommandMetadata(descriptor.id)?.label ?? descriptor.label,
      tooltip: getServerMainModeCommandMetadata(descriptor.id)?.tooltip ?? descriptor.tooltip,
      run: mainModeCommandHandlers[descriptor.id],
    }))];
  }
  if (itemBehaviorRegistry.canOpenModeCommandPalette(mode)) {
    return itemBehaviorRegistry.getModeCommands(mode).map((descriptor) => ({
      ...descriptor,
      run: () => {
        itemBehaviorRegistry.runModeCommand(mode, descriptor.id);
      },
    }));
  }
  return [];
}

function canOpenCommandPaletteInMode(mode: GameMode): boolean {
  return mode === 'normal' || mode === 'listUsers' || mode === 'commandPalette' || itemBehaviorRegistry.canOpenModeCommandPalette(mode);
}

function openCommandPalette(): void {
  const sourceMode = state.mode;
  if (sourceMode === 'commandPalette') {
    return;
  }
  const commands = getAvailableCommandPaletteEntriesForMode(sourceMode);
  if (commands.length === 0) {
    updateStatus('No commands available in this mode.');
    audio.sfxUiCancel();
    return;
  }
  commandPaletteCommands.splice(0, commandPaletteCommands.length, ...commands);
  commandPaletteIndex = 0;
  commandPaletteReturnMode = sourceMode;
  state.mode = 'commandPalette';
  announceMenuEntry(sourceMode === 'listUsers' ? 'User actions' : 'Commands', formatCommandMenuLabel(commandPaletteCommands[0]));
}

function executeCommandPaletteSelection(): void {
  const selected = commandPaletteCommands[commandPaletteIndex];
  if (!selected) return;
  state.mode = commandPaletteReturnMode;
  void selected.run();
}

/** Handles command-mode keybindings while in main gameplay mode. */
function handleNormalModeInput(code: string, shiftKey: boolean): void {
  if (code !== 'Escape' && pendingEscapeDisconnect) {
    pendingEscapeDisconnect = false;
  }
  const command = resolveMainModeCommand(code, shiftKey);
  if (!command) return;
  mainModeCommandHandlers[command]();
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

/** Handles command palette list navigation, tooltips, and execution. */
function handleCommandPaletteModeInput(code: string, key: string): void {
  if (commandPaletteCommands.length === 0) {
    state.mode = commandPaletteReturnMode;
    updateStatus('No commands available.');
    audio.sfxUiCancel();
    return;
  }
  const control = handleMenuRowKey(code, key, commandPaletteCommands, commandPaletteIndex, {
    label: formatCommandMenuLabel,
    tooltip: (entry) => entry.tooltip,
    updateStatus,
    blip: () => audio.sfxUiBlip(),
    helpBlip: () => audio.sfxUiBlip(),
  });
  if (control.type === 'move') {
    commandPaletteIndex = control.index;
    return;
  }
  if (code === 'Space') return;
  if (control.type === 'select') {
    executeCommandPaletteSelection();
    return;
  }
  if (control.type === 'cancel') {
    state.mode = commandPaletteReturnMode;
    updateStatus('Closed commands.');
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
  const adjustment = applyNumericPropertyKey(code, state, MIC_GAIN_METADATA, {
    setReplaceTextOnNextType: (replace) => { replaceTextOnNextType = replace; },
    updateStatus,
    cue: (success) => success ? audio.sfxUiBlip() : audio.sfxUiCancel(),
  }, audio.getOutboundInputGain());
  if (adjustment) {
    audio.setOutboundInputGain(Number(adjustment.value));
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
    announcePropertyValue(updateStatus, formatSteppedNumber(applied, MIC_INPUT_GAIN_STEP));
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

  if (code === 'ArrowLeft' || code === 'ArrowRight') {
    const peerId = state.sortedPeerIds[state.listIndex];
    const entry = state.peers.get(peerId);
    if (!entry) return;
    const current = getPeerListenGainForNickname(entry.nickname);
    const adjustment = adjustPropertyValue(code, current, MIC_GAIN_METADATA)!;
    const next = Number(adjustment.value);
    setPeerListenGainForNickname(entry.nickname, next);
    peerManager.setPeerListenGain(peerId, next);
    announcePropertyValue(updateStatus, adjustment.displayValue);
    if (adjustment.hitBoundary) audio.sfxUiCancel();
    else audio.sfxUiBlip();
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
    updateStatus(describeUserListRow(entry));
    if (control.reason === 'initial') {
      audio.sfxUiBlip();
    }
    return;
  }

  if (control.type === 'select') {
    const entry = state.peers.get(state.sortedPeerIds[state.listIndex]);
    if (!entry) return;
    if (entry.z !== state.player.z) {
      updateStatus(`${entry.nickname} is ${floorPositionPhrase(entry.x, entry.y, entry.z)}.`);
      audio.sfxUiCancel();
      return;
    }
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
    const position = getNearestItemPosition(item, state.player.x, state.player.y);
    updateStatus(
      `${itemLabel(item)}, ${distanceDirectionPhrase(state.player.x, state.player.y, position.x, position.y)}, ${locationPhrase(position.x, position.y, state.player.z)}`,
    );
    if (control.reason === 'initial') {
      audio.sfxUiBlip();
    }
    return;
  }
  if (control.type === 'select') {
    const item = state.items.get(state.sortedItemIds[state.itemListIndex]);
    if (!item) return;
    if (itemOccupiesPosition(item, state.player.x, state.player.y, state.player.z)) {
      updateStatus('Already here.');
      return;
    }
    const position = getNearestItemPosition(item, state.player.x, state.player.y);
    const landing = hasItemBounds(item)
      ? nearestLanding(state.platforms, itemBounds(item), state.player.z, state.player.x, state.player.y)
      : position;
    if (!landing) {
      updateStatus('No platform beside this item at your elevation.');
      audio.sfxUiCancel();
      return;
    }
    state.mode = 'normal';
    startTeleportTo(landing.x, landing.y, `Moved to ${itemLabel(item)}.`);
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
  const control = handleMenuRowKey(code, key, itemTypeSequence, state.addItemTypeIndex, {
    label: (itemType) => `${itemTypeLabel(itemType)}.`,
    searchLabel: itemTypeLabel,
    tooltip: getItemTypeTooltip,
    updateStatus,
    blip: () => audio.sfxUiBlip(),
    helpBlip: () => audio.sfxUiBlip(),
  });
  if (control.type === 'move') {
    state.addItemTypeIndex = control.index;
    return;
  }
  if (code === 'Space') return;
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
  itemInteractionController.handleSelectItemModeInput(code, key);
}

/** Handles item-management action menu (`z`) for the selected square item. */
function handleItemManageOptionsModeInput(code: string, key: string): void {
  itemInteractionController.handleItemManageOptionsModeInput(code, key);
}

/** Handles target-user selection for item transfer action. */
function handleItemManageTransferUserModeInput(code: string, key: string): void {
  itemInteractionController.handleItemManageTransferUserModeInput(code, key);
}

/** Handles top-level Shift+Z admin menu action selection. */
function handleAdminMenuModeInput(code: string, key: string): void {
  adminController.handleAdminMenuModeInput(code, key);
}

/** Handles role list selection flow, including add-role entry. */
function handleAdminRoleListModeInput(code: string, key: string): void {
  adminController.handleAdminRoleListModeInput(code, key);
}

/** Handles role permission toggle and delete flow. */
function handleAdminRolePermissionListModeInput(code: string, key: string): void {
  adminController.handleAdminRolePermissionListModeInput(code, key);
}

/** Handles replacement-role selection while deleting a role. */
function handleAdminRoleDeleteReplacementModeInput(code: string, key: string): void {
  adminController.handleAdminRoleDeleteReplacementModeInput(code, key);
}

/** Handles user list selection for change-role/ban/unban flows. */
function handleAdminUserListModeInput(code: string, key: string): void {
  adminController.handleAdminUserListModeInput(code, key);
}

/** Handles role selection for a previously selected user target. */
function handleAdminUserRoleSelectModeInput(code: string, key: string): void {
  adminController.handleAdminUserRoleSelectModeInput(code, key);
}

/** Handles yes/no confirmation for delete-account admin flow. */
function handleAdminUserDeleteConfirmModeInput(code: string, key: string): void {
  adminController.handleAdminUserDeleteConfirmModeInput(code, key);
}

/** Handles text edit for new-role creation from admin role list. */
function handleAdminRoleNameEditModeInput(code: string, key: string, ctrlKey: boolean): void {
  adminController.handleAdminRoleNameEditModeInput(code, key, ctrlKey);
}

const itemPropertyEditor = createItemPropertyEditor({
  state,
  signalingSend: (message) => signaling.send(message as OutgoingMessage),
  getItemPropertyValue,
  itemPropertyLabel,
  isItemPropertyEditable,
  getItemPropertyOptionValues,
  openOptionSelector: (request) => optionSelector.open(request),
  describeItemPropertyHelp,
  getItemPropertyMetadata,
  validateNumericItemPropertyInput,
  applyTextInputEdit,
  setReplaceTextOnNextType: (value) => {
    replaceTextOnNextType = value;
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

function handleModeInput(input: ModeInput): void {
  if (state.mode === 'doorKeypad') {
    doorControls.handleKeypadInput(input.code, input.key);
    return;
  }
  if (state.mode === 'doorSettings' || state.mode === 'doorSettingsEdit') {
    doorControls.handleSettingsInput(state.mode, input.code, input.key, input.ctrlKey);
    return;
  }
  if (itemBehaviorRegistry.handleModeInput(state.mode, input)) {
    return;
  }
  dispatchModeInput({
    mode: state.mode,
    input,
    handlers: {
      nickname: ({ code: currentCode, key: currentKey, ctrlKey: currentCtrlKey }) =>
        handleNicknameModeInput(currentCode, currentKey, currentCtrlKey),
      chat: ({ code: currentCode, key: currentKey, ctrlKey: currentCtrlKey }) =>
        handleChatModeInput(currentCode, currentKey, currentCtrlKey),
      micGainEdit: ({ code: currentCode, key: currentKey, ctrlKey: currentCtrlKey }) =>
        handleMicGainEditModeInput(currentCode, currentKey, currentCtrlKey),
      commandPalette: ({ code: currentCode, key: currentKey }) => handleCommandPaletteModeInput(currentCode, currentKey),
      effectSelect: ({ code: currentCode, key: currentKey }) => handleEffectSelectModeInput(currentCode, currentKey),
      helpView: ({ code: currentCode }) => handleHelpViewModeInput(currentCode),
      listUsers: ({ code: currentCode, key: currentKey }) => handleListModeInput(currentCode, currentKey),
      listItems: ({ code: currentCode, key: currentKey }) => handleListItemsModeInput(currentCode, currentKey),
      addItem: ({ code: currentCode, key: currentKey }) => handleAddItemModeInput(currentCode, currentKey),
      selectItem: ({ code: currentCode, key: currentKey }) => handleSelectItemModeInput(currentCode, currentKey),
      itemManageOptions: ({ code: currentCode, key: currentKey }) => handleItemManageOptionsModeInput(currentCode, currentKey),
      itemManageTransferUser: ({ code: currentCode, key: currentKey }) =>
        handleItemManageTransferUserModeInput(currentCode, currentKey),
      confirmYesNo: ({ code: currentCode, key: currentKey }) => confirmationController.handleInput(currentCode, currentKey),
      optionSelect: ({ code: currentCode, key: currentKey }) => optionSelector.handleInput(currentCode, currentKey),
      adminMenu: ({ code: currentCode, key: currentKey }) => handleAdminMenuModeInput(currentCode, currentKey),
      adminRoleList: ({ code: currentCode, key: currentKey }) => handleAdminRoleListModeInput(currentCode, currentKey),
      adminRolePermissionList: ({ code: currentCode, key: currentKey }) =>
        handleAdminRolePermissionListModeInput(currentCode, currentKey),
      adminRoleDeleteReplacement: ({ code: currentCode, key: currentKey }) =>
        handleAdminRoleDeleteReplacementModeInput(currentCode, currentKey),
      adminUserList: ({ code: currentCode, key: currentKey }) => handleAdminUserListModeInput(currentCode, currentKey),
      adminUserRoleSelect: ({ code: currentCode, key: currentKey }) => handleAdminUserRoleSelectModeInput(currentCode, currentKey),
      adminUserDeleteConfirm: ({ code: currentCode, key: currentKey }) => handleAdminUserDeleteConfirmModeInput(currentCode, currentKey),
      adminRoleNameEdit: ({ code: currentCode, key: currentKey, ctrlKey: currentCtrlKey }) =>
        handleAdminRoleNameEditModeInput(currentCode, currentKey, currentCtrlKey),
      checkpointMenu: ({ code, key }) => worldBuilderController.handleCheckpointInput(code, key),
      checkpointLabel: ({ code, key, ctrlKey }) => worldBuilderController.handleCheckpointInput(code, key, ctrlKey),
      checkpointList: ({ code, key }) => worldBuilderController.handleCheckpointInput(code, key),
      checkpointPreview: ({ code, key }) => worldBuilderController.handleCheckpointInput(code, key),
      worldBuilder: ({ code: currentCode, key: currentKey }) => worldBuilderController.handleRoot(currentCode, currentKey),
      worldBuilderPreset: ({ code: currentCode, key: currentKey }) => worldBuilderController.handlePreset(currentCode, currentKey),
      worldBuilderDirection: ({ code: currentCode, key: currentKey }) => worldBuilderController.handleDirection(currentCode, currentKey),
      worldBuilderWallList: ({ code: currentCode, key: currentKey }) => worldBuilderController.handleWallList(currentCode, currentKey),
      worldBuilderWallActions: ({ code: currentCode, key: currentKey }) => worldBuilderController.handleWallActions(currentCode, currentKey),
      worldBuilderPropertyList: ({ code: currentCode, key: currentKey }) => worldBuilderController.handlePropertyList(currentCode, currentKey),
      worldBuilderRegionList: ({ code, key }) => worldBuilderController.handleRegionList(code, key),
      worldBuilderPlatformList: ({ code, key }) => worldBuilderController.handlePlatformList(code, key),
      worldBuilderPlatformActions: ({ code, key }) => worldBuilderController.handlePlatformActions(code, key),
      worldBuilderPlatformEdit: ({ code, key, ctrlKey }) => worldBuilderController.handlePlatformEdit(code, key, ctrlKey),
      worldBuilderRegionActions: ({ code, key }) => worldBuilderController.handleRegionActions(code, key),
      worldBuilderRegionEdit: ({ code, key, ctrlKey }) => worldBuilderController.handleRegionEdit(code, key, ctrlKey),
      worldBuilderAmbianceList: ({ code, key }) => worldBuilderController.handleAmbianceList(code, key),
      worldBuilderAmbianceActions: ({ code, key }) => worldBuilderController.handleAmbianceActions(code, key),
      worldBuilderAmbianceEdit: ({ code, key, ctrlKey }) => worldBuilderController.handleAmbianceEdit(code, key, ctrlKey),
      worldBuilderPropertyEdit: ({ code: currentCode, key: currentKey, ctrlKey: currentCtrlKey }) =>
        worldBuilderController.handlePropertyEdit(currentCode, currentKey, currentCtrlKey),
      itemProperties: ({ code: currentCode, key: currentKey }) =>
        itemPropertyEditor.handleItemPropertiesModeInput(currentCode, currentKey),
      itemPropertyEdit: ({ code: currentCode, key: currentKey, ctrlKey: currentCtrlKey }) =>
        itemPropertyEditor.handleItemPropertyEditModeInput(currentCode, currentKey, currentCtrlKey),
    },
    onNormalMode: handleNormalModeInput,
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

function getMobileTextEntry(): MobileTextEntry | null {
  if (state.mode === 'doorKeypad') return doorControls.getKeypadTextEntry();
  if (state.mode === 'doorSettingsEdit') return doorControls.getSettingsTextEntry();
  const maxLength = textInputMaxLengthForMode(state.mode);
  if (maxLength === null) return null;
  if (state.mode === 'chat') {
    return { label: 'Chat message', value: state.nicknameInput, maxLength, inputMode: 'text', submitLabel: 'Send' };
  }
  if (state.mode === 'nickname') {
    return { label: 'Nickname', value: state.nicknameInput, maxLength, inputMode: 'text', submitLabel: 'Save' };
  }
  if (state.mode === 'itemPropertyEdit') {
    const key = state.editingPropertyKey;
    return {
      label: key ? itemPropertyLabel(key) : 'Property value',
      value: state.nicknameInput,
      maxLength,
      inputMode: 'text',
      submitLabel: 'Save',
    };
  }
  if (state.mode === 'micGainEdit') {
    return { label: 'Microphone gain', value: state.nicknameInput, maxLength, inputMode: 'decimal', submitLabel: 'Save' };
  }
  if (state.mode === 'checkpointLabel') {
    return { label: 'Checkpoint label', value: state.nicknameInput, maxLength, inputMode: 'text', submitLabel: 'Save checkpoint' };
  }
  if (state.mode === 'worldBuilderRegionEdit') {
    return { label: 'Region name', value: state.nicknameInput, maxLength, inputMode: 'text', submitLabel: 'Save' };
  }
  if (state.mode === 'worldBuilderPlatformEdit') {
    return worldBuilderController.getPlatformTextEntry();
  }
  if (state.mode === 'worldBuilderAmbianceEdit') {
    const label = worldBuilderController.getEditingAmbiancePropertyLabel();
    return { label, value: state.nicknameInput, maxLength, inputMode: label === 'Name' ? 'text' : 'decimal', submitLabel: 'Save' };
  }
  if (state.mode === 'worldBuilderPropertyEdit') {
    const label = worldBuilderController.getEditingPropertyLabel();
    return {
      label,
      value: state.nicknameInput,
      maxLength,
      inputMode: label === 'Contact sound' ? 'text' : 'decimal',
      submitLabel: 'Save',
    };
  }
  return { label: 'Role name', value: state.nicknameInput, maxLength, inputMode: 'text', submitLabel: 'Save' };
}

function pressMobileDirection(code: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): void {
  if (!state.running || state.mode !== 'normal' || activeTeleport || teleportTransition.isActive()) return;
  state.keysPressed[code] = true;
}

function releaseMobileDirection(code: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): void {
  state.keysPressed[code] = false;
}

function getMobileCommands(): MobileCommand[] {
  return getAvailableCommandPaletteEntriesForMode(state.mode).map((command) => ({
    id: command.id,
    label: command.label,
    section: command.section,
    tooltip: command.tooltip,
    run: command.run,
  }));
}

setupKeyboardInputHandlers({
  dom: {
    settingsModal: dom.settingsModal,
    canvas: dom.canvas,
  },
  state,
  isTextEditingMode,
  closeSettings,
  hasBlockedArrowTeleport: (code) => Boolean((activeTeleport || teleportTransition.isActive()) && code.startsWith('Arrow')),
  handleModeInput,
  canOpenCommandPaletteInMode,
  openCommandPalette,
  getModeKeyUpTarget: (activeMode) => itemBehaviorRegistry.getModeKeyUpTarget(activeMode, commandPaletteReturnMode),
  onModeKeyUp: (mode, { code, shiftKey }) => {
    itemBehaviorRegistry.handleModeKeyUp(mode, {
      code,
      shiftKey,
    });
  },
  onReleaseAllKeys: () => itemBehaviorRegistry.releaseHeldKeys(),
  pasteIntoActiveTextInput,
  updateStatus,
  setReplaceTextOnNextType: (value) => {
    replaceTextOnNextType = value;
  },
});
mobileControls = setupMobileControls({
  dom: {
    container: dom.mobileControls,
    body: dom.mobileControlsBody,
    toggle: dom.mobileControlsToggle,
    enabled: dom.mobileControlsEnabled,
    up: dom.mobileUp,
    down: dom.mobileDown,
    left: dom.mobileLeft,
    right: dom.mobileRight,
    use: dom.mobileUse,
    back: dom.mobileBack,
    chat: dom.mobileChat,
    commands: dom.mobileCommands,
    mute: dom.mobileMute,
    commandDialog: dom.mobileCommandDialog,
    selectedUserRow: dom.mobileSelectedUserRow,
    commandTitle: dom.mobileCommandTitle,
    commandList: dom.mobileCommandList,
    commandClose: dom.mobileCommandClose,
    textForm: dom.mobileTextEntry,
    textLabel: dom.mobileTextEntryLabel,
    textInput: dom.mobileTextInput,
    textSubmit: dom.mobileTextSubmit,
    textCancel: dom.mobileTextCancel,
  },
  getRunning: () => state.running,
  getMode: () => state.mode,
  getMuted: () => state.isMuted,
  getCommands: getMobileCommands,
  getSelectedUserLabel: () => {
    const peer = state.mode === 'listUsers' ? selectedUser() : undefined;
    return peer ? userListLabel(peer) : null;
  },
  dispatchInput: handleModeInput,
  pressDirection: pressMobileDirection,
  releaseDirection: releaseMobileDirection,
  openChat: openChatCommand,
  toggleMute,
  getTextEntry: getMobileTextEntry,
  setTextEntry: (value, cursor) => {
    if (state.mode === 'doorKeypad') {
      doorControls.setKeypadText(value);
      return;
    }
    if (state.mode === 'doorSettingsEdit') {
      doorControls.setSettingsText(value, cursor);
      return;
    }
    state.nicknameInput = value;
    state.cursorPos = cursor;
    replaceTextOnNextType = false;
  },
  loadEnabled: () => settings.loadMobileControlsEnabled(),
  saveEnabled: (value) => settings.saveMobileControlsEnabled(value),
  loadExpanded: () => settings.loadMobileControlsExpanded(),
  saveExpanded: (value) => settings.saveMobileControlsExpanded(value),
});
setupDomUiHandlers({
  dom,
  updateConnectAvailability,
  connect,
  disconnect,
  openSettings,
  closeSettings,
  updateStatus,
  getGridName: () => activeGridName,
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
authController.setupUiHandlers({
  connect,
});
authController.initializeUi();
updateDeviceSummary();
setConnectionStatus(
  isVersionReloadedSession()
    ? 'Client updated, please reconnect.'
    : activeWelcomeMessage,
);
