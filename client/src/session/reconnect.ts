type ReconnectOptions = {
  signal: AbortSignal;
  connect: () => Promise<boolean>;
  onRetry: (attempt: number) => void;
};

/** Wait between attempts, ending promptly when the user cancels reconnect. */
function waitForRetry(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      document.removeEventListener('visibilitychange', retryWhenVisible);
      resolve(!signal.aborted);
    };
    const retryWhenVisible = () => {
      if (document.visibilityState === 'visible') finish();
    };
    const timer = window.setTimeout(finish, 5_000);
    document.addEventListener('visibilitychange', retryWhenVisible);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Try at most three complete connections, with five seconds before each attempt. */
export async function runReconnectAttempts(options: ReconnectOptions): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!await waitForRetry(options.signal)) return false;
    const connected = await options.connect();
    if (options.signal.aborted) return false;
    if (connected) return true;
    if (attempt < 3) options.onRetry(attempt);
  }
  return false;
}
