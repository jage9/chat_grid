// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../state/gameState';
import { runConnectFlow, type ConnectFlowDeps } from './connectionFlow';

type SignalingMessageHandler = Parameters<ConnectFlowDeps['signalingConnect']>[0];
type SignalingDisconnectHandler = Parameters<ConnectFlowDeps['signalingConnect']>[1];
type AppMessageHandler = ConnectFlowDeps['onMessage'];

type SocketAttempt = {
  onMessage: SignalingMessageHandler;
  onDisconnected: SignalingDisconnectHandler;
};

type HarnessOptions = {
  mediaIsConnecting?: () => boolean;
  onMessage?: AppMessageHandler;
  holdSignalingConnect?: boolean;
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing test element: ${id}`);
  return found as T;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setupHarness(options: HarnessOptions = {}) {
  document.body.innerHTML = `
    <button id="connectButton" type="button"></button>
    <button id="disconnectButton" type="button"></button>
    <button id="focusGridButton" type="button"></button>
    <canvas id="canvas"></canvas>
    <div id="instructions"></div>
    <select id="audioInputSelect"></select>
  `;

  const state = createInitialState();
  state.player.nickname = '  Player  ';
  let mediaConnecting = false;
  const attempts: SocketAttempt[] = [];
  const resolveSignalingConnect: Array<() => void> = [];
  const statusMessages: string[] = [];

  const signalingConnect = vi.fn(
    (onMessage: SignalingMessageHandler, onDisconnected: SignalingDisconnectHandler): Promise<void> => {
      attempts.push({ onMessage, onDisconnected });
      if (options.holdSignalingConnect) {
        return new Promise<void>((resolve) => resolveSignalingConnect.push(resolve));
      }
      return Promise.resolve();
    },
  );
  const signalingDisconnect = vi.fn();
  const signalingSendAuth = vi.fn();
  const mediaStopLocalMedia = vi.fn();
  const mediaIsConnecting = options.mediaIsConnecting ?? (() => mediaConnecting);
  const mediaSetConnecting = vi.fn((value: boolean) => {
    mediaConnecting = value;
  });
  const updateConnectAvailability = vi.fn();
  const defaultOnMessage: AppMessageHandler = async (_message, onWelcome) => {
    onWelcome();
  };

  const deps: ConnectFlowDeps = {
    state,
    dom: {
      connectButton: element<HTMLButtonElement>('connectButton'),
      disconnectButton: element<HTMLButtonElement>('disconnectButton'),
      focusGridButton: element<HTMLButtonElement>('focusGridButton'),
      canvas: element<HTMLCanvasElement>('canvas'),
      instructions: element<HTMLDivElement>('instructions'),
      audioInputSelect: element<HTMLSelectElement>('audioInputSelect'),
    },
    sanitizeName: (value) => value.trim(),
    updateStatus: (message) => statusMessages.push(message),
    updateConnectAvailability,
    mediaIsConnecting,
    mediaSetConnecting,
    mediaStopLocalMedia,
    signalingConnect,
    signalingSendAuth,
    signalingDisconnect,
    onMessage: options.onMessage ?? defaultOnMessage,
    peerManagerCleanupAll: vi.fn(),
    radioCleanupAll: vi.fn(),
    emitCleanupAll: vi.fn(),
    playLogoutSound: vi.fn(),
  };

  return {
    deps,
    state,
    attempts,
    resolveSignalingConnect,
    statusMessages,
    signalingConnect,
    signalingDisconnect,
    signalingSendAuth,
    mediaStopLocalMedia,
    mediaSetConnecting,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('runConnectFlow', () => {
  it('accepts a welcome arriving after four seconds through the welcome callback', async () => {
    const harness = setupHarness();
    const controller = new AbortController();
    const result = runConnectFlow(harness.deps, controller.signal);

    await flushMicrotasks();
    expect(harness.signalingSendAuth).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(4_001);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    await harness.attempts[0].onMessage({ type: 'welcome' });
    await expect(result).resolves.toBe(true);
    expect(harness.signalingDisconnect).not.toHaveBeenCalled();
  });

  it('times out at eight seconds even when media is no longer marked connecting', async () => {
    const harness = setupHarness({ mediaIsConnecting: () => false });
    const controller = new AbortController();
    const result = runConnectFlow(harness.deps, controller.signal);

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(7_999);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(harness.statusMessages).toContain('Connect failed. Timed out waiting for server welcome.');
    expect(harness.signalingDisconnect).toHaveBeenCalledOnce();
    expect(harness.mediaStopLocalMedia).toHaveBeenCalledOnce();
  });

  it('settles cancellation and prevents late completion from an old attempt affecting the next one', async () => {
    const firstHarness = setupHarness({ holdSignalingConnect: true });
    const firstController = new AbortController();
    const firstResult = runConnectFlow(firstHarness.deps, firstController.signal);
    await flushMicrotasks();

    firstController.abort();
    await expect(firstResult).resolves.toBe(false);
    expect(firstHarness.signalingDisconnect).toHaveBeenCalledOnce();

    const secondController = new AbortController();
    const secondResult = runConnectFlow(firstHarness.deps, secondController.signal);
    await flushMicrotasks();
    expect(firstHarness.attempts).toHaveLength(2);

    firstHarness.resolveSignalingConnect[1]();
    await flushMicrotasks();
    expect(firstHarness.signalingSendAuth).toHaveBeenCalledOnce();
    const timerCountAfterSecondStarts = vi.getTimerCount();

    firstHarness.resolveSignalingConnect[0]();
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(timerCountAfterSecondStarts);
    expect(firstHarness.signalingSendAuth).toHaveBeenCalledOnce();

    await firstHarness.attempts[1].onMessage({ type: 'welcome' });
    await expect(secondResult).resolves.toBe(true);
  });

  it('clears a cancelled welcome timer and ignores its late messages during a new attempt', async () => {
    const harness = setupHarness();
    const firstController = new AbortController();
    const firstResult = runConnectFlow(harness.deps, firstController.signal);
    await vi.advanceTimersByTimeAsync(4_000);
    firstController.abort();
    await expect(firstResult).resolves.toBe(false);

    const secondController = new AbortController();
    const secondResult = runConnectFlow(harness.deps, secondController.signal);
    await flushMicrotasks();
    await harness.attempts[0].onMessage({ type: 'welcome' });
    await vi.advanceTimersByTimeAsync(4_001);
    expect(harness.signalingDisconnect).toHaveBeenCalledOnce();
    expect(harness.statusMessages).toEqual([]);

    await harness.attempts[1].onMessage({ type: 'welcome' });
    await expect(secondResult).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(harness.signalingDisconnect).toHaveBeenCalledOnce();
  });

  it('fails promptly when the signaling socket disconnects before welcome', async () => {
    const harness = setupHarness();
    const controller = new AbortController();
    const result = runConnectFlow(harness.deps, controller.signal);
    await flushMicrotasks();

    harness.attempts[0].onDisconnected();

    await expect(result).resolves.toBe(false);
    expect(harness.statusMessages).toContain('Connect failed. Disconnected before server welcome.');
    expect(harness.signalingDisconnect).toHaveBeenCalledOnce();
    expect(harness.mediaStopLocalMedia).toHaveBeenCalledOnce();
  });

  it('accepts welcome before a pending message handler finishes media setup', async () => {
    let releaseMessage!: () => void;
    const pendingMessage = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    const harness = setupHarness({
      onMessage: async (_message, onWelcome) => {
        onWelcome();
        await pendingMessage;
      },
    });
    const controller = new AbortController();
    const result = runConnectFlow(harness.deps, controller.signal);
    await flushMicrotasks();

    const messageResult = harness.attempts[0].onMessage({ type: 'welcome' });
    await expect(result).resolves.toBe(true);

    releaseMessage();
    await messageResult;
  });
});
