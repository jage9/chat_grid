import { type IncomingMessage } from './protocol';
import { legacyPlatforms, type FootstepSet, type Platform } from '../state/platformGeometry';
import { getFacingDirection, type NamedRegion, type AmbianceRegion, type AmbianceType, type StructurePreset, type WallStructure, type WorldItem } from '../state/gameState';
import { WORLD_FOOTSTEP_GAIN, type WorldSoundSource } from '../audio/worldAudio';
import { announcePropertyValue } from '../input/propertyControls';
import { resolveWorldItemSourcePosition } from '../audio/worldItemPosition';
import { worldItemAcousticZoneId } from '../audio/acousticZones';

/**
 * Dependency contract for creating a message handler without hard-coupling to `main.ts`.
 */
type MessageHandlerDeps = {
  handleElevatorStatus?: (message: Extract<IncomingMessage, { type: 'item_elevator_status' }>) => void;
  getWorldGridSize: () => number;
  setWorldGridSize: (size: number) => void;
  setStructurePresets: (presets: StructurePreset[]) => void;
  setAmbianceTypes: (types: AmbianceType[]) => void;
  setFootstepSets?: (sets: FootstepSet[]) => void;
  refreshStructureGeometry: () => void;
  setMovementTickMs: (value: number) => void;
  setConnecting: (value: boolean) => void;
  rendererSetGridSize: (size: number) => void;
  applyServerItemUiDefinitions: (defs: unknown) => boolean;
  state: {
    addItemTypeIndex: number;
    player: { id: string | null; nickname: string; x: number; y: number; z: number; facingDeg: number; acousticZoneId: string };
    running: boolean;
    peers: Map<string, { id: string; userId?: string | null; nickname: string; x: number; y: number; z: number; facingDeg: number; acousticZoneId: string }>;
    items: Map<string, WorldItem>;
    structures: Map<string, WallStructure>;
    platforms: Map<string, Platform>;
    ambiances: Map<string, AmbianceRegion>;
    regions: Map<string, NamedRegion>;
    mode: string;
    selectedItemId: string | null;
    itemPropertyKeys: string[];
    itemPropertyIndex: number;
    elevatorItemId: string | null;
  };
  dom: {
    connectButton: HTMLElement;
    disconnectButton: HTMLElement;
    focusGridButton: HTMLElement;
    canvas: HTMLCanvasElement;
    instructions: HTMLElement;
  };
  peerManager: {
    ensurePeer: (id: string, user: { id: string; userId?: string | null; nickname: string; x: number; y: number; z: number; facingDeg: number; acousticZoneId: string }) => unknown;
    setPeerPosition: (id: string, x: number, y: number, z: number, acousticZoneId: string) => void;
    setListenerPosition: (x: number, y: number, z: number) => void;
    setPeerNickname: (id: string, nickname: string) => void;
    removePeer: (id: string) => void;
  };
  refreshAudioSubscriptions: (force?: boolean) => Promise<void>;
  refreshAcousticModel: () => void;
  cleanupItemAudio: (itemId: string) => void;
  applyAudioLayerState: () => Promise<void>;
  gameLoop: () => void;
  sanitizeName: (value: string) => string;
  randomFootstepUrl: (x: number, y: number, z: number) => string;
  playWorldSound: (url: string, source: WorldSoundSource) => void;
  playWorldSoundSequence: (urls: string[], source: WorldSoundSource) => void;
  handleItemActionResultStatus: (message: Extract<IncomingMessage, { type: 'item_action_result' }>) => boolean;
  handleItemBehaviorIncomingMessage: (message: IncomingMessage) => boolean;
  handleItemBehaviorPeerLeft: (senderId: string) => void;
  TELEPORT_SOUND_URL: string;
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
  recomputeActiveItemPropertyKeys: (itemId: string) => void;
  getItemPropertyValue: (item: WorldItem, key: string) => string;
  getItemById: (itemId: string) => WorldItem | undefined;
  shouldAnnounceItemPropertyEcho: (itemId: string) => boolean;
  playLocateToneAt: (x: number, y: number) => void;
  resolveIncomingSoundUrl: (url: string) => string;
  handleAuthRequired: (message: Extract<IncomingMessage, { type: 'auth_required' }>) => void;
  handleAuthResult: (message: Extract<IncomingMessage, { type: 'auth_result' }>) => Promise<void>;
  handleAuthPermissions: (message: Extract<IncomingMessage, { type: 'auth_permissions' }>) => void;
  handleAdminRolesList: (message: Extract<IncomingMessage, { type: 'admin_roles_list' }>) => void;
  handleAdminUsersList: (message: Extract<IncomingMessage, { type: 'admin_users_list' }>) => void;
  handleAdminActionResult: (message: Extract<IncomingMessage, { type: 'admin_action_result' }>) => void;
  handleItemTransferTargets: (message: Extract<IncomingMessage, { type: 'item_transfer_targets' }>) => void;
  handleItemHandTargets: (message: Extract<IncomingMessage, { type: 'item_hand_targets' }>) => void;
  handleCheckpointResult?: (message: Extract<IncomingMessage, { type: 'checkpoint_result' }>) => void;
  handleWorldRestored?: () => void;
  handleDoorResult?: (message: Extract<IncomingMessage, {type: 'door_action_result'}>) => void;
  handleStructureActionResult: (message: Extract<IncomingMessage, { type: 'structure_action_result' }>) => void;
  handleRegionActionResult?: (message: Extract<IncomingMessage, { type: 'region_action_result' }>) => void;
  handlePlatformActionResult?: (message: Extract<IncomingMessage, { type: 'platform_action_result' }>) => void;
  handlePlatformGeometryChanged?: () => void;
  handleAmbianceActionResult: (message: Extract<IncomingMessage, { type: 'ambiance_action_result' }>) => void;
  handleTeleportTransition: (message: Extract<IncomingMessage, { type: 'teleport_transition' }>) => void;
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
      case 'item_hand_targets':
        deps.handleItemHandTargets(message);
        break;
      case 'checkpoint_result':
        deps.handleCheckpointResult?.(message);
        break;
      case 'world_restored':
        deps.handleWorldRestored?.();
        if (message.platforms) deps.state.platforms = new Map(message.platforms.map((p) => [p.id, p]));
        deps.state.items = new Map(message.items.map((item) => [item.id, item]));
        deps.state.structures = new Map(message.structures.map((wall) => [wall.id, wall]));
        deps.state.ambiances = new Map(message.ambiances.map((ambiance) => [ambiance.id, ambiance]));
        deps.state.regions = new Map(message.regions.map((region) => [region.id, region]));
        deps.state.selectedItemId = null;
        deps.state.itemPropertyKeys = [];
        deps.state.itemPropertyIndex = 0;
        deps.state.elevatorItemId = null;
        deps.state.mode = 'normal';
        deps.refreshStructureGeometry();
        deps.refreshAcousticModel();
        await deps.refreshAudioSubscriptions(true);
        break;
      case 'door_action_result':
        deps.handleDoorResult?.(message);
        break;
      case 'structure_action_result':
        deps.handleStructureActionResult(message);
        break;
      case 'structure_upsert':
        deps.state.structures.set(message.structure.id, message.structure);
        deps.refreshStructureGeometry();
        break;
      case 'structure_remove':
        deps.state.structures.delete(message.structureId);
        deps.refreshStructureGeometry();
        break;
      case 'region_action_result':
        deps.handleRegionActionResult?.(message);
        break;
      case 'platform_action_result':
        deps.handlePlatformActionResult?.(message);
        break;
      case 'platform_upsert':
        deps.state.platforms.set(message.platform.id, message.platform);
        deps.handlePlatformGeometryChanged?.();
        break;
      case 'platform_remove':
        deps.state.platforms.delete(message.platformId);
        deps.handlePlatformGeometryChanged?.();
        break;
      case 'region_upsert':
        deps.state.regions.set(message.region.id, message.region);
        break;
      case 'region_remove':
        deps.state.regions.delete(message.regionId);
        break;
      case 'ambiance_action_result':
        deps.handleAmbianceActionResult(message);
        break;
      case 'ambiance_upsert':
        deps.state.ambiances.set(message.ambiance.id, message.ambiance);
        break;
      case 'ambiance_remove':
        deps.state.ambiances.delete(message.ambianceId);
        break;
      case 'world_sound':
        deps.playWorldSound(deps.resolveIncomingSoundUrl(message.sound), message);
        break;

      case 'welcome':
        if (message.worldConfig?.gridSize && Number.isInteger(message.worldConfig.gridSize) && message.worldConfig.gridSize > 0) {
          deps.setWorldGridSize(message.worldConfig.gridSize);
        }
        if (message.worldConfig?.movementTickMs && Number.isInteger(message.worldConfig.movementTickMs) && message.worldConfig.movementTickMs > 0) {
          deps.setMovementTickMs(message.worldConfig.movementTickMs);
        }
        const platforms = message.platforms ?? legacyPlatforms(deps.getWorldGridSize(), message.worldConfig?.floors);
        deps.state.platforms = new Map(platforms.map((p) => [p.id, p]));
        deps.setStructurePresets(message.worldConfig?.structurePresets ?? []);
        deps.setAmbianceTypes(message.worldConfig?.ambianceTypes ?? []);
        deps.setFootstepSets?.(message.worldConfig?.footstepSets ?? []);
        deps.rendererSetGridSize(deps.getWorldGridSize());
        const schemaReady = deps.applyServerItemUiDefinitions(message.uiDefinitions);
        if (!schemaReady) {
          deps.updateStatus('Item schema missing from server. Item menus unavailable.');
        }
        deps.state.addItemTypeIndex = 0;
        deps.state.player.id = message.id;
        deps.state.running = true;
        deps.setConnecting(false);
        deps.state.player.x = message.player.x;
        deps.state.player.y = message.player.y;
        deps.state.player.z = message.player.z;
        deps.state.player.facingDeg = message.player.facingDeg;
        deps.state.player.acousticZoneId = message.player.acousticZoneId;
        deps.peerManager.setListenerPosition(message.player.x, message.player.y, message.player.z);
        deps.dom.connectButton.classList.add('hidden');
        deps.dom.disconnectButton.classList.remove('hidden');
        deps.dom.focusGridButton.classList.remove('hidden');
        deps.dom.canvas.classList.remove('hidden');
        deps.dom.instructions.classList.remove('hidden');
        deps.dom.canvas.focus();

        for (const user of message.users) {
          const rosterPeer = { ...user, userId: user.userId ?? null };
          deps.state.peers.set(user.id, rosterPeer);
          deps.peerManager.ensurePeer(user.id, rosterPeer);
        }
        deps.state.items.clear();
        for (const item of message.items || []) {
          deps.state.items.set(item.id, {
            ...item,
            carrierId: item.carrierId ?? null,
          });
        }
        deps.state.regions.clear();
        for (const region of message.regions ?? []) deps.state.regions.set(region.id, region);
        deps.state.ambiances.clear();
        for (const ambiance of message.ambiances ?? []) {
          deps.state.ambiances.set(ambiance.id, ambiance);
        }
        deps.state.structures.clear();
        for (const structure of message.structures || []) {
          deps.state.structures.set(structure.id, structure);
        }
        deps.refreshStructureGeometry();
        deps.refreshAcousticModel();
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
          const facingChanged = deps.state.player.facingDeg !== message.facingDeg;
          const floorChanged = deps.state.player.z !== message.z;
          deps.state.player.x = message.x;
          deps.state.player.y = message.y;
          deps.state.player.z = message.z;
          deps.state.player.facingDeg = message.facingDeg;
          const zoneChanged = deps.state.player.acousticZoneId !== message.acousticZoneId;
          deps.state.player.acousticZoneId = message.acousticZoneId;
          deps.peerManager.setListenerPosition(message.x, message.y, message.z);
          if (floorChanged || zoneChanged) {
            deps.refreshAcousticModel();
            await deps.refreshAudioSubscriptions(true);
          }
          if (facingChanged) {
            deps.updateStatus(getFacingDirection(message.facingDeg));
          }
          break;
        }
        const peer = deps.state.peers.get(message.id);
        const prevX = peer?.x ?? message.x;
        const prevY = peer?.y ?? message.y;
        if (peer) {
          if (message.userId !== undefined) peer.userId = message.userId;
          peer.x = message.x;
          peer.y = message.y;
          peer.z = message.z;
          peer.facingDeg = message.facingDeg;
          peer.acousticZoneId = message.acousticZoneId;
        } else {
          deps.state.peers.set(message.id, {
            id: message.id,
            userId: message.userId ?? null,
            nickname: 'user...',
            x: message.x,
            y: message.y,
            z: message.z,
            facingDeg: message.facingDeg,
            acousticZoneId: message.acousticZoneId,
          });
        }
        deps.peerManager.ensurePeer(message.id, deps.state.peers.get(message.id)!);
        deps.peerManager.setPeerPosition(message.id, message.x, message.y, message.z, message.acousticZoneId);
        deps.refreshAcousticModel();
        if (peer) {
          const movementDelta = Math.hypot(message.x - prevX, message.y - prevY);
          if (movementDelta > 0 && movementDelta <= 1.5) {
            deps.playWorldSound(deps.randomFootstepUrl(peer.x, peer.y, peer.z), {
              x: peer.x,
              y: peer.y,
              z: peer.z,
              acousticZoneId: peer.acousticZoneId,
              gain: WORLD_FOOTSTEP_GAIN,
            });
          }
        }
        break;
      }

      case 'teleport_transition':
        deps.handleTeleportTransition(message);
        break;

      case 'teleport_complete': {
        const peer = deps.state.peers.get(message.id);
        if (peer) {
          peer.facingDeg = message.facingDeg;
        }
        deps.playWorldSound(deps.TELEPORT_SOUND_URL, message);
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
        const previousItem = deps.state.items.get(message.item.id);
        deps.state.items.set(message.item.id, {
          ...message.item,
          carrierId: message.item.carrierId ?? null,
        });
        deps.refreshAcousticModel();
        deps.recomputeActiveItemPropertyKeys(message.item.id);
        if (deps.state.mode === 'itemProperties' && deps.state.selectedItemId === message.item.id) {
          const key = deps.state.itemPropertyKeys[deps.state.itemPropertyIndex];
          const value = key ? deps.getItemPropertyValue(message.item, key) : '';
          if (
            key && previousItem &&
            value !== deps.getItemPropertyValue(previousItem, key) &&
            deps.shouldAnnounceItemPropertyEcho(message.item.id)
          ) {
            const parkedZ = message.item.type === 'elevator' && key === 'floorZs'
              && previousItem.params.currentZ !== message.item.params.currentZ
              ? message.item.params.currentZ : undefined;
            announcePropertyValue(deps.updateStatus, parkedZ === undefined ? value : `${value}. Car parked at height ${parkedZ}.`);
          }
        }
        await deps.refreshAudioSubscriptions(true);
        break;
      }

      case 'item_elevator_status': {
        const previousElevatorItemId = deps.state.elevatorItemId;
        deps.state.elevatorItemId = message.event === 'exited' ? null : message.itemId;
        if (message.message) {
          deps.updateStatus(message.message);
        }
        deps.handleElevatorStatus?.(message);
        if (previousElevatorItemId !== deps.state.elevatorItemId) {
          deps.refreshAcousticModel();
          await deps.refreshAudioSubscriptions(true);
        }
        break;
      }

      case 'item_remove': {
        deps.state.items.delete(message.itemId);
        deps.refreshAcousticModel();
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
        const item = deps.state.items.get(message.itemId);
        const listener = deps.state.player;
        const useItemPosition = item && !item.carrierId && item.type !== 'elevator';
        const position = useItemPosition
          ? resolveWorldItemSourcePosition(item, listener.z, listener.x, listener.y)
          : message;
        const acousticZoneId = useItemPosition
          ? worldItemAcousticZoneId(item, deps.state)
          : message.acousticZoneId;
        deps.playWorldSound(soundUrl, { ...message, ...position, acousticZoneId });
        break;
      }

      case 'item_piano_note': {
        if (!deps.getAudioLayers().item) break;
        deps.handleItemBehaviorIncomingMessage(message);
        break;
      }

      case 'item_clock_announce': {
        deps.playWorldSoundSequence(message.sounds.map(deps.resolveIncomingSoundUrl), message);
        break;
      }

      case 'item_piano_status': {
        deps.handleItemBehaviorIncomingMessage(message);
        break;
      }
    }
  };
}
