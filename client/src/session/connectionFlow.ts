import type { GameState } from '../state/gameState';

const WELCOME_TIMEOUT_MS = 8_000;

type DomRefs = {
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
  mediaIsConnecting: () => boolean;
  mediaSetConnecting: (value: boolean) => void;
  mediaStopLocalMedia: () => void;
  signalingConnect: (onMessage: (message: unknown) => Promise<void>) => Promise<void>;
  signalingSendAuth: () => void;
  signalingDisconnect: () => void;
  onMessage: (message: unknown) => Promise<void>;
  peerManagerCleanupAll: () => void;
  radioCleanupAll: () => void;
  emitCleanupAll: () => void;
  playLogoutSound: () => void;
};

/**
 * Runs connect flow: signaling connect/auth first, media setup after auth/welcome.
 */
export async function runConnectFlow(deps: ConnectFlowDeps): Promise<void> {
  if (deps.mediaIsConnecting() || deps.state.running) {
    return;
  }
  const nickname = deps.sanitizeName(deps.state.player.nickname);
  deps.state.player.nickname = nickname || deps.state.player.nickname;
  deps.mediaSetConnecting(true);
  deps.updateConnectAvailability();

  try {
    await deps.signalingConnect(deps.onMessage);
    deps.signalingSendAuth();
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
