// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReconnectAttempts } from './reconnect';

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runReconnectAttempts', () => {
  it('waits five seconds before each of exactly three attempts', async () => {
    const controller = new AbortController();
    const connect = vi.fn(async () => false);
    const onRetry = vi.fn();
    const result = runReconnectAttempts({ signal: controller.signal, connect, onRetry });

    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(connect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(3);
    await expect(result).resolves.toBe(false);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops immediately after a successful attempt', async () => {
    const controller = new AbortController();
    const connect = vi.fn(async () => true);
    const onRetry = vi.fn();
    const result = runReconnectAttempts({ signal: controller.signal, connect, onRetry });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe(true);
    expect(connect).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('aborts during the initial delay without an attempt or retry message', async () => {
    const controller = new AbortController();
    const connect = vi.fn(async () => false);
    const onRetry = vi.fn();
    const result = runReconnectAttempts({ signal: controller.signal, connect, onRetry });

    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();

    await expect(result).resolves.toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(connect).not.toHaveBeenCalled();
  });

  it('aborts during an in-flight attempt without starting another attempt or announcing a retry', async () => {
    const controller = new AbortController();
    let resolveConnect!: (connected: boolean) => void;
    const connect = vi.fn(
      () => new Promise<boolean>((resolve) => {
        resolveConnect = resolve;
      }),
    );
    const onRetry = vi.fn();
    const result = runReconnectAttempts({ signal: controller.signal, connect, onRetry });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledOnce();

    controller.abort();
    resolveConnect(false);
    await flushMicrotasks();
    await expect(result).resolves.toBe(false);
    expect(connect).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
