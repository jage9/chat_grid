// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMobileControls, type MobileTextEntry } from './mobileController';
import type { GameMode } from '../state/gameState';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing test element: ${id}`);
  return found as T;
}

function setupHarness() {
  document.body.innerHTML = `
    <input id="enabled" type="checkbox">
    <section id="container" class="hidden">
      <button id="toggle" type="button"></button>
      <div id="body">
        <form id="textForm" class="hidden">
          <label id="textLabel" for="textInput"></label>
          <input id="textInput" type="text">
          <button id="textSubmit" type="submit"></button>
          <button id="textCancel" type="button"></button>
        </form>
        <button id="up" type="button"></button>
        <button id="down" type="button"></button>
        <button id="left" type="button"></button>
        <button id="right" type="button"></button>
        <button id="use" type="button"></button>
        <button id="back" type="button"></button>
        <button id="chat" type="button"></button>
        <button id="commands" type="button"></button>
        <button id="mute" type="button"></button>
        <dialog id="commandDialog">
          <button id="commandClose" type="button"></button>
          <div id="commandList"></div>
        </dialog>
      </div>
    </section>
  `;

  let mode: GameMode = 'normal';
  let muted = false;
  let textValue = '';
  const dispatched: string[] = [];
  const savedEnabled: boolean[] = [];
  const savedExpanded: boolean[] = [];
  const commandDialog = element<HTMLDialogElement>('commandDialog');
  commandDialog.showModal = () => commandDialog.setAttribute('open', '');
  commandDialog.close = () => commandDialog.removeAttribute('open');

  const controller = setupMobileControls({
    dom: {
      container: element('container'),
      body: element('body'),
      toggle: element('toggle'),
      enabled: element('enabled'),
      up: element('up'),
      down: element('down'),
      left: element('left'),
      right: element('right'),
      use: element('use'),
      back: element('back'),
      chat: element('chat'),
      commands: element('commands'),
      mute: element('mute'),
      commandDialog,
      commandList: element('commandList'),
      commandClose: element('commandClose'),
      textForm: element('textForm'),
      textLabel: element('textLabel'),
      textInput: element('textInput'),
      textSubmit: element('textSubmit'),
      textCancel: element('textCancel'),
    },
    getRunning: () => true,
    getMode: () => mode,
    getMuted: () => muted,
    getCommands: () =>
      mode === 'normal'
        ? [
            {
              id: 'test-command',
              label: 'Test command',
              section: 'Testing',
              tooltip: 'Run the test command.',
              run: () => dispatched.push('run:test-command'),
            },
          ]
        : [],
    dispatchInput: (input) => {
      dispatched.push(input.code);
      if (mode === 'chat' && (input.code === 'Enter' || input.code === 'Escape')) mode = 'normal';
    },
    pressDirection: (code) => dispatched.push(`press:${code}`),
    releaseDirection: (code) => dispatched.push(`release:${code}`),
    openChat: () => {
      mode = 'chat';
    },
    toggleMute: () => {
      muted = !muted;
    },
    getTextEntry: (): MobileTextEntry | null =>
      mode === 'chat'
        ? { label: 'Chat message', value: textValue, maxLength: 500, inputMode: 'text', submitLabel: 'Send' }
        : null,
    setTextEntry: (value) => {
      textValue = value;
    },
    loadEnabled: () => true,
    saveEnabled: (value) => savedEnabled.push(value),
    loadExpanded: () => true,
    saveExpanded: (value) => savedExpanded.push(value),
  });

  return {
    controller,
    dispatched,
    savedEnabled,
    savedExpanded,
    getMode: () => mode,
    setMode: (value: GameMode) => {
      mode = value;
    },
    getTextValue: () => textValue,
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true }) as MediaQueryList),
  });
});

describe('mobile controls', () => {
  it('opens native chat entry and submits through the shared mode dispatcher', () => {
    const harness = setupHarness();

    element<HTMLButtonElement>('chat').click();
    expect(harness.getMode()).toBe('chat');
    expect(element('textForm').classList.contains('hidden')).toBe(false);
    expect(element<HTMLLabelElement>('textLabel').textContent).toBe('Chat message');
    expect(element<HTMLButtonElement>('textSubmit').textContent).toBe('Send');

    const input = element<HTMLInputElement>('textInput');
    input.value = 'hello mobile';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(harness.getTextValue()).toBe('hello mobile');

    element<HTMLFormElement>('textForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(harness.dispatched).toContain('Enter');
    expect(harness.getMode()).toBe('normal');
    expect(element('textForm').classList.contains('hidden')).toBe(true);
  });

  it('routes directional menu input and keeps command states contextual', () => {
    const harness = setupHarness();
    harness.setMode('commandPalette');
    harness.controller.sync();

    element<HTMLButtonElement>('up').click();
    expect(harness.dispatched).toContain('ArrowUp');
    expect(element<HTMLButtonElement>('up').getAttribute('aria-label')).toBe('Move up');
    expect(element<HTMLButtonElement>('use').textContent).toBe('Select');
    expect(element<HTMLButtonElement>('commands').disabled).toBe(true);
  });

  it('holds and releases the shared movement key state for pointer input', () => {
    const harness = setupHarness();
    const up = element<HTMLButtonElement>('up');
    up.setPointerCapture = vi.fn();
    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    const pointerUp = new Event('pointerup', { bubbles: true });
    Object.defineProperty(pointerDown, 'pointerId', { value: 7 });
    Object.defineProperty(pointerUp, 'pointerId', { value: 7 });

    up.dispatchEvent(pointerDown);
    expect(harness.dispatched).toEqual(['press:ArrowUp']);
    up.dispatchEvent(pointerUp);
    expect(harness.dispatched).toEqual(['press:ArrowUp', 'release:ArrowUp']);
  });

  it('opens available commands as a visual list and runs a selected command', () => {
    const harness = setupHarness();

    element<HTMLButtonElement>('commands').click();
    expect(element<HTMLDialogElement>('commandDialog').open).toBe(true);
    expect(element('commandList').textContent).toContain('Testing');
    expect(element('commandList').textContent).toContain('Test command');

    element('commandList').querySelector<HTMLButtonElement>('button')?.click();
    expect(element<HTMLDialogElement>('commandDialog').open).toBe(false);
    expect(harness.dispatched).toContain('run:test-command');
  });

  it('persists dock visibility and expansion choices', () => {
    const harness = setupHarness();
    const enabled = element<HTMLInputElement>('enabled');

    enabled.checked = false;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
    expect(harness.savedEnabled).toEqual([false]);
    expect(element('container').classList.contains('hidden')).toBe(true);

    element<HTMLButtonElement>('toggle').click();
    expect(harness.savedExpanded).toEqual([false]);
    expect(element<HTMLButtonElement>('toggle').getAttribute('aria-expanded')).toBe('false');
  });
});
