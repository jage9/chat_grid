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
    peers: Map<string, { id: string; userId?: string | null; nickname: string; x: number; y: number }>;
    items: Map<string, WorldItem>;
    mode: string;
    selectedItemId: string | null;
    itemPropertyKeys: string[];
    itemPropertyIndex: number;
    carriedItemId: string | null;
  };
  dom: {
    connectButton: HTMLElement;
    disconnectButton: HTMLElement;
    focusGridButton: HTMLElement;
    canvas: HTMLCanvasElement;
    instructions: HTMLElement;
  };
  signalingSend: (message: unknown) => void;
  peerManager: {
    ensurePeer: (id: string, user: { id: string; nickname: string; x: number; y: number }) => { id: string; nickname: string; x: number; y: number };
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
  handleItemBehaviorIncomingMessage: (message: IncomingMessage) => boolean;
  handleItemBehaviorPeerLeft: (senderId: string) => void;
  TELEPORT_SOUND_URL: string;
  TELEPORT_START_SOUND_URL: string;
  getAudioLayers: () => { world: boolean; item: boolean };
  pushChatMessage: (message: string) => void;
  classifySystemMessageSound: (message: string) => 'logon' | 'logout' | 'notify' | null;
  ACTION_SOUND_URL: string;
  SYSTEM_SOUND_URLS: { logon: string; logout: string; notify: string };
  playSample: (url: string, gain?: number) => void;
  updateStatus: (message: string) => void;
  audioUiBlip: () => void;
  audioUiConfirm: () => void;
  audioUiCancel: () => void;
  getCarriedItemId: () => string | null;
  recomputeActiveItemPropertyKeys: (itemId: string) => void;
  itemPropertyLabel: (key: string) => string;
  getItemPropertyValue: (item: WorldItem, key: string) => string;
  getItemById: (itemId: string) => WorldItem | undefined;
  shouldAnnounceItemPropertyEcho: () => boolean;
  playLocateToneAt: (x: number, y: number) => void;
  resolveIncomingSoundUrl: (url: string) => string;
  playIncomingItemUseSound: (url: string, x: number, y: number, range?: number) => void;
  playClockAnnouncement: (sounds: string[], x: number, y: number, range?: number) => void;
  handleAuthRequired: (message: Extract<IncomingMessage, { type: 'auth_required' }>) => void;
  handleAuthResult: (message: Extract<IncomingMessage, { type: 'auth_result' }>) => Promise<void>;
  handleAuthPermissions: (message: Extract<IncomingMessage, { type: 'auth_permissions' }>) => void;
  handleAdminRolesList: (message: Extract<IncomingMessage, { type: 'admin_roles_list' }>) => void;
  handleAdminUsersList: (message: Extract<IncomingMessage, { type: 'admin_users_list' }>) => void;
  handleAdminActionResult: (message: Extract<IncomingMessage, { type: 'admin_action_result' }>) => void;
  handleItemTransferTargets: (message: Extract<IncomingMessage, { type: 'item_transfer_targets' }>) => void;
  connectToLiveKit: (url: string, token: string) => void;
};

/**
 * Builds the websocket message dispatcher used by the signaling client.
 */
export function createOnMessageHandler(deps: MessageHandlerDeps): (message: IncomingMessage) => Promise<void> {
  return async function onMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'auth_required':
        deps.handleAuthRequired(message);
        break;

      case 'auth_result':
        await deps.handleAuthResult(message);
        break;
      case 'auth_permissions':
        deps.handleAuthPermissions(message);
        break;
      case 'admin_roles_list':
        deps.handleAdminRolesList(message);
        break;
      case 'admin_users_list':
        deps.handleAdminUsersList(message);
        break;
      case 'admin_action_result':
        deps.handleAdminActionResult(message);
        break;
      case 'item_transfer_targets':
        deps.handleItemTransferTargets(message);
        break;

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
        }
        deps.state.addItemTypeIndex = 0;
        deps.state.player.id = message.id;
        deps.state.running = true;
        deps.setConnecting(false);
        deps.state.player.x = Math.max(0, Math.min(deps.getWorldGridSize() - 1, message.player.x));
        deps.state.player.y = Math.max(0, Math.min(deps.getWorldGridSize() - 1, message.player.y));
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

      case 'livekit_token': {
        deps.connectToLiveKit(message.url, message.token);
        break;
      }

      case 'update_position': {
        if (message.id === deps.state.player.id) {
          deps.state.player.x = message.x;
          deps.state.player.y = message.y;
          break;
        }
        let peer = deps.state.peers.get(message.id);
        if (!peer) {
          peer = { id: message.id, nickname: 'user...', x: message.x, y: message.y };
          deps.state.peers.set(message.id, peer);
          deps.peerManager.ensurePeer(message.id, peer);
        }
        const prevX = peer.x;
        const prevY = peer.y;
        peer.x = message.x;
        peer.y = message.y;
        deps.peerManager.setPeerPosition(message.id, message.x, message.y);
        const movementDelta = Math.hypot(message.x - prevX, message.y - prevY);
        if (movementDelta <= 1.5 && deps.getAudioLayers().world) {
          deps.playRemoteSpatialStepOrTeleport(deps.randomFootstepUrl(), peer.x, peer.y);
        }
        break;
      }

      case 'teleport_complete': {
        if (deps.getAudioLayers().world) {
          deps.playIncomingItemUseSound(deps.TELEPORT_SOUND_URL, message.x, message.y);
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
        deps.handleItemBehaviorPeerLeft(message.id);
        deps.state.peers.delete(message.id);
        deps.peerManager.removePeer(message.id);
        break;
      }

      case 'chat_message': {
        if (message.action) {
          deps.pushChatMessage(message.message);
          deps.playSample(deps.ACTION_SOUND_URL, 1);
        } else if (message.system) {
          deps.pushChatMessage(message.message);
          const normalized = message.message.trim().toLowerCase();
          if (normalized === 'server reboot already in progress.') {
            deps.audioUiBlip();
            break;
          }
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
        if (!message.accepted) {
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
        const text = message.message.trim();
        if (message.ok) {
          if (message.action === 'use' || message.action === 'secondary_use') {
            if (text) {
              deps.pushChatMessage(text);
            }
            const item = message.itemId ? deps.getItemById(message.itemId) : null;
            if (message.action === 'use' && !item?.useSound && item && item.type !== 'piano') {
              deps.playLocateToneAt(item.x, item.y);
            }
          } else if (message.action !== 'update') {
            if (text) {
              deps.pushChatMessage(text);
            }
            deps.audioUiConfirm();
          }
        } else {
          if (text) {
            deps.pushChatMessage(text);
          }
          deps.audioUiCancel();
        }
        break;
      }

      case 'item_use_sound': {
        const soundUrl = deps.resolveIncomingSoundUrl(message.sound);
        if (!soundUrl) break;
        if (deps.getAudioLayers().world) {
          deps.playIncomingItemUseSound(soundUrl, message.x, message.y, message.range);
        }
        break;
      }

      case 'item_piano_note': {
        if (!deps.getAudioLayers().item) break;
        deps.handleItemBehaviorIncomingMessage(message);
        break;
      }

      case 'item_clock_announce': {
        if (!deps.getAudioLayers().world) break;
        deps.playClockAnnouncement(message.sounds, message.x, message.y, message.range);
        break;
      }

      case 'item_piano_status': {
        deps.handleItemBehaviorIncomingMessage(message);
        break;
      }
    }
  };
}
