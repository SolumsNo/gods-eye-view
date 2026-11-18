import { propagate } from 'satellite.js';

const MU_KM3_S2 = 398600.8;
export const ORBIT_SAMPLE_LENGTH = 13;

/** Store one TEME state and its two-body acceleration and jerk. */
export function sampleFromState(state, atMs, out = new Float64Array(ORBIT_SAMPLE_LENGTH)) {
  const p = state?.position;
  const v = state?.velocity;
  if (!p || typeof p === 'boolean' || !v || typeof v === 'boolean') return null;
  const r = Math.hypot(p.x, p.y, p.z);
  if (!(r > 0) || !Number.isFinite(v.x + v.y + v.z)) return null;

  const k = -MU_KM3_S2 / (r * r * r);
  const radial = 3 * (p.x * v.x + p.y * v.y + p.z * v.z) / (r * r);
  out[0] = atMs;
  out[1] = p.x;
  out[2] = p.y;
  out[3] = p.z;
  out[4] = v.x;
  out[5] = v.y;
  out[6] = v.z;
  out[7] = k * p.x;
  out[8] = k * p.y;
  out[9] = k * p.z;
  out[10] = k * (v.x - radial * p.x);
  out[11] = k * (v.y - radial * p.y);
  out[12] = k * (v.z - radial * p.z);
  return out;
}

export function sampleOrbit(satrec, atMs, out = new Float64Array(ORBIT_SAMPLE_LENGTH)) {
  try {
    return sampleFromState(propagate(satrec, new Date(atMs)), atMs, out);
  } catch {
    return null;
  }
}

/** Reckon a TEME sample into Earth-fixed metres using the supplied GMST angle. */
export function reckonEarthFixed(sample, atMs, gmst, out) {
  const dt = (atMs - sample[0]) / 1000;
  const half = 0.5 * dt * dt;
  const sixth = (half * dt) / 3;
  const x = sample[1] + sample[4] * dt + sample[7] * half + sample[10] * sixth;
  const y = sample[2] + sample[5] * dt + sample[8] * half + sample[11] * sixth;
  const z = sample[3] + sample[6] * dt + sample[9] * half + sample[12] * sixth;
  const cos = Math.cos(gmst);
  const sin = Math.sin(gmst);
  out.x = (x * cos + y * sin) * 1000;
  out.y = (-x * sin + y * cos) * 1000;
  out.z = z * 1000;
  return out;
}
