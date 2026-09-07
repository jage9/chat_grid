import type { GameMode } from '../state/gameState';
import type { ModeInput } from './commandTypes';

type KeyboardControllerDeps = {
  dom: {
    settingsModal: HTMLDivElement;
    canvas: HTMLCanvasElement;
  };
  state: {
    running: boolean;
    mode: GameMode;
    keysPressed: Record<string, boolean>;
    nicknameInput: string;
    cursorPos: number;
  };
  isTextEditingMode: (mode: GameMode) => boolean;
  closeSettings: () => void;
  hasBlockedArrowTeleport: (code: string) => boolean;
  handleModeInput: (input: ModeInput) => void;
  canOpenCommandPaletteInMode: (mode: GameMode) => boolean;
  openCommandPalette: () => void;
  getModeKeyUpTarget: (activeMode: GameMode) => GameMode | null;
  onModeKeyUp: (mode: GameMode, input: Pick<ModeInput, 'code' | 'shiftKey'>) => void;
  pasteIntoActiveTextInput: (text: string) => boolean;
  updateStatus: (message: string) => void;
  setReplaceTextOnNextType: (value: boolean) => void;
};

/**
 * Wires global keyboard/paste input handlers and leaves mode-specific behavior to injected callbacks.
 */
export function setupKeyboardInputHandlers(deps: KeyboardControllerDeps): void {
  let internalClipboardText = '';

  function isTypingKey(code: string): boolean {
    return code.startsWith('Key') || code === 'Space';
  }

  function codeFromKey(key: string, location: number): string | null {
    if (key === 'Escape' || key === 'Esc') return 'Escape';
    if (key === 'Enter' || key === 'Return') return 'Enter';
    if (key === 'Backspace') return 'Backspace';
    if (key === 'Delete' || key === 'Del') return 'Delete';
    if (key === 'ArrowUp' || key === 'Up') return 'ArrowUp';
    if (key === 'ArrowDown' || key === 'Down') return 'ArrowDown';
    if (key === 'ArrowLeft' || key === 'Left') return 'ArrowLeft';
    if (key === 'ArrowRight' || key === 'Right') return 'ArrowRight';
    if (key === 'Home') return 'Home';
    if (key === 'End') return 'End';
    if (key === 'PageUp') return 'PageUp';
    if (key === 'PageDown') return 'PageDown';
    if (key === 'Tab') return 'Tab';
    if (key === ' ' || key === 'Spacebar') return 'Space';
    if (key.length === 1) {
      if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
      if (/^[0-9]$/.test(key)) return `Digit${key}`;
      if (key === '!') return 'Digit1';
      if (key === '@') return 'Digit2';
      if (key === '#') return 'Digit3';
      if (key === '$') return 'Digit4';
      if (key === '%') return 'Digit5';
      if (key === '^') return 'Digit6';
      if (key === '&') return 'Digit7';
      if (key === '*') return 'Digit8';
      if (key === '(') return 'Digit9';
      if (key === ')') return 'Digit0';
      if (key === '+' && location === 3) return 'NumpadAdd';
      if (key === '-' && location === 3) return 'NumpadSubtract';
      if (key === '+' || key === '=') return 'Equal';
      if (key === '-' || key === '_') return 'Minus';
      if (key === '/' || key === '?') return 'Slash';
      if (key === ',' || key === '<') return 'Comma';
      if (key === '.' || key === '>') return 'Period';
      if (key === ';' || key === ':') return 'Semicolon';
      if (key === "'" || key === '"') return 'Quote';
      if (key === '[' || key === '{') return 'BracketLeft';
      if (key === ']' || key === '}') return 'BracketRight';
      if (key === '\\' || key === '|') return 'Backslash';
    }
    return null;
  }

  function normalizeInputCode(event: KeyboardEvent): string {
    if (event.code && event.code !== 'Unidentified') {
      return event.code;
    }
    return codeFromKey(event.key, event.location) ?? event.code ?? '';
  }

  document.addEventListener('keydown', (event) => {
    const code = normalizeInputCode(event);
    if (!code) return;
    const hasShortcutModifier = event.ctrlKey || event.metaKey;
    const input: ModeInput = {
      code,
      key: event.key,
      ctrlKey: hasShortcutModifier,
      shiftKey: event.shiftKey,
    };

    if (!deps.dom.settingsModal.classList.contains('hidden') && code === 'Escape') {
      deps.closeSettings();
      return;
    }

    if (!deps.state.running) return;
    if (document.activeElement !== deps.dom.canvas) return;
    if (event.altKey) return;
    if (hasShortcutModifier && !deps.isTextEditingMode(deps.state.mode)) return;
    if (deps.hasBlockedArrowTeleport(code)) {
      event.preventDefault();
      return;
    }

    const isNativePasteShortcut = hasShortcutModifier && deps.isTextEditingMode(deps.state.mode) && code === 'KeyV';
    if ((deps.state.mode !== 'normal' || !code.startsWith('Arrow')) && !isNativePasteShortcut) {
      event.preventDefault();
    }

    if (hasShortcutModifier && deps.isTextEditingMode(deps.state.mode)) {
      if (code === 'KeyV') {
        return;
      }
      if (code === 'KeyC') {
        const text = deps.state.nicknameInput;
        internalClipboardText = text;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        deps.updateStatus('copied');
        return;
      }
      if (code === 'KeyX') {
        const text = deps.state.nicknameInput;
        internalClipboardText = text;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        deps.state.nicknameInput = '';
        deps.state.cursorPos = 0;
        deps.setReplaceTextOnNextType(false);
        deps.updateStatus('cut');
        return;
      }
    }

    const isAudioToggle = deps.state.mode === 'normal' && /^Digit[1-4]$/.test(code);
    if (isAudioToggle && event.repeat) return;
    if ((isTypingKey(code) || isAudioToggle) && deps.state.keysPressed[code]) return;

    const opensCommandPalette =
      deps.canOpenCommandPaletteInMode(deps.state.mode) &&
      ((code === 'KeyK' && event.shiftKey) || code === 'ContextMenu' || (code === 'F10' && event.shiftKey));
    if (opensCommandPalette) {
      deps.openCommandPalette();
      deps.state.keysPressed[code] = true;
      return;
    }

    deps.handleModeInput(input);
    deps.state.keysPressed[code] = true;
  });

  document.addEventListener('keyup', (event) => {
    const code = normalizeInputCode(event);
    const keyUpMode = deps.getModeKeyUpTarget(deps.state.mode);
    if (code && keyUpMode) {
      deps.onModeKeyUp(keyUpMode, {
        code,
        shiftKey: event.shiftKey,
      });
    }
    if (code) {
      deps.state.keysPressed[code] = false;
    }
    if (event.code && event.code !== code) {
      deps.state.keysPressed[event.code] = false;
    }
  });

  document.addEventListener('paste', (event) => {
    if (document.activeElement !== deps.dom.canvas) return;
    if (!deps.state.running) return;
    const pasted = event.clipboardData?.getData('text') ?? internalClipboardText;
    if (!deps.pasteIntoActiveTextInput(pasted)) return;
    event.preventDefault();
    deps.updateStatus('pasted');
  });
}
