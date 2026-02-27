import { AudioEngine } from './audioEngine';

type ListenerPositionGetter = () => { x: number; y: number };

/**
 * Plays server-provided clock speech sequences as spatial one-shots.
 */
export class ClockAnnouncer {
  private playToken = 0;

  constructor(
    private readonly audio: AudioEngine,
    private readonly getListenerPosition: ListenerPositionGetter,
  ) {}

  async playSequence(sounds: string[], sourceX: number, sourceY: number): Promise<void> {
    if (sounds.length === 0) return;
    const token = ++this.playToken;
    for (const sound of sounds) {
      if (token !== this.playToken) return;
      const listener = this.getListenerPosition();
      await this.audio.playSpatialSampleAndWait(sound, { x: sourceX, y: sourceY }, listener, 1);
    }
  }
}

