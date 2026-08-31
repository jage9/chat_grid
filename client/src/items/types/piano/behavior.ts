import { type ItemBehavior, type ItemBehaviorDeps } from '../runtimeShared';
import { PianoController } from './runtime';

/** Creates runtime behavior hooks for piano items. */
export function createPianoBehavior(deps: ItemBehaviorDeps): ItemBehavior {
  const controller = new PianoController({
    state: deps.state,
    audio: deps.audio,
    signalingSend: deps.signalingSend,
    updateStatus: deps.updateStatus,
    openHelpViewer: deps.openHelpViewer,
    getWallAcousticMix: deps.getWallAcousticMix,
  });

  return {
    onInit: async () => {
      await controller.loadHelpFromUrl(deps.withBase('piano.json'));
      await controller.loadDemoFromUrl(deps.withBase('piano_demo.json'));
    },
    onCleanup: () => {
      controller.cleanup();
    },
    onActionResultStatus: (message) => {
      if (message.action !== 'use' || typeof message.itemId !== 'string') return false;
      const item = deps.state.items.get(message.itemId);
      if (item?.type !== 'piano') return false;
      deps.updateStatus(message.message);
      if (message.ok) {
        deps.audio.sfxUiBlip();
      } else {
        deps.audio.sfxUiCancel();
      }
      return true;
    },
    onPropertyPreviewChange: (item, key, value) => {
      controller.onPreviewPropertyChange(item, key, value);
    },
    onWorldUpdate: () => {
      controller.syncAfterWorldUpdate();
    },
    handleModeInput: (mode, input) => {
      if (mode !== 'pianoUse') return false;
      controller.handleModeInput(input);
      return true;
    },
    handleModeKeyUp: (mode, input) => {
      if (mode !== 'pianoUse') return false;
      controller.handleModeKeyUp(input);
      return true;
    },
    canOpenModeCommandPalette: (mode) => mode === 'pianoUse',
    getModeKeyUpTarget: (activeMode, returnMode) => {
      if (activeMode === 'pianoUse') return 'pianoUse';
      if (activeMode === 'commandPalette' && returnMode === 'pianoUse') return 'pianoUse';
      return null;
    },
    getModeCommands: (mode) => {
      if (mode !== 'pianoUse') return [];
      return controller.getModeCommands();
    },
    runModeCommand: (mode, commandId) => {
      if (mode !== 'pianoUse') return false;
      return controller.runModeCommand(commandId);
    },
    onIncomingMessage: (message) => {
      if (message.type === 'item_piano_note') {
        if (message.on) {
          controller.playRemoteNote({
            itemId: message.itemId,
            senderId: message.senderId,
            keyId: message.keyId,
            midi: message.midi,
            instrument: message.instrument,
            voiceMode: message.voiceMode,
            octave: message.octave,
            attack: message.attack,
            decay: message.decay,
            release: message.release,
            brightness: message.brightness,
            x: message.x,
            y: message.y,
            z: message.z,
            emitRange: message.emitRange,
          });
        } else {
          controller.stopRemoteNote(message.senderId, message.keyId);
        }
        return true;
      }
      if (message.type === 'item_piano_status') {
        controller.onPianoStatus(message);
        return true;
      }
      return false;
    },
    onPeerLeft: (senderId) => {
      controller.stopAllRemoteNotesForSender(senderId);
    },
  };
}
