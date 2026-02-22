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
  if (distance > range) {
    return null;
  }

  const volumeRatio = Math.max(0, 1 - distance / range);
  let gain = baseGain * Math.pow(volumeRatio, 2);
  const clampedX = Math.max(-range, Math.min(range, dx));
  let pan = Math.sin((clampedX / range) * (Math.PI / 2));

  if (nearFieldDistance !== undefined && distance < nearFieldDistance) {
    gain = baseGain * nearFieldGain;
    if (nearFieldCenterPan) {
      pan = 0;
    }
  }

  if (options.directional?.enabled) {
    const coneDeg = Math.max(1, Math.min(359, options.directional.coneDeg ?? 120));
    const rearGain = Math.max(0, Math.min(1, options.directional.rearGain ?? 0.5));
    const facingDeg = normalizeDegrees(options.directional.facingDeg);
    const bearingDeg = bearingFromSourceToListener(dx, dy);
    const diff = angularDifferenceDeg(facingDeg, bearingDeg);
    const halfCone = coneDeg / 2;
    if (diff > halfCone) {
      const span = Math.max(1, 180 - halfCone);
      const t = Math.max(0, Math.min(1, (diff - halfCone) / span));
      const directionalGain = 1 - t * (1 - rearGain);
      gain *= directionalGain;
    }
  }

  return { distance, gain, pan };
}

export function normalizeDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function bearingFromSourceToListener(dx: number, dy: number): number {
  // 0 degrees is north (+y), 90 is east (+x), matching screen-reader compass wording.
  const degrees = Math.atan2(dx, dy) * (180 / Math.PI);
  return normalizeDegrees(degrees);
}

function angularDifferenceDeg(a: number, b: number): number {
  const raw = Math.abs(normalizeDegrees(a) - normalizeDegrees(b));
  return raw > 180 ? 360 - raw : raw;
}
