import { type IncomingMessage, type OutgoingMessage } from '../../network/protocol';
import { type GameMode, type WorldItem } from '../../state/gameState';
import { type CommandDescriptor, type ModeInput } from '../../input/commandTypes';
import type { AcousticMix } from '../../audio/acoustics';
import type { SpatialAudioPosition } from '../../audio/audioEngine';

/** Shared dependencies made available to all client item behavior modules. */
export type ItemBehaviorDeps = {
  state: {
    mode: GameMode;
    items: Map<string, WorldItem>;
    player: { id: string | null; x: number; y: number; z: number; acousticZoneId: string };
  };
  audio: {
    ensureContext: () => Promise<void>;
    context: AudioContext | null;
    getOutputDestinationNode: () => AudioNode | null;
    registerSpatialUpdater: (update: () => void) => () => void;
    resolveSpatialTransmission: (source: SpatialAudioPosition, listener: SpatialAudioPosition) => AcousticMix;
    sfxUiBlip: () => void;
    sfxUiCancel: () => void;
  };
  signalingSend: (message: OutgoingMessage) => void;
  updateStatus: (message: string) => void;
  openHelpViewer: (lines: string[], returnMode: GameMode) => void;
  withBase: (path: string) => string;
  getWallAcousticMix: (sourceX: number, sourceY: number, sourceZ: number) => { gain: number; lowpassHz: number };
};

/** Optional per-item behavior hooks used by the client runtime. */
export type ItemBehavior = {
  onInit?: () => void | Promise<void>;
  onCleanup?: () => void;
  onUseResultMessage?: (message: IncomingMessage) => void;
  onActionResultStatus?: (message: Extract<IncomingMessage, { type: 'item_action_result' }>) => boolean;
  onPropertyPreviewChange?: (item: WorldItem, key: string, value: unknown) => void;
  onWorldUpdate?: () => void;
  handleModeInput?: (mode: GameMode, input: ModeInput) => boolean;
  handleModeKeyUp?: (mode: GameMode, input: Pick<ModeInput, 'code' | 'shiftKey'>) => boolean;
  canOpenModeCommandPalette?: (mode: GameMode) => boolean;
  getModeKeyUpTarget?: (activeMode: GameMode, returnMode: GameMode) => GameMode | null;
  getModeCommands?: (mode: GameMode) => CommandDescriptor[];
  runModeCommand?: (mode: GameMode, commandId: string) => boolean;
  onIncomingMessage?: (message: IncomingMessage) => boolean;
  onPeerLeft?: (senderId: string) => void;
};
