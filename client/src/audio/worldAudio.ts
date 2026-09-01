import { HEARING_RADIUS } from '../state/gameState';
import {
  AudioEngine,
  type SpatialAudioPosition,
  type SpatialTransmissionResolver,
} from './audioEngine';

export const WORLD_FOOTSTEP_GAIN = 0.7;

export type WorldSoundSource = SpatialAudioPosition & {
  gain?: number;
  range?: number;
};

type ListenerPositionGetter = () => SpatialAudioPosition;
type AcousticConnectivityResolver = (
  source: SpatialAudioPosition,
  listener: SpatialAudioPosition,
) => boolean;

/** Central entry point for positional one-shot sounds emitted by the world. */
export class WorldAudioRouter {
  constructor(
    private readonly audio: AudioEngine,
    private readonly getListenerPosition: ListenerPositionGetter,
    private readonly isWorldLayerEnabled: () => boolean,
    private readonly resolveTransmission: SpatialTransmissionResolver,
    private readonly canRouteSource: AcousticConnectivityResolver,
  ) {
    this.audio.setSpatialTransmissionResolver(resolveTransmission);
  }

  playSample(url: string, source: WorldSoundSource): void {
    if (!url || !this.canRoute(source)) return;
    void this.audio.playSpatialSample(
      url,
      source,
      this.getListenerPosition(),
      source.gain ?? 1,
      source.range ?? HEARING_RADIUS,
    );
  }

  async playSequence(urls: string[], source: WorldSoundSource): Promise<void> {
    if (urls.length === 0 || !this.canRoute(source)) return;
    for (const url of urls) {
      if (!url || !this.canRoute(source)) return;
      await this.audio.playSpatialSampleAndWait(
        url,
        source,
        this.getListenerPosition(),
        source.gain ?? 1,
        source.range ?? HEARING_RADIUS,
      );
    }
  }

  private canRoute(source: WorldSoundSource): boolean {
    return this.isWorldLayerEnabled()
      && this.canRouteSource(source, this.getListenerPosition());
  }
}
