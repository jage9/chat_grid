import type { ModeInput } from './commandTypes';
import type { GameMode } from '../state/gameState';

type DirectionCode = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export type MobileTextEntry = {
  label: string;
  value: string;
  maxLength: number;
  inputMode: 'text' | 'decimal';
  submitLabel: string;
};

export type MobileCommand = {
  id: string;
  label: string;
  section: string;
  tooltip: string;
  run: () => void | Promise<void>;
};

type MobileControllerDeps = {
  dom: {
    container: HTMLElement;
    body: HTMLElement;
    toggle: HTMLButtonElement;
    enabled: HTMLInputElement;
    up: HTMLButtonElement;
    down: HTMLButtonElement;
    left: HTMLButtonElement;
    right: HTMLButtonElement;
    use: HTMLButtonElement;
    back: HTMLButtonElement;
    chat: HTMLButtonElement;
    commands: HTMLButtonElement;
    mute: HTMLButtonElement;
    commandDialog: HTMLDialogElement;
    commandList: HTMLElement;
    commandClose: HTMLButtonElement;
    textForm: HTMLFormElement;
    textLabel: HTMLLabelElement;
    textInput: HTMLInputElement;
    textSubmit: HTMLButtonElement;
    textCancel: HTMLButtonElement;
  };
  getRunning: () => boolean;
  getMode: () => GameMode;
  getMuted: () => boolean;
  getCommands: () => MobileCommand[];
  dispatchInput: (input: ModeInput) => void;
  pressDirection: (code: DirectionCode) => void;
  releaseDirection: (code: DirectionCode) => void;
  openChat: () => void;
  toggleMute: () => void;
  getTextEntry: () => MobileTextEntry | null;
  setTextEntry: (value: string, cursor: number) => void;
  loadEnabled: () => boolean | null;
  saveEnabled: (value: boolean) => void;
  loadExpanded: () => boolean;
  saveExpanded: (value: boolean) => void;
};

export type MobileController = {
  sync: () => void;
  releaseAllDirections: () => void;
};

const inputFor = (code: string, key = code): ModeInput => ({
  code,
  key,
  ctrlKey: false,
  shiftKey: false,
});

/** Wires the accessible touch dock to the same mode actions used by keyboard input. */
export function setupMobileControls(deps: MobileControllerDeps): MobileController {
  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  let enabled = deps.loadEnabled() ?? coarsePointer;
  let expanded = deps.loadExpanded();
  let renderedTextMode: GameMode | null = null;
  let renderedSnapshot = '';
  const activeDirections = new Map<number, DirectionCode>();

  const directionButtons: Array<[HTMLButtonElement, DirectionCode]> = [
    [deps.dom.up, 'ArrowUp'],
    [deps.dom.down, 'ArrowDown'],
    [deps.dom.left, 'ArrowLeft'],
    [deps.dom.right, 'ArrowRight'],
  ];

  function releaseDirection(pointerId: number): void {
    const code = activeDirections.get(pointerId);
    if (!code) return;
    activeDirections.delete(pointerId);
    deps.releaseDirection(code);
  }

  function releaseAllDirections(): void {
    for (const code of activeDirections.values()) {
      deps.releaseDirection(code);
    }
    activeDirections.clear();
  }

  function closeCommandDialog(): void {
    if (deps.dom.commandDialog.open) deps.dom.commandDialog.close();
  }

  function openCommandDialog(): void {
    const commands = deps.getCommands();
    if (commands.length === 0) return;
    deps.dom.commandList.replaceChildren();
    const sections = new Map<string, MobileCommand[]>();
    for (const command of commands) {
      const sectionCommands = sections.get(command.section) ?? [];
      sectionCommands.push(command);
      sections.set(command.section, sectionCommands);
    }
    for (const [section, sectionCommands] of sections) {
      const heading = document.createElement('h3');
      heading.textContent = section;
      deps.dom.commandList.appendChild(heading);
      for (const command of sectionCommands) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = command.label;
        button.title = command.tooltip;
        button.dataset['commandId'] = command.id;
        button.addEventListener('click', () => {
          closeCommandDialog();
          void command.run();
          sync();
        });
        deps.dom.commandList.appendChild(button);
      }
    }
    deps.dom.commandDialog.showModal();
    deps.dom.commandList.querySelector<HTMLButtonElement>('button')?.focus();
  }

  function syncTextEntry(config: MobileTextEntry | null): boolean {
    deps.dom.textForm.classList.toggle('hidden', config === null);
    if (!config) {
      renderedTextMode = null;
      return false;
    }

    const mode = deps.getMode();
    deps.dom.textLabel.textContent = config.label;
    deps.dom.textInput.maxLength = config.maxLength;
    deps.dom.textInput.inputMode = config.inputMode;
    deps.dom.textInput.enterKeyHint = config.submitLabel === 'Send' ? 'send' : 'done';
    deps.dom.textSubmit.textContent = config.submitLabel;
    if (renderedTextMode !== mode) {
      renderedTextMode = mode;
      deps.dom.textInput.value = config.value;
      requestAnimationFrame(() => {
        deps.dom.textInput.focus({ preventScroll: true });
        deps.dom.textInput.setSelectionRange(config.value.length, config.value.length);
      });
    } else if (document.activeElement !== deps.dom.textInput && deps.dom.textInput.value !== config.value) {
      deps.dom.textInput.value = config.value;
    }
    return true;
  }

  function sync(): void {
    const running = deps.getRunning();
    const mode = deps.getMode();
    const muted = deps.getMuted();
    const textEntry = deps.getTextEntry();
    const snapshot = JSON.stringify({
      running,
      enabled,
      expanded,
      mode,
      muted,
      textValue: textEntry?.value ?? null,
      textLabel: textEntry?.label ?? null,
    });
    if (snapshot === renderedSnapshot) return;
    renderedSnapshot = snapshot;
    deps.dom.enabled.checked = enabled;
    deps.dom.container.classList.toggle('hidden', !running || !enabled);
    deps.dom.container.dataset['expanded'] = String(expanded);
    deps.dom.body.hidden = !expanded;
    deps.dom.toggle.setAttribute('aria-expanded', String(expanded));
    deps.dom.toggle.textContent = expanded ? 'Hide controls' : 'Show controls';

    if (!running || !enabled) {
      releaseAllDirections();
      closeCommandDialog();
      return;
    }

    const editingText = syncTextEntry(textEntry);
    const inNormalMode = mode === 'normal';
    if (!inNormalMode) releaseAllDirections();
    for (const [button] of directionButtons) {
      button.disabled = editingText;
    }
    deps.dom.up.setAttribute('aria-label', 'Up');
    deps.dom.down.setAttribute('aria-label', 'Down');
    deps.dom.left.setAttribute('aria-label', 'Left');
    deps.dom.right.setAttribute('aria-label', 'Right');
    deps.dom.use.textContent = inNormalMode ? 'Use' : 'Select';
    deps.dom.use.disabled = editingText;
    deps.dom.back.disabled = inNormalMode || editingText;
    deps.dom.chat.disabled = !inNormalMode;
    deps.dom.commands.disabled = deps.getCommands().length === 0 || editingText;
    deps.dom.mute.textContent = muted ? 'Unmute' : 'Mute';
    deps.dom.mute.setAttribute('aria-pressed', String(muted));
  }

  deps.dom.enabled.addEventListener('change', () => {
    enabled = deps.dom.enabled.checked;
    deps.saveEnabled(enabled);
    sync();
  });

  deps.dom.toggle.addEventListener('click', () => {
    expanded = !expanded;
    deps.saveExpanded(expanded);
    sync();
  });

  for (const [button, code] of directionButtons) {
    button.addEventListener('pointerdown', (event) => {
      if (!deps.getRunning() || deps.getMode() !== 'normal' || button.disabled) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      activeDirections.set(event.pointerId, code);
      deps.pressDirection(code);
    });
    button.addEventListener('pointerup', (event) => releaseDirection(event.pointerId));
    button.addEventListener('pointercancel', (event) => releaseDirection(event.pointerId));
    button.addEventListener('lostpointercapture', (event) => releaseDirection(event.pointerId));
    button.addEventListener('click', (event) => {
      if (!deps.getRunning() || button.disabled) return;
      if (deps.getMode() === 'normal') {
        if (event.detail === 0) {
          deps.pressDirection(code);
          requestAnimationFrame(() => deps.releaseDirection(code));
        }
        return;
      }
      deps.dispatchInput(inputFor(code));
      sync();
    });
  }

  deps.dom.use.addEventListener('click', () => {
    if (!deps.getRunning()) return;
    deps.dispatchInput(inputFor('Enter'));
    sync();
  });
  deps.dom.back.addEventListener('click', () => {
    if (!deps.getRunning()) return;
    deps.dispatchInput(inputFor('Escape'));
    sync();
  });
  deps.dom.chat.addEventListener('click', () => {
    if (!deps.getRunning()) return;
    deps.openChat();
    sync();
  });
  deps.dom.commands.addEventListener('click', () => {
    if (!deps.getRunning()) return;
    openCommandDialog();
  });
  deps.dom.mute.addEventListener('click', () => {
    if (!deps.getRunning()) return;
    deps.toggleMute();
    sync();
  });

  function commitTextValue(): void {
    deps.setTextEntry(deps.dom.textInput.value, deps.dom.textInput.selectionStart ?? deps.dom.textInput.value.length);
  }

  deps.dom.textInput.addEventListener('input', commitTextValue);
  deps.dom.textInput.addEventListener('select', commitTextValue);
  deps.dom.textForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!deps.getRunning()) return;
    commitTextValue();
    deps.dispatchInput(inputFor('Enter'));
    sync();
  });
  deps.dom.textCancel.addEventListener('click', () => {
    if (!deps.getRunning()) return;
    deps.dispatchInput(inputFor('Escape'));
    sync();
  });
  deps.dom.commandClose.addEventListener('click', () => {
    closeCommandDialog();
    deps.dom.commands.focus();
  });
  deps.dom.commandDialog.addEventListener('cancel', () => {
    requestAnimationFrame(() => deps.dom.commands.focus());
  });

  window.addEventListener('blur', releaseAllDirections);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAllDirections();
  });

  sync();
  return { sync, releaseAllDirections };
}
