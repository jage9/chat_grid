import { HEARING_RADIUS } from '../state/gameState';
import {
  AudioEngine,
  type SpatialAudioPosition,
  type SpatialTransmissionResolver,
} from './audioEngine';
import { normalizeAcousticMix } from './acoustics';

export const WORLD_FOOTSTEP_GAIN = 0.7;

export type WorldSoundSource = SpatialAudioPosition & {
  gain?: number;
  range?: number;
};

type ListenerPositionGetter = () => SpatialAudioPosition;

/** Central entry point for positional one-shot sounds emitted by the world. */
export class WorldAudioRouter {
  constructor(
    private readonly audio: AudioEngine,
    private readonly getListenerPosition: ListenerPositionGetter,
    private readonly isWorldLayerEnabled: () => boolean,
    private readonly resolveTransmission: SpatialTransmissionResolver,
  ) {
    this.audio.setSpatialTransmissionResolver(resolveTransmission);
  }

  playSample(url: string, source: WorldSoundSource): void {
    if (!url || !this.canHear(source)) return;
    void this.audio.playSpatialSample(
      url,
      source,
      this.getListenerPosition(),
      source.gain ?? 1,
      source.range ?? HEARING_RADIUS,
    );
  }

  async playSequence(urls: string[], source: WorldSoundSource): Promise<void> {
    if (urls.length === 0 || !this.canHear(source)) return;
    for (const url of urls) {
      if (!url || !this.canHear(source)) return;
      await this.audio.playSpatialSampleAndWait(
        url,
        source,
        this.getListenerPosition(),
        source.gain ?? 1,
        source.range ?? HEARING_RADIUS,
      );
    }
  }

  private canHear(source: WorldSoundSource): boolean {
    return this.isWorldLayerEnabled()
      && normalizeAcousticMix(this.resolveTransmission(source, this.getListenerPosition())).gain > 0;
  }
}
