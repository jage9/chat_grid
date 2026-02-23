export type SpatialMixOptions = {
  dx: number;
  dy: number;
  range: number;
  baseGain?: number;
  nearFieldDistance?: number;
  nearFieldGain?: number;
  nearFieldCenterPan?: boolean;
  directional?: {
    enabled: boolean;
    facingDeg: number;
    coneDeg?: number;
    rearGain?: number;
  };
};

export type SpatialMixResult = {
  distance: number;
  gain: number;
  pan: number;
};

type DirectionalProfile = {
  attenuationFactor: number;
  offAxisRatio: number;
};

export function resolveSpatialMix(options: SpatialMixOptions): SpatialMixResult | null {
  const {
    dx,
    dy,
    range,
    baseGain = 1,
    nearFieldDistance,
    nearFieldGain = 1,
    nearFieldCenterPan = false,
  } = options;
  if (!(range > 0)) {
    return null;
  }

  const distance = Math.hypot(dx, dy);
  let effectiveRange = range;
  if (options.directional?.enabled) {
    const directionalProfile = resolveDirectionalProfile(dx, dy, options.directional);
    effectiveRange = Math.max(0.01, range * directionalProfile.attenuationFactor);
  }

  if (distance > effectiveRange) {
    return null;
  }

  const volumeRatio = Math.max(0, 1 - distance / effectiveRange);
  const shapedVolume = volumeRatio * volumeRatio * (3 - 2 * volumeRatio);
  let gain = baseGain * shapedVolume;
  const clampedX = Math.max(-range, Math.min(range, dx));
  let pan = Math.sin((clampedX / range) * (Math.PI / 2));

  if (nearFieldDistance !== undefined && distance < nearFieldDistance) {
    gain = baseGain * nearFieldGain;
    if (nearFieldCenterPan) {
      pan = 0;
    }
  }

  return { distance, gain, pan };
}

export function resolveDirectionalMuffleRatio(
  dx: number,
  dy: number,
  directional: SpatialMixOptions['directional'],
): number {
  if (!directional?.enabled) return 0;
  return resolveDirectionalProfile(dx, dy, directional).offAxisRatio;
}

export function normalizeDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Computes compass bearing from source to listener where 0 is north and 90 is east. */
function bearingFromSourceToListener(dx: number, dy: number): number {
  // 0 degrees is north (+y), 90 is east (+x), matching screen-reader compass wording.
  const degrees = Math.atan2(dx, dy) * (180 / Math.PI);
  return normalizeDegrees(degrees);
}

/** Returns shortest absolute angular difference in degrees on a circle. */
function angularDifferenceDeg(a: number, b: number): number {
  const raw = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
  return raw > 180 ? 360 - raw : raw;
}

/** Computes directional attenuation profile based on listener angle vs source facing. */
function resolveDirectionalProfile(
  dx: number,
  dy: number,
  directional: NonNullable<SpatialMixOptions['directional']>,
): DirectionalProfile {
  const coneDeg = Math.max(1, Math.min(359, directional.coneDeg ?? 120));
  const rearGain = Math.max(0, Math.min(1, directional.rearGain ?? 0.5));
  const facingDeg = normalizeDegrees(directional.facingDeg);
  // `dx/dy` are listener-relative source coords in current callers, so invert to get source->listener bearing.
  const bearingDeg = bearingFromSourceToListener(-dx, -dy);
  const diff = angularDifferenceDeg(facingDeg, bearingDeg);
  const halfCone = coneDeg / 2;
  if (diff <= halfCone) {
    return { attenuationFactor: 1, offAxisRatio: 0 };
  }
  const span = Math.max(1, 180 - halfCone);
  const offAxisRatio = Math.max(0, Math.min(1, (diff - halfCone) / span));
  return {
    attenuationFactor: 1 - offAxisRatio * (1 - rearGain),
    offAxisRatio,
  };
}
