/**
 * UI elements used by binder setup.
 */
type UiDom = {
  connectButton: HTMLButtonElement;
  disconnectButton: HTMLButtonElement;
  focusGridButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  closeSettingsButton: HTMLButtonElement;
  audioInputSelect: HTMLSelectElement;
  audioOutputSelect: HTMLSelectElement;
  settingsModal: HTMLDivElement;
  canvas: HTMLCanvasElement;
};

/**
 * Dependency contract for binding DOM event handlers.
 */
type UiBindingsDeps = {
  dom: UiDom;
  updateConnectAvailability: () => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  updateStatus: (message: string) => void;
  sfxUiBlip: () => void;
  setupLocalMedia: (audioDeviceId: string) => Promise<void>;
  setPreferredInput: (id: string, name: string) => void;
  setPreferredOutput: (id: string, name: string) => void;
  updateDeviceSummary: () => void;
  setOutputDevice: (id: string) => Promise<void>;
  persistOnUnload: () => void;
};

/**
 * Attaches UI listeners (connect/settings/device changes) and focus traps.
 */
export function setupUiHandlers(deps: UiBindingsDeps): void {
  window.addEventListener('pagehide', deps.persistOnUnload);
  window.addEventListener('beforeunload', deps.persistOnUnload);

  deps.dom.connectButton.addEventListener('click', () => {
    void deps.connect();
  });

  deps.dom.disconnectButton.addEventListener('click', () => {
    deps.disconnect();
  });

  deps.dom.focusGridButton.addEventListener('click', () => {
    deps.dom.canvas.focus();
    deps.updateStatus('Chat Grid focused.');
    deps.sfxUiBlip();
  });

  deps.dom.settingsButton.addEventListener('click', () => {
    deps.openSettings();
  });

  deps.dom.closeSettingsButton.addEventListener('click', () => {
    deps.closeSettings();
  });

  deps.dom.audioInputSelect.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    if (!target.value) return;
    deps.setPreferredInput(target.value, target.selectedOptions[0]?.text || '');
    deps.updateDeviceSummary();
    void deps.setupLocalMedia(target.value);
  });

  deps.dom.audioOutputSelect.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    deps.setPreferredOutput(target.value, target.selectedOptions[0]?.text || '');
    deps.updateDeviceSummary();
    void deps.setOutputDevice(target.value);
  });

  deps.dom.settingsModal.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(deps.dom.settingsModal.querySelectorAll<HTMLElement>('select, button'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      last.focus();
      event.preventDefault();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
  });
}
