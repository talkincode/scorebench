import { describe, expect, it } from "vitest";
import { MOOD_WORLDS, MoodEngine, seededRandom, type MoodWorld } from "./mood";

const BINS = 256;
const DT = 1 / 60;
/** Matches the default the engine assumes: 48 kHz sample rate, fftSize 2048. */
const BIN_HZ = 48000 / 2048;

function spectrum(fn: (t: number) => number): Uint8Array {
  const out = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(fn(i / BINS) * 255)));
  }
  return out;
}

/**
 * Synthesize an analyser-style magnitude frame for a chord: each fundamental
 * gets a decaying harmonic series, linearly interpolated into FFT bins.
 */
function chord(fundamentals: number[], level: number, harmonics: number, floor = 0): Uint8Array {
  const out = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i++) {
    out[i] = Math.round(floor * 255 * Math.exp(-(i / BINS) * 5));
  }
  for (const f0 of fundamentals) {
    for (let h = 1; h <= harmonics; h++) {
      const exact = (f0 * h) / BIN_HZ - 0.5;
      const lo = Math.floor(exact);
      const frac = exact - lo;
      const amp = level * Math.exp(-(h - 1) * 0.55) * 255;
      for (const [bin, share] of [
        [lo, 1 - frac],
        [lo + 1, frac],
      ] as const) {
        if (bin >= 0 && bin < BINS) out[bin] = Math.min(255, out[bin] + amp * share);
      }
    }
  }
  return out;
}

/** Near-silent, sparse spectrum — deep-space material. */
const calm = spectrum(() => 0.03);
/** A-minor triad, dark voicing — grief material. */
const sad = chord([220, 261.63, 329.63], 0.55, 6, 0.04);
/** C-major triad, bright voicing — joy material. */
const happy = chord([261.63, 329.63, 392.0], 0.75, 12);
/** Semitone cluster — dread material. */
const tense = chord([220, 233.08, 246.94, 466.16], 0.6, 8, 0.05);
/** Dense broadband wall with a bass thump at 2.5 hits/sec — urban material. */
function cityFrame(time: number): Uint8Array {
  const thump = time % 0.4 < 0.08 ? 0.35 : 0;
  return spectrum((t) => 0.55 + (t < 0.125 ? thump : 0));
}
/** Rich major pad with a gentle 100-BPM-ish thump — pastoral material. */
function meadowFrame(time: number): Uint8Array {
  const thump = time % 0.6 < 0.08 ? 0.22 : 0;
  const base = chord([130.81, 164.81, 196.0, 261.63, 329.63, 392.0], 0.8, 12);
  for (let i = 0; i < 32; i++) base[i] = Math.min(255, base[i] + thump * 255);
  return base;
}

function run(
  engine: MoodEngine,
  frame: (time: number) => Uint8Array,
  seconds: number,
  startTime = 0,
) {
  let state = engine.update(frame(startTime), DT);
  const steps = Math.round(seconds / DT);
  for (let i = 1; i < steps; i++) {
    state = engine.update(frame(startTime + i * DT), DT);
  }
  return state;
}

function sortedWorlds(weights: Record<MoodWorld, number>): MoodWorld[] {
  return [...MOOD_WORLDS].sort((a, b) => weights[b] - weights[a]);
}

describe("MoodEngine", () => {
  it("keeps weights normalized across the world set", () => {
    const engine = new MoodEngine();
    const state = run(engine, (t) => cityFrame(t), 3);
    const total = MOOD_WORLDS.reduce((sum, world) => sum + state.weights[world], 0);
    expect(total).toBeCloseTo(1, 3);
    for (const world of MOOD_WORLDS) {
      expect(state.weights[world]).toBeGreaterThanOrEqual(0);
    }
  });

  it("settles near-silence into the cosmos", () => {
    const engine = new MoodEngine();
    const state = run(engine, () => calm, 8);
    expect(state.dominant).toBe("cosmos");
    expect(sortedWorlds(state.weights)[0]).toBe("cosmos");
    expect(state.arousal).toBeLessThan(0.2);
    expect(state.tension).toBeLessThan(0.15);
  });

  it("separates minor grief from major joy on the valence axis", () => {
    const griefEngine = new MoodEngine();
    const joyEngine = new MoodEngine();
    const grief = run(griefEngine, () => sad, 8);
    const joy = run(joyEngine, () => happy, 8);
    expect(grief.valence).toBeLessThan(0.45);
    expect(joy.valence).toBeGreaterThan(0.7);
    expect(joy.valence - grief.valence).toBeGreaterThan(0.25);
    // Same dynamics — the separation must come from harmony, not energy.
    expect(Math.abs(joy.arousal - grief.arousal)).toBeLessThan(0.15);
  });

  it("reads a semitone cluster as tension, not sadness alone", () => {
    const engine = new MoodEngine();
    const state = run(engine, () => tense, 8);
    expect(state.tension).toBeGreaterThan(0.5);
    expect(state.valence).toBeLessThan(0.45);
    // Quiet dread: tension is high even though arousal stays low.
    expect(state.arousal).toBeLessThan(0.3);
  });

  it("keeps consonant material low-tension", () => {
    const engine = new MoodEngine();
    const state = run(engine, () => happy, 8);
    expect(state.tension).toBeLessThan(0.3);
  });

  it("reads a warm pulsing major pad as meadow", () => {
    const engine = new MoodEngine();
    const state = run(engine, (t) => meadowFrame(t), 12);
    expect(state.dominant).toBe("meadow");
    expect(state.valence).toBeGreaterThan(0.7);
  });

  it("reads a quiet bright major chord as starlight", () => {
    const engine = new MoodEngine();
    const state = run(engine, () => happy, 12);
    expect(state.dominant).toBe("starlight");
  });

  it("reads dense pulsing material as city", () => {
    const engine = new MoodEngine();
    const state = run(engine, (t) => cityFrame(t), 12);
    expect(state.dominant).toBe("city");
    expect(state.arousal).toBeGreaterThan(0.7);
    expect(state.pulse).toBeGreaterThan(0.5);
  });

  it("detects a crescendo as build-up", () => {
    const engine = new MoodEngine();
    run(engine, () => calm, 6);
    let maxBuild = 0;
    const steps = Math.round(6 / DT);
    for (let i = 0; i < steps; i++) {
      const level = 0.08 + ((i * DT) / 6) * 0.55;
      const state = engine.update(
        spectrum(() => level),
        DT,
      );
      maxBuild = Math.max(maxBuild, state.buildUp);
    }
    expect(maxBuild).toBeGreaterThan(0.5);
  });

  it("keeps steady material free of build-up", () => {
    const engine = new MoodEngine();
    // The onset itself is a legitimate build; after that it must decay away.
    const state = run(engine, (t) => cityFrame(t), 14);
    expect(state.buildUp).toBeLessThan(0.25);
  });

  it("lets a declared minor key pull ambiguous valence down", () => {
    const neutralEngine = new MoodEngine();
    const minorEngine = new MoodEngine();
    // Weak tonality: broadband rolloff with no clear chord.
    const ambiguous = spectrum((t) => 0.3 * Math.exp(-t * 3));
    let neutral = neutralEngine.update(ambiguous, DT);
    let biased = minorEngine.update(ambiguous, DT, { intent: { modeMajor: 0 } });
    const steps = Math.round(8 / DT);
    for (let i = 1; i < steps; i++) {
      neutral = neutralEngine.update(ambiguous, DT);
      biased = minorEngine.update(ambiguous, DT, { intent: { modeMajor: 0 } });
    }
    expect(neutral.valence - biased.valence).toBeGreaterThan(0.2);
    expect(biased.valence).toBeLessThan(0.35);
  });

  it("does not flip the dominant world on a brief spike", () => {
    const engine = new MoodEngine();
    run(engine, () => calm, 8);
    const during = run(engine, (t) => cityFrame(t), 0.6);
    expect(during.dominant).toBe("cosmos");
    const after = run(engine, () => calm, 1.5);
    expect(after.dominant).toBe("cosmos");
  });

  it("flips the dominant world after a sustained change", () => {
    const engine = new MoodEngine();
    run(engine, () => calm, 8);
    const state = run(engine, (t) => cityFrame(t), 14);
    expect(state.dominant).toBe("city");
  });

  it("ignores empty frames without corrupting state", () => {
    const engine = new MoodEngine();
    run(engine, () => calm, 4);
    const state = engine.update(new Uint8Array(0), DT);
    expect(state.dominant).toBe("cosmos");
    const total = MOOD_WORLDS.reduce((sum, world) => sum + state.weights[world], 0);
    expect(total).toBeCloseTo(1, 3);
  });
});

describe("seededRandom", () => {
  it("is deterministic for a given seed", () => {
    const a = seededRandom(1234);
    const b = seededRandom(1234);
    for (let i = 0; i < 8; i++) expect(a()).toBe(b());
  });

  it("stays in [0, 1) and varies across seeds", () => {
    const a = seededRandom(1);
    const b = seededRandom(2);
    let differs = false;
    for (let i = 0; i < 64; i++) {
      const va = a();
      const vb = b();
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
      if (va !== vb) differs = true;
    }
    expect(differs).toBe(true);
  });
});
