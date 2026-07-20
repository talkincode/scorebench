/**
 * 情绪 (Mood) engine: a slow, stable mapping from analyser spectra onto a
 * small set of abstract world archetypes — 宇宙 cosmos, 星空 starlight,
 * 大海 ocean, 草原 meadow, 城市 city. Pure math (no DOM, no three.js) so the
 * mapping is unit-testable and deterministic.
 *
 * Design: perceptual features (mode, dissonance, brightness from
 * `HarmonicAnalyzer`; energy, flux, bass pulse from the raw spectrum) are
 * folded into an emotion space — valence (dark↔bright feeling), arousal
 * (calm↔energetic), tension (rest↔strain) plus a pulse axis — through
 * seconds-scale envelopes. Three time scales are tracked: texture (~0.1 s,
 * per-hit), phrase (~2 s swells), and form (~10 s build-ups). Every world has
 * a signature point in emotion space and receives a Gaussian affinity weight.
 * Weights are smoothed again, and the *dominant* world only changes after a
 * challenger stays clearly ahead for a dwell period — the scene morphs
 * gradually and never flickers between worlds, however busy the music is.
 *
 * An optional *intent* prior (the scene's declared key mode) can bias
 * valence when the audio evidence is ambiguous; the acceptance idea is that
 * the rendered mood should agree with what the score *claims* to express.
 */

import { Envelope } from "./dynamics";
import { HarmonicAnalyzer } from "./features";

export const MOOD_WORLDS = ["cosmos", "starlight", "ocean", "meadow", "city"] as const;
export type MoodWorld = (typeof MOOD_WORLDS)[number];

/** World signatures in emotion space: [arousal, valence, tension, pulse]. */
const SIGNATURES: Record<MoodWorld, readonly [number, number, number, number]> = {
  cosmos: [0.05, 0.5, 0.1, 0.05],
  starlight: [0.15, 0.85, 0.12, 0.1],
  ocean: [0.3, 0.4, 0.25, 0.25],
  meadow: [0.25, 0.85, 0.15, 0.35],
  city: [0.85, 0.55, 0.4, 0.85],
};

const TWO_SIGMA_SQ = 2 * 0.32 * 0.32;
/** A challenger must beat the incumbent by this margin… */
const SWITCH_MARGIN = 0.04;
/** …continuously for this many seconds before the dominant world flips. */
const SWITCH_DWELL = 2.2;

/** Observed intent — declared score facts the mood should agree with. */
export interface MoodIntent {
  /** Declared mode: 1 major, 0 minor (from the scene key). */
  modeMajor?: number;
}

export interface MoodState {
  /** Emotion axes, 0..1 — slow-moving observations, never per-frame jitter. */
  arousal: number;
  /** Dark/sad ↔ bright/happy. Driven by mode, consonance, brightness. */
  valence: number;
  /** Rest ↔ strain. Driven by dissonance and form-scale build-up. */
  tension: number;
  /** Beat presence 0..1. */
  pulse: number;
  /** Form-scale crescendo detector 0..1 — rises while energy keeps climbing. */
  buildUp: number;
  /** Phrase-scale breathing -1..1 — positive while the phrase swells. */
  swell: number;
  /** Normalized world weights (sum ≈ 1). Mutated in place across updates. */
  weights: Record<MoodWorld, number>;
  /** Stable dominant world (hysteresis + dwell). */
  dominant: MoodWorld;
}

export interface MoodUpdateOptions {
  /** Analyser bin width in Hz (sampleRate / fftSize). */
  binHz?: number;
  /** Declared-intent prior; blended in only when audio evidence is weak. */
  intent?: MoodIntent;
}

export class MoodEngine {
  private harmonics = new HarmonicAnalyzer();
  private axisEnv = [
    new Envelope(0.9, 0.9), // arousal
    new Envelope(0.55, 0.55), // valence — mood shifts read over ~2s phrases
    new Envelope(0.8, 1.1), // tension — grips slightly faster than it lets go… visually attack
    new Envelope(0.9, 0.9), // pulse
  ];
  private weightEnv = MOOD_WORLDS.map(() => new Envelope(0.75, 0.75));
  private baseline = new Envelope(2.5, 2.5);
  /** Three time scales of loudness: texture, phrase, form. */
  private fastEnergy = new Envelope(1.4, 1.4); // ~0.7s
  private slowEnergy = new Envelope(0.2, 0.2); // ~5s
  private phraseEnergy = new Envelope(0.125, 0.125); // ~8s
  private buildEnv = new Envelope(0.8, 4); // slow to believe, quick to release
  /** Smooths fast−slow before rectification so pulse ripple ≠ crescendo. */
  private climbEnv = new Envelope(1.2, 1.2);
  private prev: Float32Array | null = null;
  private pulseValue = 0;
  private refractory = 0;
  private dominantIndex = 0;
  private challengerIndex = -1;
  private challengeTime = 0;

  private readonly state: MoodState = {
    arousal: 0,
    valence: 0.5,
    tension: 0,
    pulse: 0,
    buildUp: 0,
    swell: 0,
    weights: { cosmos: 1, starlight: 0, ocean: 0, meadow: 0, city: 0 },
    dominant: "cosmos",
  };

  /** Feed one analyser frame (byte spectrum 0..255); returns the mood state. */
  update(freq: ArrayLike<number>, dt: number, opts?: MoodUpdateOptions): MoodState {
    const n = freq.length;
    if (n === 0) return this.state;
    const step = Math.max(1e-4, dt);

    // Raw spectral features.
    const bassEnd = Math.max(1, n >> 3);
    let sum = 0;
    let bassSum = 0;
    let active = 0;
    let fluxSum = 0;
    if (!this.prev || this.prev.length !== n) this.prev = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = (freq[i] ?? 0) / 255;
      sum += v;
      if (i < bassEnd) bassSum += v;
      if (v > 0.055) active++;
      fluxSum += Math.abs(v - this.prev[i]);
      this.prev[i] = v;
    }
    const energy = sum / n;
    const bass = bassSum / bassEnd;
    const density = active / n;
    const flux = Math.min(1, fluxSum / n / step / 2.5);

    // Perceptual harmony features (mode / dissonance / brightness).
    const harmony = this.harmonics.analyze(freq, opts?.binHz);

    // Bass-onset pulse: amplitude-scaled impulse per hit, slow decay — a
    // beat-strength proxy that separates gentle sway from urban thump.
    const base = this.baseline.step(bass, step);
    this.refractory = Math.max(0, this.refractory - step);
    let hit = 0;
    const overshoot = bass - base * 1.12 - 0.03;
    if (this.refractory <= 0 && overshoot > 0.03) {
      hit = Math.min(1, overshoot * 3);
      this.refractory = 0.16;
    }
    this.pulseValue = Math.min(1, this.pulseValue * Math.exp(-step * 0.6) + hit * 0.35);

    // Three time scales of loudness → build-up (form) and swell (phrase).
    const fast = this.fastEnergy.step(energy, step);
    const prevSlow = this.slowEnergy.value;
    const slow = this.slowEnergy.step(energy, step);
    const phrase = this.phraseEnergy.step(energy, step);
    // Build-up = sustained upward *slope* of the slow envelope. Slope decays
    // to zero once material plateaus, so a loud steady groove reads as
    // "arrived", not "still climbing"; pulse ripple is smoothed out first.
    const slope = step > 1e-4 ? (slow - prevSlow) / step : 0;
    const climb = this.climbEnv.step(slope, step);
    const climbing = Math.max(0, climb * 20 - 0.06);
    const buildUp = this.buildEnv.step(Math.min(1, climbing), step);
    const swell = Math.tanh((fast - phrase) * 5);

    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

    // Valence: mode carries most of the feeling — a minor triad is consonant
    // yet sad, so consonance only shades the result. Harmonic terms are gated
    // by tonal confidence; when the audio is ambiguous, the declared intent
    // (if any) fills the gap.
    const intentMode = opts?.intent?.modeMajor;
    let mode = harmony.modeMajor;
    if (intentMode !== undefined) {
      const trust = clamp01(harmony.tonal * 1.4);
      mode = mode * trust + intentMode * (1 - trust);
    }
    const modeTerm = (mode - 0.5) * 0.9;
    const consTerm = (0.3 - harmony.dissonance) * 0.25;
    const brightTerm = Math.max(-0.12, Math.min(0.12, (harmony.centroid - 0.45) * 0.3));
    // With a declared intent the mode opinion stays expressed even in thin
    // audio — but never at full strength, so intent shifts rather than slams.
    const tonalGate = intentMode !== undefined ? Math.max(harmony.tonal, 0.6) : harmony.tonal;
    const valenceTarget = clamp01(0.5 + tonalGate * (modeTerm + consTerm) + brightTerm);

    // Tension: sustained roughness plus the pressure of a build-up.
    const tensionTarget = clamp01(
      harmony.tonal * harmony.dissonance * 0.75 + buildUp * 0.45 + flux * 0.12,
    );

    // Emotion axes through slow envelopes.
    const arousal = this.axisEnv[0].step(
      clamp01(energy * 1.5 + flux * 0.45 + this.pulseValue * 0.15),
      step,
    );
    const valence = this.axisEnv[1].step(valenceTarget, step);
    const tension = this.axisEnv[2].step(tensionTarget, step);
    const pulse = this.axisEnv[3].step(this.pulseValue, step);

    // Gaussian affinity per world, smoothed then renormalized.
    let total = 0;
    const smoothed = this.weightEnv;
    for (let w = 0; w < MOOD_WORLDS.length; w++) {
      const sig = SIGNATURES[MOOD_WORLDS[w]];
      const d2 =
        (arousal - sig[0]) ** 2 +
        (valence - sig[1]) ** 2 +
        (tension - sig[2]) ** 2 +
        (pulse - sig[3]) ** 2;
      total += smoothed[w].step(Math.exp(-d2 / TWO_SIGMA_SQ), step);
    }
    const weights = this.state.weights;
    let topIndex = 0;
    for (let w = 0; w < MOOD_WORLDS.length; w++) {
      const value = total > 1e-9 ? smoothed[w].value / total : w === 0 ? 1 : 0;
      weights[MOOD_WORLDS[w]] = value;
      if (value > weights[MOOD_WORLDS[topIndex]] || w === 0) topIndex = w;
    }

    // Dominant-world hysteresis: challengers must persist for SWITCH_DWELL.
    if (topIndex === this.dominantIndex) {
      this.challengerIndex = -1;
      this.challengeTime = 0;
    } else if (
      weights[MOOD_WORLDS[topIndex]] >
      weights[MOOD_WORLDS[this.dominantIndex]] + SWITCH_MARGIN
    ) {
      if (this.challengerIndex === topIndex) {
        this.challengeTime += step;
        if (this.challengeTime >= SWITCH_DWELL) {
          this.dominantIndex = topIndex;
          this.challengerIndex = -1;
          this.challengeTime = 0;
        }
      } else {
        this.challengerIndex = topIndex;
        this.challengeTime = 0;
      }
    } else {
      this.challengerIndex = -1;
      this.challengeTime = 0;
    }

    this.state.arousal = arousal;
    this.state.valence = valence;
    this.state.tension = tension;
    this.state.pulse = pulse;
    this.state.buildUp = buildUp;
    this.state.swell = swell;
    this.state.dominant = MOOD_WORLDS[this.dominantIndex];
    return this.state;
  }
}

/**
 * mulberry32 — tiny deterministic PRNG in [0, 1). World layouts are seeded so
 * the "random digital world" is random-looking yet reproducible per session.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
