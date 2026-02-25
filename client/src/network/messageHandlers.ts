import { type IncomingMessage } from './protocol';
import { type WorldItem } from '../state/gameState';

/**
 * Dependency contract for creating a message handler without hard-coupling to `main.ts`.
 */
type MessageHandlerDeps = {
  getWorldGridSize: () => number;
  setWorldGridSize: (size: number) => void;
  setMovementTickMs: (value: number) => void;
  setConnecting: (value: boolean) => void;
  rendererSetGridSize: (size: number) => void;
  applyServerItemUiDefinitions: (defs: unknown) => boolean;
  state: {
    addItemTypeIndex: number;
    player: { id: string | null; nickname: string; x: number; y: number };
    running: boolean;
    peers: Map<string, { id: string; nickname: string; x: number; y: number }>;
    items: Map<string, WorldItem>;
    mode: string;
    selectedItemId: string | null;
    itemPropertyKeys: string[];
    itemPropertyIndex: number;
    carriedItemId: string | null;
  };
  dom: {
    nicknameContainer: HTMLElement;
    connectButton: HTMLElement;
    disconnectButton: HTMLElement;
    focusGridButton: HTMLElement;
    canvas: HTMLCanvasElement;
    instructions: HTMLElement;
    preconnectNickname: HTMLInputElement;
  };
  signalingSend: (message: unknown) => void;
  peerManager: {
    createOrGetPeer: (id: string, initiator: boolean, user: { id: string; nickname: string; x: number; y: number }) => Promise<unknown>;
    handleSignal: (message: IncomingMessage) => Promise<{ id: string; nickname: string; x: number; y: number }>;
    setPeerPosition: (id: string, x: number, y: number) => void;
    setPeerNickname: (id: string, nickname: string) => void;
    removePeer: (id: string) => void;
  };
  refreshAudioSubscriptions: (force?: boolean) => Promise<void>;
  cleanupItemAudio: (itemId: string) => void;
  applyAudioLayerState: () => Promise<void>;
  gameLoop: () => void;
  sanitizeName: (value: string) => string;
  randomFootstepUrl: () => string;
  playRemoteSpatialStepOrTeleport: (url: string, peerX: number, peerY: number) => void;
  handleItemActionResultStatus: (message: Extract<IncomingMessage, { type: 'item_action_result' }>) => boolean;
  handleRemotePianoNote: (message: Extract<IncomingMessage, { type: 'item_piano_note' }>) => void;
  stopAllRemoteNotesForSender: (senderId: string) => void;
  TELEPORT_SOUND_URL: string;
  TELEPORT_START_SOUND_URL: string;
  getAudioLayers: () => { world: boolean; item: boolean };
  pushChatMessage: (message: string) => void;
  classifySystemMessageSound: (message: string) => 'logon' | 'logout' | 'notify' | null;
  SYSTEM_SOUND_URLS: { logon: string; logout: string; notify: string };
  playSample: (url: string, gain?: number) => void;
  updateStatus: (message: string) => void;
  audioUiBlip: () => void;
  audioUiConfirm: () => void;
  audioUiCancel: () => void;
  NICKNAME_STORAGE_KEY: string;
  getCarriedItemId: () => string | null;
  recomputeActiveItemPropertyKeys: (itemId: string) => void;
  itemPropertyLabel: (key: string) => string;
  getItemPropertyValue: (item: WorldItem, key: string) => string;
  getItemById: (itemId: string) => WorldItem | undefined;
  shouldAnnounceItemPropertyEcho: () => boolean;
  playLocateToneAt: (x: number, y: number) => void;
  resolveIncomingSoundUrl: (url: string) => string;
  playIncomingItemUseSound: (url: string, x: number, y: number) => void;
};

/**
 * Builds the websocket message dispatcher used by the signaling client.
 */
export function createOnMessageHandler(deps: MessageHandlerDeps): (message: IncomingMessage) => Promise<void> {
  return async function onMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'welcome':
        if (message.worldConfig?.gridSize && Number.isInteger(message.worldConfig.gridSize) && message.worldConfig.gridSize > 0) {
          deps.setWorldGridSize(message.worldConfig.gridSize);
        }
        if (message.worldConfig?.movementTickMs && Number.isInteger(message.worldConfig.movementTickMs) && message.worldConfig.movementTickMs > 0) {
          deps.setMovementTickMs(message.worldConfig.movementTickMs);
        }
        deps.rendererSetGridSize(deps.getWorldGridSize());
        const schemaReady = deps.applyServerItemUiDefinitions(message.uiDefinitions);
        if (!schemaReady) {
          deps.updateStatus('Item schema missing from server. Item menus unavailable.');
          deps.audioUiCancel();
        }
        deps.state.addItemTypeIndex = 0;
        deps.state.player.id = message.id;
        deps.state.running = true;
        deps.setConnecting(false);
        deps.state.player.x = Math.max(0, Math.min(deps.getWorldGridSize() - 1, message.player.x));
        deps.state.player.y = Math.max(0, Math.min(deps.getWorldGridSize() - 1, message.player.y));
        deps.dom.nicknameContainer.classList.add('hidden');
        deps.dom.connectButton.classList.add('hidden');
        deps.dom.disconnectButton.classList.remove('hidden');
        deps.dom.focusGridButton.classList.remove('hidden');
        deps.dom.canvas.classList.remove('hidden');
        deps.dom.instructions.classList.remove('hidden');
        deps.dom.canvas.focus();

        deps.signalingSend({ type: 'update_position', x: deps.state.player.x, y: deps.state.player.y });
        deps.signalingSend({ type: 'update_nickname', nickname: deps.state.player.nickname });

        for (const user of message.users) {
          deps.state.peers.set(user.id, { ...user });
          await deps.peerManager.createOrGetPeer(user.id, true, user);
        }
        deps.state.items.clear();
        for (const item of message.items || []) {
          deps.state.items.set(item.id, {
            ...item,
            carrierId: item.carrierId ?? null,
          });
        }
        await deps.refreshAudioSubscriptions(true);
        await deps.applyAudioLayerState();
        deps.gameLoop();
        break;

      case 'signal': {
        const peer = await deps.peerManager.handleSignal(message);
        if (!deps.state.peers.has(peer.id)) {
          deps.state.peers.set(peer.id, {
            id: peer.id,
            nickname: deps.sanitizeName(peer.nickname) || 'user...',
            x: peer.x,
            y: peer.y,
          });
        }
        break;
      }

      case 'update_position': {
        const peer = deps.state.peers.get(message.id);
        const prevX = peer?.x ?? message.x;
        const prevY = peer?.y ?? message.y;
        if (peer) {
          peer.x = message.x;
          peer.y = message.y;
        }
        deps.peerManager.setPeerPosition(message.id, message.x, message.y);
        if (peer) {
          const movementDelta = Math.hypot(message.x - prevX, message.y - prevY);
          const soundUrl = movementDelta > 1.5 ? deps.TELEPORT_START_SOUND_URL : deps.randomFootstepUrl();
          if (deps.getAudioLayers().world) {
            deps.playRemoteSpatialStepOrTeleport(soundUrl, peer.x, peer.y);
          }
        }
        break;
      }

      case 'update_nickname': {
        const peer = deps.state.peers.get(message.id);
        if (peer) {
          peer.nickname = deps.sanitizeName(message.nickname) || 'user...';
        }
        deps.peerManager.setPeerNickname(message.id, deps.sanitizeName(message.nickname) || 'user...');
        break;
      }

      case 'user_left': {
        const peer = deps.state.peers.get(message.id);
        if (peer) {
          deps.updateStatus(`${peer.nickname} has left.`);
        }
        deps.stopAllRemoteNotesForSender(message.id);
        deps.state.peers.delete(message.id);
        deps.peerManager.removePeer(message.id);
        break;
      }

      case 'chat_message': {
        if (message.system) {
          deps.pushChatMessage(message.message);
          const sound = deps.classifySystemMessageSound(message.message);
          if (sound) {
            deps.playSample(deps.SYSTEM_SOUND_URLS[sound], 1);
          }
        } else {
          const sender = message.senderNickname || 'Unknown';
          deps.pushChatMessage(`${sender}: ${message.message}`);
        }
        break;
      }

      case 'pong': {
        const elapsed = Math.max(0, Date.now() - message.clientSentAt);
        deps.updateStatus(`Ping ${elapsed} ms`);
        deps.audioUiBlip();
        break;
      }

      case 'nickname_result': {
        deps.state.player.nickname = deps.sanitizeName(message.effectiveNickname) || 'user...';
        if (message.accepted) {
          deps.dom.preconnectNickname.value = deps.state.player.nickname;
          localStorage.setItem(deps.NICKNAME_STORAGE_KEY, deps.state.player.nickname);
        } else {
          deps.pushChatMessage(message.reason || 'Nickname unavailable.');
          deps.audioUiCancel();
        }
        break;
      }

      case 'item_upsert': {
        deps.state.items.set(message.item.id, {
          ...message.item,
          carrierId: message.item.carrierId ?? null,
        });
        deps.state.carriedItemId = deps.getCarriedItemId();
        deps.recomputeActiveItemPropertyKeys(message.item.id);
        if (deps.state.mode === 'itemProperties' && deps.state.selectedItemId === message.item.id) {
          const key = deps.state.itemPropertyKeys[deps.state.itemPropertyIndex];
          if (key && deps.shouldAnnounceItemPropertyEcho()) {
            deps.updateStatus(`${deps.itemPropertyLabel(key)}: ${deps.getItemPropertyValue(message.item, key)}`);
          }
        }
        await deps.refreshAudioSubscriptions(true);
        break;
      }

      case 'item_remove': {
        deps.state.items.delete(message.itemId);
        deps.state.carriedItemId = deps.getCarriedItemId();
        deps.cleanupItemAudio(message.itemId);
        await deps.refreshAudioSubscriptions(true);
        break;
      }

      case 'item_action_result': {
        const handledByItemBehavior = deps.handleItemActionResultStatus(message);
        if (handledByItemBehavior) {
          break;
        }
        if (message.ok) {
          if (message.action === 'use') {
            deps.pushChatMessage(message.message);
            const item = message.itemId ? deps.getItemById(message.itemId) : null;
            if (!item?.useSound && item && item.type !== 'piano') {
              deps.playLocateToneAt(item.x, item.y);
            }
          } else if (message.action !== 'update') {
            deps.pushChatMessage(message.message);
            deps.audioUiConfirm();
          }
        } else {
          deps.pushChatMessage(message.message);
          deps.audioUiCancel();
        }
        break;
      }

      case 'item_use_sound': {
        const soundUrl = deps.resolveIncomingSoundUrl(message.sound);
        if (!soundUrl) break;
        if (deps.getAudioLayers().world) {
          deps.playIncomingItemUseSound(soundUrl, message.x, message.y);
        }
        break;
      }

      case 'item_piano_note': {
        if (!deps.getAudioLayers().item) break;
        deps.handleRemotePianoNote(message);
        break;
      }
    }
  };
}
