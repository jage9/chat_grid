import { incomingMessageSchema, type IncomingMessage, type OutgoingMessage } from './protocol';

type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
type StatusHandler = (message: string) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private timeoutId: number | null = null;

  constructor(private readonly url: string, private readonly status: StatusHandler) {}

  async connect(onMessage: MessageHandler): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket unavailable'));
        return;
      }

      this.timeoutId = window.setTimeout(() => {
        this.status('Connection timed out.');
        this.disconnect();
        reject(new Error('Connection timed out'));
      }, 10_000);

      this.ws.onopen = () => {
        this.clearTimeout();
        this.status('Connected.');
        resolve();
      };

      this.ws.onerror = () => {
        this.clearTimeout();
        reject(new Error('WebSocket error'));
      };

      this.ws.onmessage = async (event) => {
        const parsed = JSON.parse(String(event.data));
        const validated = incomingMessageSchema.safeParse(parsed);
        if (!validated.success) return;
        await onMessage(validated.data);
      };

      this.ws.onclose = () => {
        this.clearTimeout();
        this.status('Disconnected.');
      };
    });
  }

  send(payload: OutgoingMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  disconnect(): void {
    this.clearTimeout();
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.close();
    this.ws = null;
  }

  private clearTimeout(): void {
    if (this.timeoutId !== null) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}
