import { incomingMessageSchema, type IncomingMessage, type OutgoingMessage } from './protocol';

type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
type StatusHandler = (message: string) => void;
type DisconnectHandler = () => void;

type PendingConnection = {
  socket: WebSocket;
  promise: Promise<void>;
  reject: (reason?: unknown) => void;
};

export class SignalingClient {
  private ws: WebSocket | null = null;
  private socketGeneration = 0;
  private activeSocketCleanup: (() => void) | null = null;
  private pendingConnect: PendingConnection | null = null;

  constructor(private readonly url: string, private readonly status: StatusHandler) {}

  async connect(onMessage: MessageHandler, onDisconnected?: DisconnectHandler): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.pendingConnect && this.ws === this.pendingConnect.socket) {
      return this.pendingConnect.promise;
    }

    this.activeSocketCleanup?.();

    const socket = new WebSocket(this.url);
    const generation = ++this.socketGeneration;
    this.ws = socket;
    let timeoutId: number | null = null;
    let opened = false;
    let settled = false;
    let unexpectedDisconnectNotified = false;
    let disconnectedStatusNotified = false;

    const isCurrentSocket = (): boolean => (
      this.ws === socket && this.socketGeneration === generation
    );

    const clearSocketTimeout = (): void => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    let cleanupSocket: (closeSocket?: boolean) => void;
    cleanupSocket = (closeSocket = true): void => {
      clearSocketTimeout();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (this.ws === socket && this.socketGeneration === generation) {
        this.ws = null;
      }
      if (this.activeSocketCleanup === cleanupSocket) {
        this.activeSocketCleanup = null;
      }
      if (closeSocket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }
    };

    this.activeSocketCleanup = cleanupSocket;

    let resolveConnect!: () => void;
    let rejectConnect!: (reason?: unknown) => void;
    const connectionPromise = new Promise<void>((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    this.pendingConnect = {
      socket,
      promise: connectionPromise,
      reject: rejectConnect,
    };

    const settleConnect = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (this.pendingConnect?.socket === socket) {
        this.pendingConnect = null;
      }
      if (error) {
        rejectConnect(error);
      } else {
        resolveConnect();
      }
    };

    const notifyUnexpectedDisconnect = (): void => {
      if (unexpectedDisconnectNotified) return;
      unexpectedDisconnectNotified = true;
      onDisconnected?.();
    };

    const notifyDisconnectedStatus = (): void => {
      if (disconnectedStatusNotified) return;
      disconnectedStatusNotified = true;
      this.status('Disconnected.');
    };

    const failUnexpectedly = (error: Error): void => {
      if (!isCurrentSocket()) {
        cleanupSocket(true);
        return;
      }
      settleConnect(error);
      cleanupSocket(true);
      notifyUnexpectedDisconnect();
      if (this.socketGeneration === generation) {
        notifyDisconnectedStatus();
      }
    };

    timeoutId = window.setTimeout(() => {
      if (!isCurrentSocket() || opened) return;
      settleConnect(new Error('Connection timed out'));
      cleanupSocket(true);
      this.status('Connection timed out.');
    }, 10_000);

    socket.onopen = () => {
      if (!isCurrentSocket()) {
        cleanupSocket(true);
        return;
      }
      opened = true;
      clearSocketTimeout();
      this.status('Connected.');
      settleConnect();
    };

    socket.onerror = () => {
      failUnexpectedly(new Error('WebSocket error'));
    };

    socket.onmessage = async (event) => {
      if (!isCurrentSocket()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const validated = incomingMessageSchema.safeParse(parsed);
      if (!validated.success || !isCurrentSocket()) return;
      await onMessage(validated.data);
    };

    socket.onclose = () => {
      if (!isCurrentSocket()) {
        cleanupSocket(true);
        return;
      }
      settleConnect(new Error('WebSocket closed'));
      cleanupSocket(false);
      notifyUnexpectedDisconnect();
      if (this.socketGeneration === generation) {
        notifyDisconnectedStatus();
      }
    };

    return connectionPromise;
  }

  send(payload: OutgoingMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  disconnect(): void {
    const pending = this.pendingConnect;
    if (pending) {
      this.pendingConnect = null;
      pending.reject(new Error('Disconnected'));
    }
    this.activeSocketCleanup?.();
    this.activeSocketCleanup = null;
    this.ws = null;
  }
}
