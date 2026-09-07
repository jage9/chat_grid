// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalingClient } from './signalingClient';

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly url: string;
  readyState = TestWebSocket.CONNECTING;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    TestWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closeCalls += 1;
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.(new Event('close') as CloseEvent);
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }

  closeFromPeer(): void {
    this.readyState = TestWebSocket.CLOSED;
    this.onclose?.(new Event('close') as CloseEvent);
  }
}

describe('SignalingClient socket lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestWebSocket.instances = [];
    vi.stubGlobal('WebSocket', TestWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves on open and preserves connected status', async () => {
    const status = vi.fn();
    const client = new SignalingClient('ws://grid.test/ws', status);
    const pending = client.connect(vi.fn());
    const socket = TestWebSocket.instances[0];

    socket.open();

    await expect(pending).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith('Connected.');
  });

  it('settles a pending connection when explicitly disconnected', async () => {
    const onDisconnected = vi.fn();
    const client = new SignalingClient('ws://grid.test/ws', vi.fn());
    const pending = client.connect(vi.fn(), onDisconnected);
    const socket = TestWebSocket.instances[0];

    client.disconnect();

    await expect(pending).rejects.toThrow('Disconnected');
    expect(socket.closeCalls).toBe(1);
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('rejects and notifies on an unexpected socket error', async () => {
    const statusMessages: string[] = [];
    const onDisconnected = vi.fn();
    const client = new SignalingClient(
      'ws://grid.test/ws',
      (message) => statusMessages.push(message),
    );
    const pending = client.connect(vi.fn(), onDisconnected);
    const socket = TestWebSocket.instances[0];

    socket.fail();

    await expect(pending).rejects.toThrow('WebSocket error');
    expect(socket.closeCalls).toBe(1);
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(statusMessages).toEqual(['Disconnected.']);
  });

  it('settles and notifies when the socket closes before opening', async () => {
    const statusMessages: string[] = [];
    const onDisconnected = vi.fn();
    const client = new SignalingClient(
      'ws://grid.test/ws',
      (message) => statusMessages.push(message),
    );
    const pending = client.connect(vi.fn(), onDisconnected);
    const socket = TestWebSocket.instances[0];

    socket.closeFromPeer();

    await expect(pending).rejects.toThrow('WebSocket closed');
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(statusMessages).toEqual(['Disconnected.']);
  });

  it('notifies once on an unexpected close after opening', async () => {
    const events: string[] = [];
    const client = new SignalingClient(
      'ws://grid.test/ws',
      (message) => events.push(`status:${message}`),
    );
    const onDisconnected = vi.fn(() => events.push('disconnected'));
    const pending = client.connect(vi.fn(), onDisconnected);
    const socket = TestWebSocket.instances[0];
    socket.open();
    await pending;

    socket.closeFromPeer();
    socket.fail();

    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(events).toEqual(['status:Connected.', 'disconnected', 'status:Disconnected.']);
  });

  it('ignores stale callbacks and timers after a replacement socket opens', async () => {
    const statusMessages: string[] = [];
    const onDisconnected = vi.fn();
    const client = new SignalingClient(
      'ws://grid.test/ws',
      (message) => statusMessages.push(message),
    );
    const firstPending = client.connect(vi.fn(), onDisconnected);
    const firstSocket = TestWebSocket.instances[0];
    const staleClose = firstSocket.onclose;
    const staleError = firstSocket.onerror;

    client.disconnect();
    await expect(firstPending).rejects.toThrow('Disconnected');

    const secondPending = client.connect(vi.fn(), onDisconnected);
    const secondSocket = TestWebSocket.instances[1];
    secondSocket.open();
    await secondPending;
    staleClose?.(new Event('close') as CloseEvent);
    staleError?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onDisconnected).not.toHaveBeenCalled();
    expect(statusMessages).toEqual(['Connected.']);
    expect(secondSocket.closeCalls).toBe(0);
  });

  it('times out and closes only the active socket', async () => {
    const statusMessages: string[] = [];
    const client = new SignalingClient(
      'ws://grid.test/ws',
      (message) => statusMessages.push(message),
    );
    const pending = client.connect(vi.fn());
    const socket = TestWebSocket.instances[0];
    const rejection = expect(pending).rejects.toThrow('Connection timed out');

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(socket.closeCalls).toBe(1);
    expect(statusMessages).toEqual(['Connection timed out.']);
  });

  it('keeps a replacement socket timer after a stale close callback', async () => {
    const client = new SignalingClient('ws://grid.test/ws', vi.fn());
    const firstPending = client.connect(vi.fn());
    const firstSocket = TestWebSocket.instances[0];
    const staleClose = firstSocket.onclose;

    client.disconnect();
    await expect(firstPending).rejects.toThrow('Disconnected');

    const secondPending = client.connect(vi.fn());
    const secondSocket = TestWebSocket.instances[1];
    staleClose?.(new Event('close') as CloseEvent);
    const rejection = expect(secondPending).rejects.toThrow('Connection timed out');

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(secondSocket.closeCalls).toBe(1);
  });
});
