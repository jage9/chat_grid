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
  signalingConnect: (onMessage: (message: unknown) => Promise<void>, onDisconnected: () => void) => Promise<void>;
  signalingSendAuth: () => void;
  signalingDisconnect: () => void;
  onMessage: (message: unknown, onWelcome: () => void) => Promise<void>;
  peerManagerCleanupAll: () => void;
  radioCleanupAll: () => void;
  emitCleanupAll: () => void;
  playLogoutSound: () => void;
};

/**
 * Runs connect flow: signaling connect/auth first, media setup after auth/welcome.
 */
export async function runConnectFlow(deps: ConnectFlowDeps, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || deps.mediaIsConnecting() || deps.state.running) {
    return false;
  }
  const nickname = deps.sanitizeName(deps.state.player.nickname);
  deps.state.player.nickname = nickname || deps.state.player.nickname;
  deps.mediaSetConnecting(true);
  deps.updateConnectAvailability();

  let timeoutId: number | undefined;
  let settled = false;
  let accepted = false;
  let finish!: (connected: boolean, message?: string) => void;
  const result = new Promise<boolean>((resolve) => {
    finish = (connected, message) => {
      if (settled) return;
      settled = true;
      accepted = connected;
      window.clearTimeout(timeoutId);
      signal.removeEventListener('abort', cancel);
      if (!connected) {
        deps.signalingDisconnect();
        deps.mediaStopLocalMedia();
        deps.mediaSetConnecting(false);
        deps.updateConnectAvailability();
        if (message) deps.updateStatus(message);
      }
      resolve(connected);
    };
  });
  const cancel = () => finish(false);
  signal.addEventListener('abort', cancel, { once: true });
  void deps.signalingConnect(
    async (message) => {
      if (signal.aborted || (settled && !accepted)) return;
      await deps.onMessage(message, () => {
        if (!signal.aborted) finish(true);
      });
    },
    () => finish(false, 'Connect failed. Disconnected before server welcome.'),
  ).then(() => {
    if (settled) return;
    timeoutId = window.setTimeout(() => {
      finish(false, 'Connect failed. Timed out waiting for server welcome.');
    }, WELCOME_TIMEOUT_MS);
    deps.signalingSendAuth();
  }).catch(() => {
    finish(false, 'Connect failed. Signaling server may be offline or unreachable.');
  });
  return result;
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
