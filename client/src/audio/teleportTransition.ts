/** Coordinates the audio half of a server-timed player teleport. */

export type TeleportTransitionPhase = 'start' | 'arrive' | 'complete' | 'cancel';

/** Server event consumed by the teleport transition controller. */
export type TeleportTransitionEvent = {
  phase: TeleportTransitionPhase;
  x: number;
  y: number;
  z: number;
  durationMs: number;
};

export type TeleportTransitionCallbacks = {
  /** Starts the existing teleport cue, which should use the audio bypass bus. */
  onStart?: (event: TeleportTransitionEvent) => void;
  /** Runs at the midpoint, after the server has applied the destination position. */
  onArrive?: (event: TeleportTransitionEvent) => void;
  /** Stops the start cue and plays the existing arrival cue. */
  onComplete?: (event: TeleportTransitionEvent) => void;
  /** Stops the start cue after a server-side cancellation. */
  onCancel?: (event: TeleportTransitionEvent) => void;
};

export type TeleportTransitionControllerOptions = TeleportTransitionCallbacks & {
  /** Schedules the shared positional/world output gain. */
  setWorldTransitionGain: (targetGain: number, durationMs: number) => void;
};

type ActivePhase = 'fadingOut' | 'fadingIn';

const FULL_TRANSITION_DURATION_MS = 2000;
const FULL_GAIN = 1;
const SILENT_GAIN = 0;

function transitionHalfDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return FULL_TRANSITION_DURATION_MS / 2;
  }
  return durationMs / 2;
}

/**
 * Applies server-timed teleport phases to one shared world-audio gain.
 *
 * Position changes remain server authoritative. This controller only tracks
 * whether a transition is active, schedules the two gain ramps, and invokes
 * presentation callbacks for cues and terminal cleanup.
 */
export class TeleportTransitionController {
  private activePhase: ActivePhase | null = null;

  constructor(private readonly options: TeleportTransitionControllerOptions) {}

  /** Returns whether movement should remain blocked by an active transition. */
  isActive(): boolean {
    return this.activePhase !== null;
  }

  /** Handles one server transition phase. Stale terminal phases are ignored. */
  handle(event: TeleportTransitionEvent): void {
    const halfDurationMs = transitionHalfDuration(event.durationMs);

    switch (event.phase) {
      case 'start':
        this.activePhase = 'fadingOut';
        this.options.setWorldTransitionGain(SILENT_GAIN, halfDurationMs);
        this.options.onStart?.(event);
        return;

      case 'arrive':
        if (this.activePhase !== 'fadingOut') return;
        this.activePhase = 'fadingIn';
        this.options.onArrive?.(event);
        this.options.setWorldTransitionGain(FULL_GAIN, halfDurationMs);
        return;

      case 'complete':
        if (this.activePhase === null) return;
        this.activePhase = null;
        this.options.setWorldTransitionGain(FULL_GAIN, 0);
        this.options.onComplete?.(event);
        return;

      case 'cancel':
        if (this.activePhase === null) return;
        this.activePhase = null;
        this.options.setWorldTransitionGain(FULL_GAIN, 0);
        this.options.onCancel?.(event);
        return;
    }
  }

  /** Clears local transition state, such as when disconnecting or resetting. */
  reset(): void {
    this.activePhase = null;
    this.options.setWorldTransitionGain(FULL_GAIN, 0);
  }
}
