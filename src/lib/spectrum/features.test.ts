import { describe, expect, it } from "vitest";
import { DEFAULT_BIN_HZ, HarmonicAnalyzer, modeFromKey } from "./features";

const BINS = 1024;
const BIN_HZ = DEFAULT_BIN_HZ; // 23.4375 — matches the app analyser

/**
 * Harmonic-series chord spectrum, piano-like rolloff. Partial energy is
 * split across the two straddling bins (linear interpolation) the way FFT
 * window leakage spreads a real tone.
 */
function chordSpectrum(fundamentals: number[], level = 0.6, harmonics = 8): Uint8Array {
  const out = new Uint8Array(BINS);
  for (const f0 of fundamentals) {
    for (let h = 1; h <= harmonics; h++) {
      const exact = (f0 * h) / BIN_HZ - 0.5; // bin centers sit at (i + 0.5) * binHz
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

const A_MINOR = chordSpectrum([220, 261.63, 329.63]); // A C E
const A_MAJOR = chordSpectrum([220, 277.18, 329.63]); // A C# E
const CLUSTER = chordSpectrum([220, 233.08, 246.94]); // A A# B
const FIFTH = chordSpectrum([220, 329.63]); // A E

describe("HarmonicAnalyzer", () => {
  it("separates major from minor triads on the mode axis", () => {
    const analyzer = new HarmonicAnalyzer();
    const major = analyzer.analyze(A_MAJOR, BIN_HZ).modeMajor;
    const minor = analyzer.analyze(A_MINOR, BIN_HZ).modeMajor;
    expect(major).toBeGreaterThan(0.55);
    expect(minor).toBeLessThan(0.45);
    expect(major - minor).toBeGreaterThan(0.2);
  });

  it("ranks a semitone cluster far rougher than an open fifth", () => {
    const analyzer = new HarmonicAnalyzer();
    const cluster = analyzer.analyze(CLUSTER, BIN_HZ).dissonance;
    const fifth = analyzer.analyze(FIFTH, BIN_HZ).dissonance;
    expect(cluster).toBeGreaterThan(fifth + 0.25);
    expect(fifth).toBeLessThan(0.3);
  });

  it("keeps triads consonant relative to the cluster", () => {
    const analyzer = new HarmonicAnalyzer();
    const cluster = analyzer.analyze(CLUSTER, BIN_HZ).dissonance;
    for (const chord of [A_MAJOR, A_MINOR]) {
      expect(analyzer.analyze(chord, BIN_HZ).dissonance).toBeLessThan(cluster);
    }
  });

  it("concentrates chroma on the sounded pitch classes", () => {
    const analyzer = new HarmonicAnalyzer();
    const { chroma, tonal } = analyzer.analyze(FIFTH, BIN_HZ);
    // A=9, E=4 dominate a bare fifth (harmonics add related classes).
    const ranked = [...chroma.keys()].sort((a, b) => chroma[b] - chroma[a]);
    expect(ranked.slice(0, 2).sort()).toEqual([4, 9]);
    expect(tonal).toBeGreaterThan(0.4);
  });

  it("reports silence and noise as atonal and mode-neutral", () => {
    const analyzer = new HarmonicAnalyzer();
    const silent = analyzer.analyze(new Uint8Array(BINS), BIN_HZ);
    expect(silent.tonal).toBe(0);
    expect(silent.modeMajor).toBe(0.5);
    expect(silent.dissonance).toBe(0);
    const noise = new Uint8Array(BINS).fill(90);
    const flat = analyzer.analyze(noise, BIN_HZ);
    expect(flat.tonal).toBeLessThan(0.15);
  });

  it("tracks brightness through the spectral centroid", () => {
    const analyzer = new HarmonicAnalyzer();
    const dark = new Uint8Array(BINS);
    const bright = new Uint8Array(BINS);
    for (let i = 0; i < BINS; i++) {
      const t = i / BINS;
      dark[i] = Math.round(200 * Math.exp(-t * 30));
      bright[i] = Math.round(200 * Math.exp(-(1 - t) * 10));
    }
    expect(analyzer.analyze(bright, BIN_HZ).centroid).toBeGreaterThan(
      analyzer.analyze(dark, BIN_HZ).centroid + 0.4,
    );
  });

  it("handles empty frames without corrupting state", () => {
    const analyzer = new HarmonicAnalyzer();
    const empty = analyzer.analyze(new Uint8Array(0), BIN_HZ);
    expect(empty.modeMajor).toBe(0.5);
    const after = analyzer.analyze(A_MAJOR, BIN_HZ);
    expect(after.modeMajor).toBeGreaterThan(0.55);
  });
});

describe("modeFromKey", () => {
  it("reads scorekit-style key strings", () => {
    expect(modeFromKey("D_minor")).toBe(0);
    expect(modeFromKey("C_major")).toBe(1);
    expect(modeFromKey("a minor")).toBe(0);
    expect(modeFromKey("Bb Major")).toBe(1);
    expect(modeFromKey("Am")).toBe(0);
    expect(modeFromKey("F#")).toBe(1);
  });

  it("returns undefined for unknown formats", () => {
    expect(modeFromKey(null)).toBeUndefined();
    expect(modeFromKey("")).toBeUndefined();
    expect(modeFromKey("dorian vibes")).toBeUndefined();
  });
});
