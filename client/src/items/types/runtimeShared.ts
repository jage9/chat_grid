import { type IncomingMessage, type OutgoingMessage } from '../../network/protocol';
import { type GameMode, type WorldItem } from '../../state/gameState';
import { type CommandDescriptor, type ModeInput } from '../../input/commandTypes';

/** Shared dependencies made available to all client item behavior modules. */
export type ItemBehaviorDeps = {
  state: {
    mode: GameMode;
    items: Map<string, WorldItem>;
    player: { id: string | null; x: number; y: number; z: number };
  };
  audio: {
    ensureContext: () => Promise<void>;
    context: AudioContext | null;
    getOutputDestinationNode: () => AudioNode | null;
    sfxUiBlip: () => void;
    sfxUiCancel: () => void;
  };
  signalingSend: (message: OutgoingMessage) => void;
  updateStatus: (message: string) => void;
  openHelpViewer: (lines: string[], returnMode: GameMode) => void;
  withBase: (path: string) => string;
  getWallTransmission: (sourceX: number, sourceY: number, sourceZ: number) => number;
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
