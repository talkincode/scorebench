/**
 * 航线 (Voyage) pure math — the deterministic skeleton of the voyage imagery:
 * the cruise-speed model, wrap-around streaming fields, the capital-ship hull
 * silhouette, helical light-trail paths and maintenance-drone flight poses.
 * No DOM, no three.js — unit-testable without a renderer, consumed by
 * `three/voyage.ts`.
 *
 * Convention: the ship lies along the Z axis, bow at `SHIP_BOW_Z` (direction
 * of travel, -Z), stern at `SHIP_STERN_Z`. The ship itself never moves — the
 * universe streams past it toward +Z, and `cruiseSpeed` scales that stream.
 */

export const SHIP_BOW_Z = -34;
export const SHIP_STERN_Z = 18;
export const SHIP_LENGTH = SHIP_STERN_Z - SHIP_BOW_Z;

/** Idle drift — the ship never stops, silence still moves forward. */
export const CRUISE_BASE = 0.3;
export const CRUISE_MAX = 2.6;

/** Fixed optical proportions for every Voyage engine. */
export const ENGINE_CORE_DIAMETER_RATIO = 0.31;
export const ENGINE_JET_LENGTH_DIAMETERS = 3.15;
export const ENGINE_GLOW_WIDTH_RATIO = 1.7;
export const ENGINE_BEAT_ATTACK_SECONDS = 0.008;
export const ENGINE_BEAT_RELEASE_SECONDS = 0.1;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smooth(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Smoothed bass may change jet length only, within ±20% of its base. */
export function engineJetLengthScale(bass: number): number {
  return 0.8 + clamp01(bass) * 0.4;
}

/** Smoothed full-spectrum energy may change core brightness only, within ±15%. */
export function engineCoreBrightnessScale(energy: number): number {
  return 0.85 + clamp01(energy) * 0.3;
}

export interface CruiseAxes {
  arousal: number;
  pulse: number;
  buildUp: number;
  swell: number;
}

/**
 * Emotion axes → forward velocity. Arousal is the throttle, build-up charges
 * an extra surge, the phrase swell breathes on top, and a bass impact kicks
 * transiently. Monotone in every input and clamped to `CRUISE_MAX`.
 */
export function cruiseSpeed(axes: CruiseAxes, impact = 0): number {
  const swellPush = Math.max(0, axes.swell);
  const raw =
    CRUISE_BASE +
    clamp01(axes.arousal) * 1.15 +
    clamp01(axes.pulse) * 0.3 +
    clamp01(axes.buildUp) * 0.6 +
    swellPush * 0.2 +
    Math.max(0, impact) * 0.35;
  return Math.min(CRUISE_MAX, raw);
}

/** Wraps a coordinate into [min, max) — streaming fields recycle through it. */
export function wrapCoord(value: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) return min;
  let v = (value - min) % span;
  if (v < 0) v += span;
  return min + v;
}

/** Normalized hull coordinate: 0 at the stern plane, 1 at the bow tip. */
export function shipU(z: number): number {
  return clamp01((SHIP_STERN_Z - z) / SHIP_LENGTH);
}

export interface HullSection {
  /** Half beam at this station. */
  halfWidth: number;
  /** Half height at this station. */
  halfHeight: number;
  /** Vertical offset of the section center — a gentle spine arc. */
  mid: number;
}

/**
 * Capital-ship silhouette along u (0 = stern, 1 = bow): a broad engine block
 * (the widest working mass sits aft), a blocky midship crest, then a long
 * tapering ram bow.
 */
export function hullProfile(u: number): HullSection {
  const t = clamp01(u);
  const rise = 0.62 + 0.38 * smooth(0, 0.3, t);
  const taper = 1 - smooth(0.55, 0.98, t);
  const body = rise * (0.2 + 0.8 * taper);
  return {
    halfWidth: 1 + body * 2.6,
    halfHeight: 0.9 + body * 2,
    mid: Math.sin(t * Math.PI) * 0.35,
  };
}

/** Clearance envelope radius around the hull cross-section at station u. */
export function hullRadius(u: number): number {
  const section = hullProfile(u);
  return Math.hypot(section.halfWidth, section.halfHeight);
}

/**
 * Helical streamline hugging the hull from stern to bow: `count` xyz triples
 * (flat array, ready for a line geometry). The ellipse is slightly squashed
 * vertically so trails ride the flanks rather than the keel.
 */
export function helixPoints(
  count: number,
  turns: number,
  phase: number,
  clearance: number,
): Float32Array {
  const out = new Float32Array(count * 3);
  const last = Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const f = i / last;
    const z = SHIP_STERN_Z + (SHIP_BOW_Z - SHIP_STERN_Z) * f;
    const angle = phase + f * turns * Math.PI * 2;
    const radius = hullRadius(shipU(z)) + clearance;
    out[i * 3] = Math.cos(angle) * radius;
    out[i * 3 + 1] = Math.sin(angle) * radius * 0.82;
    out[i * 3 + 2] = z;
  }
  return out;
}

/**
 * Samples a flat xyz polyline at fraction t (0..1) with linear interpolation,
 * writing into `out` — used to fly comet heads along trail paths without
 * per-frame allocation.
 */
export function samplePath(points: Float32Array, t: number, out: Float32Array): void {
  const segments = points.length / 3 - 1;
  if (segments <= 0) {
    out[0] = points[0] ?? 0;
    out[1] = points[1] ?? 0;
    out[2] = points[2] ?? 0;
    return;
  }
  const clamped = clamp01(t) * segments;
  const index = Math.min(segments - 1, Math.floor(clamped));
  const frac = clamped - index;
  const a = index * 3;
  const b = a + 3;
  out[0] = points[a] + (points[b] - points[a]) * frac;
  out[1] = points[a + 1] + (points[b + 1] - points[a + 1]) * frac;
  out[2] = points[a + 2] + (points[b + 2] - points[a + 2]) * frac;
}

export interface RobotParams {
  centerZ: number;
  radiusX: number;
  radiusY: number;
  spanZ: number;
  freqX: number;
  freqY: number;
  freqZ: number;
  phaseX: number;
  phaseY: number;
  phaseZ: number;
}

export interface RobotPose {
  x: number;
  y: number;
  z: number;
  /** Analytic velocity — the drone banks along it. */
  vx: number;
  vy: number;
  vz: number;
  /** Distance from the hull clearance envelope; ≤ 0 means hugging the hull. */
  hullDistance: number;
}

/**
 * Deterministic Lissajous flight around the hull. Incommensurate frequencies
 * keep the patrol from ever exactly repeating while staying bounded; the
 * hull distance lets the scene decide when the drone is close enough to weld.
 */
export function robotPose(t: number, p: RobotParams, out: RobotPose): RobotPose {
  out.x = Math.sin(t * p.freqX + p.phaseX) * p.radiusX;
  out.y = Math.sin(t * p.freqY + p.phaseY) * p.radiusY;
  out.z = p.centerZ + Math.sin(t * p.freqZ + p.phaseZ) * p.spanZ;
  out.vx = Math.cos(t * p.freqX + p.phaseX) * p.radiusX * p.freqX;
  out.vy = Math.cos(t * p.freqY + p.phaseY) * p.radiusY * p.freqY;
  out.vz = Math.cos(t * p.freqZ + p.phaseZ) * p.spanZ * p.freqZ;
  out.hullDistance = Math.hypot(out.x, out.y / 0.82) - hullRadius(shipU(out.z));
  return out;
}

// ---------------------------------------------------------------------------
// The dagger hull — the cinematic rebuild. A much longer ship (the camera
// sits at the stern; the bow vanishes into fog and perspective), with the
// audio plumbing that turns raw FFT into disciplined motion: attack/release
// envelopes, soft-knee compression, and the four-state scene weights.
// ---------------------------------------------------------------------------

export const DAGGER_STERN_Z = 40;
export const DAGGER_BOW_Z = -210;
export const DAGGER_LENGTH = DAGGER_STERN_Z - DAGGER_BOW_Z;

/** Normalized dagger-hull coordinate: 0 at the stern plane, 1 at the bow tip. */
export function daggerU(z: number): number {
  return clamp01((DAGGER_STERN_Z - z) / DAGGER_LENGTH);
}

export interface DaggerSection {
  /** Half beam at this station. */
  halfWidth: number;
  /** Half height at this station. */
  halfHeight: number;
  /** Vertical offset of the section center. */
  mid: number;
}

/**
 * The dagger silhouette along u (0 = stern, 1 = bow): a heavy engineering
 * block aft, maximum beam just forward of it, then a long continuous taper
 * into a ram bow. Smooth (C¹) everywhere so longitudinal silhouette edges
 * read as calm, deliberate lines rather than jagged noise.
 */
export function daggerProfile(u: number): DaggerSection {
  const t = clamp01(u);
  // Slight stern chamfer, then the long taper owns the rest of the hull.
  const block = 0.86 + smooth(0, 0.1, t) * 0.14;
  const taper = 1 - smooth(0.2, 0.985, t) * 0.97;
  const body = block * taper;
  return {
    halfWidth: 1.1 + body * 16.9,
    halfHeight: 0.8 + body * 10.2,
    // The spine sags slightly amidships and the bow rides a touch high.
    mid: Math.sin(t * Math.PI) * -1.1 + smooth(0.7, 1, t) * 2.4,
  };
}

/**
 * Exponential attack/release envelope follower. Rising targets are chased
 * with the (fast) attack time constant, falling targets with the (slow)
 * release constant — the standard way to make FFT data feel like metering
 * rather than flicker. Time constants are in seconds.
 */
export function attackRelease(
  current: number,
  target: number,
  dt: number,
  attack: number,
  release: number,
): number {
  const tau = target > current ? attack : release;
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/** Fast attack and 100 ms release for the engine's brightness-only beat flash. */
export function engineBeatEnvelope(current: number, triggered: boolean, dt: number): number {
  return attackRelease(
    current,
    triggered ? 1 : 0,
    dt,
    ENGINE_BEAT_ATTACK_SECONDS,
    ENGINE_BEAT_RELEASE_SECONDS,
  );
}

/**
 * Soft-knee compressor for band levels: monotone, 0 → 0, saturating below 1.
 * Keeps quiet material readable and loud material from pegging visuals.
 */
export function compressLevel(x: number, drive = 2.4): number {
  if (x <= 0) return 0;
  return 1 - Math.exp(-x * drive);
}

/**
 * The four scene states as smooth partition weights over the slow energy
 * trend: dormant → cruise → charged → transcend. Weights are non-negative
 * and sum to 1; `surge` (build-up) leans the blend toward transcend early.
 * Out layout: [dormant, cruise, charged, transcend].
 */
export function voyageStateWeights(trend: number, surge: number, out: Float32Array): Float32Array {
  const t = clamp01(trend + clamp01(surge) * 0.18);
  const cruiseIn = smooth(0.08, 0.24, t);
  const chargedIn = smooth(0.45, 0.62, t);
  const transcendIn = smooth(0.74, 0.9, t);
  out[0] = 1 - cruiseIn;
  out[1] = cruiseIn * (1 - chargedIn);
  out[2] = chargedIn * (1 - transcendIn);
  out[3] = transcendIn;
  return out;
}

/**
 * Cubic Bézier in 3D over a flat 12-float control array [p0 p1 p2 p3],
 * writing position into `out` — the robots fly composed spline programs,
 * not random walks.
 */
export function bezier3(controls: Float32Array, t: number, out: Float32Array): void {
  const s = clamp01(t);
  const r = 1 - s;
  const a = r * r * r;
  const b = 3 * r * r * s;
  const c = 3 * r * s * s;
  const d = s * s * s;
  for (let k = 0; k < 3; k++) {
    out[k] = controls[k] * a + controls[3 + k] * b + controls[6 + k] * c + controls[9 + k] * d;
  }
}

export interface StagePhase {
  /** Index into the durations array. */
  index: number;
  /** Normalized progress through that stage, 0..1. */
  u: number;
}

/**
 * Where a looping multi-stage program stands at time t: stage index and
 * normalized progress. Drives the robot state machine deterministically.
 */
export function stagePhase(t: number, durations: readonly number[], out: StagePhase): StagePhase {
  let cycle = 0;
  for (const d of durations) cycle += d;
  if (cycle <= 0) {
    out.index = 0;
    out.u = 0;
    return out;
  }
  let local = t % cycle;
  if (local < 0) local += cycle;
  for (let i = 0; i < durations.length; i++) {
    if (local < durations[i] || i === durations.length - 1) {
      out.index = i;
      out.u = durations[i] > 0 ? Math.min(1, local / durations[i]) : 0;
      return out;
    }
    local -= durations[i];
  }
  out.index = 0;
  out.u = 0;
  return out;
}
