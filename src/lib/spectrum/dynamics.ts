/**
 * Shared audio-reactive dynamics: envelope followers and bass-onset impact.
 * Pure math — no DOM, no three.js — so it is unit-testable and usable from
 * both the 2d canvas styles and the WebGL styles.
 */

/** Asymmetric one-pole follower: fast attack, slower release (rates per second). */
export class Envelope {
  value = 0;

  constructor(
    private attack = 20,
    private release = 6,
  ) {}

  step(target: number, dt: number): number {
    const rate = target > this.value ? this.attack : this.release;
    this.value += (target - this.value) * (1 - Math.exp(-Math.max(0, dt) * rate));
    return this.value;
  }
}

/** Per-band envelope smoothing for spectrum arrays. */
export class BandSmoother {
  private values: Float32Array;

  constructor(
    count: number,
    private attack = 26,
    private release = 9,
  ) {
    this.values = new Float32Array(count);
  }

  step(bands: ArrayLike<number>, dt: number): Float32Array {
    const k = this.values;
    for (let i = 0; i < k.length; i++) {
      const target = bands[i] ?? 0;
      const rate = target > k[i] ? this.attack : this.release;
      k[i] += (target - k[i]) * (1 - Math.exp(-Math.max(0, dt) * rate));
    }
    return k;
  }
}

export interface PulseFrame {
  /** Smoothed full-spectrum energy 0..1. */
  energy: number;
  /** Smoothed bass level 0..1. */
  bass: number;
  /** Bass onset impact 0..1 — spikes on a hit, decays in ~150ms. */
  impact: number;
}

/** Combines smoothed energy/bass with a bass-onset detector. */
export class AudioPulse {
  private energyEnv = new Envelope(18, 5);
  private bassEnv = new Envelope(30, 7);
  private baseline = new Envelope(2.5, 2.5);
  private impactValue = 0;

  update(rawEnergy: number, rawBass: number, dt: number): PulseFrame {
    const energy = this.energyEnv.step(rawEnergy, dt);
    const bass = this.bassEnv.step(rawBass, dt);
    const base = this.baseline.step(rawBass, dt);
    const onset = Math.max(0, rawBass - base * 1.12 - 0.02);
    this.impactValue = Math.max(
      this.impactValue * Math.exp(-Math.max(0, dt) * 7),
      Math.min(1, onset * 5),
    );
    return { energy, bass, impact: this.impactValue };
  }
}

/**
 * Gentle synthetic spectrum for the idle stage (no audio loaded): slow
 * breathing lows and a faint shimmer so styles stay alive but quiet.
 */
export function idleSpectrum(target: Uint8Array, elapsed: number): Uint8Array {
  const n = target.length;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const lows = Math.exp(-t * 9) * (0.32 + 0.2 * Math.sin(elapsed * 0.9));
    const shimmer = 0.05 * Math.sin(elapsed * 1.7 + t * 21) * Math.exp(-t * 2.5);
    target[i] = Math.max(0, Math.min(255, Math.round((lows + shimmer + 0.015) * 96)));
  }
  return target;
}
