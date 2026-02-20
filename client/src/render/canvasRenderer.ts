import { GRID_SIZE, type GameState, type PeerState, type WorldItem } from '../state/gameState';

export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly squarePixelSize: number;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Unable to create 2D context');
    }
    this.ctx = ctx;
    this.squarePixelSize = canvas.width / GRID_SIZE;
  }

  draw(state: GameState): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.strokeStyle = '#374151';
    for (let i = 0; i <= GRID_SIZE; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * this.squarePixelSize, 0);
      ctx.lineTo(i * this.squarePixelSize, this.canvas.height);
      ctx.moveTo(0, i * this.squarePixelSize);
      ctx.lineTo(this.canvas.width, i * this.squarePixelSize);
      ctx.stroke();
    }

    for (const peer of state.peers.values()) {
      this.drawObject(peer, '#f87171', peer.nickname);
    }
    for (const item of state.items.values()) {
      if (item.carrierId) continue;
      this.drawItem(item);
    }
    this.drawObject(state.player, '#34d399', state.player.nickname);

    if (state.mode === 'nickname' || state.mode === 'chat' || state.mode === 'itemPropertyEdit') {
      const label =
        state.mode === 'nickname' ? 'New Nickname' : state.mode === 'chat' ? 'Message' : 'Property Value';
      this.drawTextOverlay(state, label);
    }
  }

  private drawObject(obj: Pick<PeerState, 'x' | 'y' | 'nickname'>, color: string, name: string): void {
    const drawX = obj.x * this.squarePixelSize;
    const drawY = this.canvas.height - (obj.y * this.squarePixelSize) - this.squarePixelSize;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(drawX, drawY, this.squarePixelSize, this.squarePixelSize);
    this.ctx.fillStyle = 'white';
    this.ctx.font = '12px Courier New';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(name, drawX + this.squarePixelSize / 2, drawY - 5);
  }

  private drawTextOverlay(state: GameState, label: string): void {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, this.canvas.height / 2 - 30, this.canvas.width, 60);
    ctx.fillStyle = 'white';
    ctx.font = '24px Courier New';
    ctx.textAlign = 'center';

    const text = `${label}: ${state.nicknameInput}`;
    const textMetrics = ctx.measureText(text);
    const preCursorText = `${label}: ${state.nicknameInput.substring(0, state.cursorPos)}`;
    const preCursorWidth = ctx.measureText(preCursorText).width;
    const textX = this.canvas.width / 2;

    ctx.fillText(text, textX, this.canvas.height / 2);
    if (state.cursorVisible) {
      ctx.fillRect(textX - textMetrics.width / 2 + preCursorWidth, this.canvas.height / 2 - 20, 2, 24);
    }
  }

  private drawItem(item: WorldItem): void {
    const drawX = item.x * this.squarePixelSize;
    const drawY = this.canvas.height - (item.y * this.squarePixelSize) - this.squarePixelSize;
    this.ctx.fillStyle = item.type === 'radio_station' ? '#fbbf24' : '#60a5fa';
    this.ctx.fillRect(drawX, drawY, this.squarePixelSize, this.squarePixelSize);
    this.ctx.fillStyle = '#111827';
    this.ctx.font = 'bold 12px Courier New';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(item.type === 'radio_station' ? 'R' : 'D', drawX + this.squarePixelSize / 2, drawY + 13);
  }
}
