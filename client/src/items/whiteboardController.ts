import { handleListControlKey } from '../input/listController';
import type { OutgoingMessage } from '../network/protocol';
import type { GameMode, WorldItem } from '../state/gameState';

const LINE_ACTIONS = ['Edit', 'Delete'] as const;

type WhiteboardControllerDeps = {
  state: {
    mode: GameMode;
    nicknameInput: string;
    cursorPos: number;
    items: Map<string, WorldItem>;
    whiteboardItemId: string | null;
    whiteboardLineIndex: number;
    whiteboardLineActionIndex: number;
    whiteboardEditingLineIndex: number | null;
  };
  signalingSend: (message: OutgoingMessage) => void;
  updateStatus: (message: string) => void;
  sfxUiBlip: () => void;
  sfxUiCancel: () => void;
  applyTextInputEdit: (code: string, key: string, maxLength: number, ctrlKey?: boolean) => void;
  setReplaceTextOnNextType: (value: boolean) => void;
};

function getLines(item: WorldItem): string[] {
  const raw = item.params['lines'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is string => typeof l === 'string');
}

export function createWhiteboardController(deps: WhiteboardControllerDeps): {
  beginWhiteboardLines: (item: WorldItem) => void;
  handleWhiteboardLinesModeInput: (code: string, key: string) => void;
  handleWhiteboardLineActionsModeInput: (code: string, key: string) => void;
  handleWhiteboardLineEditModeInput: (code: string, key: string, ctrlKey: boolean) => void;
  refreshWhiteboardStatus: () => void;
} {
  function beginWhiteboardLines(item: WorldItem): void {
    deps.state.whiteboardItemId = item.id;
    deps.state.whiteboardLineIndex = 0;
    deps.state.whiteboardLineActionIndex = 0;
    deps.state.whiteboardEditingLineIndex = null;
    deps.state.mode = 'whiteboardLines';

    const lines = getLines(item);
    const n = lines.length;
    const countText = `${n} line${n !== 1 ? 's' : ''}`;
    const firstEntry = n > 0 ? lines[0] : 'Add line';
    deps.updateStatus(`${item.title}. ${countText}. ${firstEntry}.`);
    deps.sfxUiBlip();
  }

  function handleWhiteboardLinesModeInput(code: string, key: string): void {
    const item = deps.state.whiteboardItemId ? deps.state.items.get(deps.state.whiteboardItemId) : null;
    if (!item) {
      deps.state.mode = 'normal';
      deps.state.whiteboardItemId = null;
      return;
    }

    const lines = getLines(item);
    const entries = [...lines, 'Add line'];
    const control = handleListControlKey(code, key, entries, deps.state.whiteboardLineIndex, (e) => e);

    if (control.type === 'move') {
      deps.state.whiteboardLineIndex = control.index;
      deps.updateStatus(entries[control.index]);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'select') {
      if (deps.state.whiteboardLineIndex === lines.length) {
        // "Add line" selected
        deps.state.whiteboardEditingLineIndex = null;
        deps.state.nicknameInput = '';
        deps.state.cursorPos = 0;
        deps.setReplaceTextOnNextType(false);
        deps.state.mode = 'whiteboardLineEdit';
        deps.updateStatus('Add line. Type and press Enter.');
        deps.sfxUiBlip();
      } else {
        // Select a line → actions submenu
        deps.state.whiteboardLineActionIndex = 0;
        deps.state.mode = 'whiteboardLineActions';
        deps.updateStatus(`${lines[deps.state.whiteboardLineIndex]}. Edit or Delete.`);
        deps.sfxUiBlip();
      }
      return;
    }

    if (control.type === 'cancel') {
      deps.state.mode = 'normal';
      deps.state.whiteboardItemId = null;
      deps.updateStatus('Cancelled.');
      deps.sfxUiCancel();
    }
  }

  function handleWhiteboardLineActionsModeInput(code: string, key: string): void {
    const item = deps.state.whiteboardItemId ? deps.state.items.get(deps.state.whiteboardItemId) : null;
    if (!item) {
      deps.state.mode = 'normal';
      deps.state.whiteboardItemId = null;
      return;
    }

    const lines = getLines(item);
    const lineIndex = deps.state.whiteboardLineIndex;

    if (lineIndex >= lines.length) {
      deps.state.whiteboardLineIndex = Math.max(0, lines.length);
      deps.state.mode = 'whiteboardLines';
      const n = lines.length;
      const countText = `${n} line${n !== 1 ? 's' : ''}`;
      const firstEntry = n > 0 ? lines[0] : 'Add line';
      deps.updateStatus(`${item.title}. ${countText}. ${firstEntry}.`);
      deps.sfxUiCancel();
      return;
    }

    const control = handleListControlKey(code, key, LINE_ACTIONS, deps.state.whiteboardLineActionIndex, (e) => e);

    if (control.type === 'move') {
      deps.state.whiteboardLineActionIndex = control.index;
      deps.updateStatus(LINE_ACTIONS[control.index]);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'select') {
      if (deps.state.whiteboardLineActionIndex === 0) {
        // Edit
        deps.state.whiteboardEditingLineIndex = lineIndex;
        deps.state.nicknameInput = lines[lineIndex];
        deps.state.cursorPos = lines[lineIndex].length;
        deps.setReplaceTextOnNextType(true);
        deps.state.mode = 'whiteboardLineEdit';
        deps.updateStatus(`Edit line. ${lines[lineIndex]}`);
        deps.sfxUiBlip();
      } else {
        // Delete
        const newLines = [...lines];
        newLines.splice(lineIndex, 1);
        deps.signalingSend({ type: 'item_update', itemId: item.id, params: { lines: newLines } });
        deps.state.whiteboardLineIndex = Math.min(deps.state.whiteboardLineIndex, newLines.length);
        deps.state.mode = 'whiteboardLines';
        deps.updateStatus('Line deleted.');
        deps.sfxUiBlip();
      }
      return;
    }

    if (control.type === 'cancel') {
      deps.state.mode = 'whiteboardLines';
      deps.updateStatus(lines[lineIndex]);
      deps.sfxUiCancel();
    }
  }

  function handleWhiteboardLineEditModeInput(code: string, key: string, ctrlKey: boolean): void {
    const item = deps.state.whiteboardItemId ? deps.state.items.get(deps.state.whiteboardItemId) : null;
    if (!item) {
      deps.state.mode = 'normal';
      deps.state.whiteboardItemId = null;
      return;
    }

    if (code === 'Enter') {
      const text = deps.state.nicknameInput.trim();
      if (!text) {
        deps.updateStatus('Cannot add empty line.');
        deps.sfxUiCancel();
        return;
      }

      const lines = getLines(item);
      const editIndex = deps.state.whiteboardEditingLineIndex;
      let newLines: string[];
      if (editIndex !== null) {
        newLines = [...lines];
        newLines[editIndex] = text;
      } else {
        newLines = [...lines, text];
      }

      deps.signalingSend({ type: 'item_update', itemId: item.id, params: { lines: newLines } });

      if (editIndex === null) {
        deps.state.whiteboardLineIndex = newLines.length - 1;
      }

      deps.state.nicknameInput = '';
      deps.state.cursorPos = 0;
      deps.setReplaceTextOnNextType(false);
      deps.state.whiteboardEditingLineIndex = null;
      deps.state.mode = 'whiteboardLines';
      deps.updateStatus(editIndex !== null ? 'Line updated.' : 'Line added.');
      deps.sfxUiBlip();
      return;
    }

    if (code === 'Escape') {
      const wasEditing = deps.state.whiteboardEditingLineIndex !== null;
      deps.state.nicknameInput = '';
      deps.state.cursorPos = 0;
      deps.setReplaceTextOnNextType(false);
      deps.state.whiteboardEditingLineIndex = null;

      if (wasEditing) {
        deps.state.mode = 'whiteboardLineActions';
        const lines = getLines(item);
        const line = lines[deps.state.whiteboardLineIndex] ?? '';
        deps.updateStatus(`${line}. Edit or Delete.`);
        deps.sfxUiCancel();
      } else {
        deps.state.mode = 'whiteboardLines';
        deps.updateStatus('Cancelled.');
        deps.sfxUiCancel();
      }
      return;
    }

    deps.applyTextInputEdit(code, key, 200, ctrlKey);
  }

  function refreshWhiteboardStatus(): void {
    const item = deps.state.whiteboardItemId ? deps.state.items.get(deps.state.whiteboardItemId) : null;
    if (!item) return;

    const lines = getLines(item);
    const n = lines.length;

    // Clamp index if lines shrank
    deps.state.whiteboardLineIndex = Math.min(deps.state.whiteboardLineIndex, n);

    if (deps.state.mode === 'whiteboardLines') {
      const entries = [...lines, 'Add line'];
      const current = entries[deps.state.whiteboardLineIndex] ?? 'Add line';
      deps.updateStatus(`Updated. ${current}.`);
    } else if (deps.state.mode === 'whiteboardLineActions') {
      if (deps.state.whiteboardLineIndex < lines.length) {
        deps.updateStatus(`Updated. ${lines[deps.state.whiteboardLineIndex]}. Edit or Delete.`);
      } else {
        deps.state.mode = 'whiteboardLines';
        deps.state.whiteboardLineIndex = Math.max(0, n);
        const countText = `${n} line${n !== 1 ? 's' : ''}`;
        deps.updateStatus(`Updated. ${countText}.`);
      }
    }
  }

  return {
    beginWhiteboardLines,
    handleWhiteboardLinesModeInput,
    handleWhiteboardLineActionsModeInput,
    handleWhiteboardLineEditModeInput,
    refreshWhiteboardStatus,
  };
}
