/**
 * Declarative command ids for the primary gameplay input mode.
 */
export type MainModeCommand =
  | 'editNickname'
  | 'toggleMute'
  | 'toggleOutputMode'
  | 'toggleLoopback'
  | 'toggleVoiceLayer'
  | 'toggleItemLayer'
  | 'toggleMediaLayer'
  | 'toggleWorldLayer'
  | 'masterVolumeUp'
  | 'masterVolumeDown'
  | 'openEffectSelect'
  | 'effectValueUp'
  | 'effectValueDown'
  | 'speakCoordinates'
  | 'openMicGainEdit'
  | 'calibrateMicrophone'
  | 'useItem'
  | 'speakUsers'
  | 'addItem'
  | 'locateOrListItems'
  | 'pickupDropOrDelete'
  | 'editOrInspectItem'
  | 'pingServer'
  | 'locateOrListUsers'
  | 'openHelp'
  | 'openChat'
  | 'chatPrev'
  | 'chatNext'
  | 'chatFirst'
  | 'chatLast'
  | 'escape';

/**
 * Maps raw key events to a semantic command for main mode handling.
 */
export function resolveMainModeCommand(code: string, shiftKey: boolean): MainModeCommand | null {
  if (code === 'KeyN') return shiftKey ? null : 'editNickname';
  if (code === 'KeyM') return shiftKey ? 'toggleOutputMode' : 'toggleMute';
  if (code === 'Digit1') return shiftKey ? 'toggleLoopback' : 'toggleVoiceLayer';
  if (code === 'Digit2') return 'toggleItemLayer';
  if (code === 'Digit3') return 'toggleMediaLayer';
  if (code === 'Digit4') return 'toggleWorldLayer';
  if (code === 'KeyE') return shiftKey ? null : 'openEffectSelect';
  if (code === 'Equal') return shiftKey ? 'effectValueUp' : 'masterVolumeUp';
  if (code === 'Minus') return shiftKey ? 'effectValueDown' : 'masterVolumeDown';
  if (code === 'NumpadAdd') return 'masterVolumeUp';
  if (code === 'NumpadSubtract') return 'masterVolumeDown';
  if (code === 'KeyC') return shiftKey ? null : 'speakCoordinates';
  if (code === 'KeyV') return shiftKey ? 'calibrateMicrophone' : 'openMicGainEdit';
  if (code === 'Enter') return 'useItem';
  if (code === 'KeyU') return shiftKey ? null : 'speakUsers';
  if (code === 'KeyA') return shiftKey ? null : 'addItem';
  if (code === 'KeyI') return 'locateOrListItems';
  if (code === 'KeyD') return 'pickupDropOrDelete';
  if (code === 'KeyO') return 'editOrInspectItem';
  if (code === 'KeyP') return shiftKey ? null : 'pingServer';
  if (code === 'KeyL') return 'locateOrListUsers';
  if (code === 'Slash') return shiftKey ? 'openHelp' : 'openChat';
  if (code === 'Comma') return shiftKey ? 'chatFirst' : 'chatPrev';
  if (code === 'Period') return shiftKey ? 'chatLast' : 'chatNext';
  if (code === 'Escape') return 'escape';
  return null;
}
