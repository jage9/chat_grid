import type { GameState } from '../state/gameState';

const WELCOME_TIMEOUT_MS = 8_000;

type DomRefs = {
  preconnectNickname: HTMLInputElement;
  nicknameContainer: HTMLDivElement;
  connectButton: HTMLButtonElement;
  disconnectButton: HTMLButtonElement;
  focusGridButton: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  instructions: HTMLDivElement;
  audioInputSelect: HTMLSelectElement;
};

export type ConnectFlowDeps = {
  state: GameState;
  dom: DomRefs;
  sanitizeName: (value: string) => string;
  updateStatus: (message: string) => void;
  updateConnectAvailability: () => void;
  settingsSaveNickname: (value: string) => void;
  mediaIsConnecting: () => boolean;
  mediaSetConnecting: (value: boolean) => void;
  mediaCheckMicPermission: () => Promise<boolean>;
  mediaPopulateAudioDevices: () => Promise<void>;
  mediaGetPreferredInputDeviceId: () => string;
  mediaSetupLocalMedia: (audioDeviceId: string) => Promise<void>;
  mediaDescribeError: (error: unknown) => string;
  mediaStopLocalMedia: () => void;
  signalingConnect: (onMessage: (message: unknown) => Promise<void>) => Promise<void>;
  signalingDisconnect: () => void;
  onMessage: (message: unknown) => Promise<void>;
  worldGridSize: number;
  persistPlayerPosition: () => void;
  peerManagerCleanupAll: () => void;
  radioCleanupAll: () => void;
  emitCleanupAll: () => void;
  playLogoutSound: () => void;
};

/**
 * Runs connect flow: validate nickname, preflight mic/device setup, then signaling connect.
 */
export async function runConnectFlow(deps: ConnectFlowDeps): Promise<void> {
  if (deps.mediaIsConnecting() || deps.state.running) {
    return;
  }
  const nickname = deps.sanitizeName(deps.dom.preconnectNickname.value);
  if (!nickname) {
    deps.updateStatus('Nickname is required.');
    deps.updateConnectAvailability();
    return;
  }
  deps.state.player.nickname = nickname;
  deps.dom.preconnectNickname.value = nickname;
  deps.settingsSaveNickname(nickname);
  deps.mediaSetConnecting(true);
  deps.updateConnectAvailability();

  const canProceed = await deps.mediaCheckMicPermission();
  if (!canProceed) {
    deps.updateStatus('Microphone access is required.');
    deps.mediaSetConnecting(false);
    deps.updateConnectAvailability();
    return;
  }

  deps.state.player.x = Math.floor(Math.random() * deps.worldGridSize);
  deps.state.player.y = Math.floor(Math.random() * deps.worldGridSize);
  const storedPosition = localStorage.getItem('spatialChatPosition');
  if (storedPosition) {
    try {
      const parsed = JSON.parse(storedPosition) as { x?: number; y?: number };
      if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        const x = Math.floor(parsed.x as number);
        const y = Math.floor(parsed.y as number);
        if (x >= 0 && x < deps.worldGridSize && y >= 0 && y < deps.worldGridSize) {
          deps.state.player.x = x;
          deps.state.player.y = y;
        }
      }
    } catch {
      // Ignore malformed saved positions.
    }
  }

  try {
    await deps.mediaPopulateAudioDevices();
    if (deps.dom.audioInputSelect.options.length === 0) {
      deps.updateStatus('No audio input device found. Open Settings or connect a microphone.');
      deps.mediaSetConnecting(false);
      deps.updateConnectAvailability();
      return;
    }
    const inputDeviceId = deps.dom.audioInputSelect.value || deps.mediaGetPreferredInputDeviceId();
    await deps.mediaSetupLocalMedia(inputDeviceId);
  } catch (error) {
    console.error(error);
    deps.updateStatus(deps.mediaDescribeError(error));
    deps.mediaSetConnecting(false);
    deps.updateConnectAvailability();
    return;
  }

  try {
    await deps.signalingConnect(deps.onMessage);
    window.setTimeout(() => {
      if (deps.state.running || !deps.mediaIsConnecting()) {
        return;
      }
      deps.mediaStopLocalMedia();
      deps.signalingDisconnect();
      deps.mediaSetConnecting(false);
      deps.updateConnectAvailability();
      deps.updateStatus('Connect failed. Timed out waiting for server welcome.');
    }, WELCOME_TIMEOUT_MS);
  } catch (error) {
    console.error(error);
    deps.mediaStopLocalMedia();
    deps.updateStatus('Connect failed. Signaling server may be offline or unreachable.');
    deps.mediaSetConnecting(false);
    deps.updateConnectAvailability();
  }
}

/**
 * Runs disconnect flow and resets client runtime state back to pre-connect UI.
 */
export function runDisconnectFlow(deps: ConnectFlowDeps): void {
  const wasRunning = deps.state.running;
  if (deps.state.running) {
    deps.persistPlayerPosition();
  }

  deps.signalingDisconnect();
  deps.mediaStopLocalMedia();
  deps.peerManagerCleanupAll();
  deps.radioCleanupAll();
  deps.emitCleanupAll();

  deps.state.running = false;
  deps.state.keysPressed = {};
  deps.state.peers.clear();
  deps.state.items.clear();
  deps.state.carriedItemId = null;
  deps.state.mode = 'normal';
  deps.state.sortedItemIds = [];
  deps.state.itemListIndex = 0;
  deps.state.selectedItemIds = [];
  deps.state.selectionContext = null;
  deps.state.selectedItemIndex = 0;
  deps.state.selectedItemId = null;
  deps.state.itemPropertyKeys = [];
  deps.state.itemPropertyIndex = 0;
  deps.state.editingPropertyKey = null;
  deps.state.itemPropertyOptionValues = [];
  deps.state.itemPropertyOptionIndex = 0;
  deps.state.effectSelectIndex = 0;

  deps.mediaSetConnecting(false);
  deps.dom.nicknameContainer.classList.remove('hidden');
  deps.dom.connectButton.classList.remove('hidden');
  deps.dom.disconnectButton.classList.add('hidden');
  deps.dom.focusGridButton.classList.add('hidden');
  deps.dom.canvas.classList.add('hidden');
  deps.dom.instructions.classList.add('hidden');
  deps.updateConnectAvailability();

  deps.updateStatus('Disconnected.');
  if (wasRunning) {
    deps.playLogoutSound();
  }
}
