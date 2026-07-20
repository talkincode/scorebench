/**
 * Perceptual spectral features: chroma folding, mode/consonance estimation,
 * spectral centroid. Pure math over analyser byte spectra — no DOM, no
 * three.js — so the emotion mapping can see *harmony* (major/minor,
 * dissonance), not just energy. Everything here is unit-testable with
 * synthetic chord spectra.
 */

export const CHROMA_BINS = 12;

/** Default Hz-per-bin for the app's analyser (48 kHz / fftSize 2048). */
export const DEFAULT_BIN_HZ = 48000 / 2048;

/**
 * Chroma fold range: below ~400 Hz the analyser's bins (23.4 Hz at fftSize
 * 2048) are coarser than a semitone, so folding would smear neighboring
 * pitch classes — low fundamentals are represented by their harmonics.
 * Above ~5 kHz there is little tonal evidence left.
 */
const FOLD_LOW_HZ = 400;
const FOLD_HIGH_HZ = 5200;

/** Bass band used only as fuzzy *root* evidence for mode estimation. */
const BASS_LOW_HZ = 80;

export interface HarmonicFeatures {
  /** Pitch-class energy (fold band), normalized to sum 1 (zeros when silent). */
  chroma: Float32Array;
  /** 0..1 confidence that the frame carries tonal content at all. */
  tonal: number;
  /** Major-mode evidence 0..1 — 0.5 when ambiguous or atonal. */
  modeMajor: number;
  /** Psychoacoustic roughness 0..1 — semitone clusters high, open fifths low. */
  dissonance: number;
  /** Log-frequency spectral centroid 0..1 (150 Hz → 0, 8 kHz → 1). */
  centroid: number;
}

const MAJOR_THIRD = 4;
const MINOR_THIRD = 3;
const FIFTH = 7;

/**
 * Interval roughness by pitch-class distance 0..6: seconds grind, thirds and
 * fifths rest. Tuned for *relative* ordering (cluster ≫ triad ≳ fifth), not
 * psychoacoustic absolutes — at 23 Hz/bin true critical-band analysis is
 * unresolvable, so interval classes are the honest granularity.
 */
const INTERVAL_ROUGHNESS = [0, 1, 0.42, 0.11, 0.08, 0.05, 0.55];

/**
 * A strong pitch class bleeds into chromatic neighbors through FFT window
 * leakage (≤ ~25% energy after the v² weighting). Neighbor energy below this
 * fraction of the stronger class is treated as leakage, not a played note.
 */
const LEAK_FRACTION = 0.35;

interface BinMap {
  /** Nearest pitch class per bin (-1 outside the band). */
  classHard: Int8Array;
  /** Soft-assignment neighbor classes and low-class share (mode/tonal). */
  classLo: Int8Array;
  classHi: Int8Array;
  weightLo: Float32Array;
  /** 0 = outside, 1 = bass (root evidence), 2 = fold (chroma). */
  region: Uint8Array;
}

/**
 * Folds analyser byte spectra onto the 12 pitch classes and derives mode and
 * roughness. Maps are cached per (length, binHz); per-frame work is linear.
 */
export class HarmonicAnalyzer {
  private map: BinMap | null = null;
  private mapLength = 0;
  private mapBinHz = 0;
  private readonly chroma = new Float32Array(CHROMA_BINS);
  private readonly hard = new Float32Array(CHROMA_BINS);
  private readonly sharp = new Float32Array(CHROMA_BINS);
  private readonly bass = new Float32Array(CHROMA_BINS);
  private readonly rootEv = new Float32Array(CHROMA_BINS);
  private readonly features: HarmonicFeatures = {
    chroma: this.chroma,
    tonal: 0,
    modeMajor: 0.5,
    dissonance: 0,
    centroid: 0,
  };

  private ensureMap(length: number, binHz: number): BinMap {
    if (this.map && this.mapLength === length && this.mapBinHz === binHz) return this.map;
    const classHard = new Int8Array(length);
    const classLo = new Int8Array(length);
    const classHi = new Int8Array(length);
    const weightLo = new Float32Array(length);
    const region = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      const hz = (i + 0.5) * binHz;
      if (hz < BASS_LOW_HZ || hz > FOLD_HIGH_HZ) {
        classHard[i] = -1;
        classLo[i] = -1;
        classHi[i] = -1;
        continue;
      }
      region[i] = hz < FOLD_LOW_HZ ? 1 : 2;
      // Soft assignment: split between the two nearest pitch classes by
      // fractional semitone distance, so bin-center quantization near a
      // class boundary doesn't invent wrong notes.
      const midi = 69 + 12 * Math.log2(hz / 440);
      const base = Math.floor(midi);
      const frac = midi - base;
      classLo[i] = ((base % 12) + 12) % 12;
      classHi[i] = (classLo[i] + 1) % 12;
      weightLo[i] = 1 - frac;
      classHard[i] = frac < 0.5 ? classLo[i] : classHi[i];
    }
    this.map = { classHard, classLo, classHi, weightLo, region };
    this.mapLength = length;
    this.mapBinHz = binHz;
    return this.map;
  }

  /** Analyze one byte-spectrum frame (values 0..255). Reuses its buffers. */
  analyze(freq: ArrayLike<number>, binHz = DEFAULT_BIN_HZ): HarmonicFeatures {
    const n = freq.length;
    const out = this.features;
    this.chroma.fill(0);
    this.hard.fill(0);
    this.bass.fill(0);
    out.tonal = 0;
    out.modeMajor = 0.5;
    out.dissonance = 0;
    out.centroid = 0;
    if (n === 0 || binHz <= 0) return out;

    const { classHard, classLo, classHi, weightLo, region } = this.ensureMap(n, binHz);
    let centroidNum = 0;
    let centroidDen = 0;
    let folded = 0;
    let bassSum = 0;
    for (let i = 0; i < n; i++) {
      const v = (freq[i] ?? 0) / 255;
      centroidNum += i * v;
      centroidDen += v;
      const cls = classLo[i];
      if (cls < 0) continue;
      // Energy weighting sharpens peaks against the broadband floor.
      const e = v * v;
      const w = weightLo[i];
      if (region[i] === 2) {
        this.chroma[cls] += e * w;
        this.chroma[classHi[i]] += e * (1 - w);
        this.hard[classHard[i]] += e;
        folded += e;
      } else {
        this.bass[cls] += e * w;
        this.bass[classHi[i]] += e * (1 - w);
        bassSum += e;
      }
    }
    // Log-frequency centroid: perceptual brightness independent of bin
    // count and sample rate (linear-bin centroids shift with FFT layout).
    if (centroidDen > 1e-6) {
      const hz = (centroidNum / centroidDen + 0.5) * binHz;
      const t = Math.log2(Math.max(150, hz) / 150) / Math.log2(8000 / 150);
      out.centroid = Math.min(1, Math.max(0, t));
    }
    if (folded < 1e-6) return out;

    for (let c = 0; c < CHROMA_BINS; c++) {
      this.chroma[c] /= folded;
      this.hard[c] /= folded;
    }

    // Tonal confidence: how peaked the chroma is versus a flat distribution.
    let peak = 0;
    for (let c = 0; c < CHROMA_BINS; c++) peak = Math.max(peak, this.chroma[c]);
    out.tonal = Math.min(1, Math.max(0, (peak - 1 / CHROMA_BINS) * 4.2));

    out.modeMajor = this.estimateMode(bassSum, out.tonal);
    out.dissonance = this.estimateRoughness();
    return out;
  }

  /**
   * Mode via bass-anchored third contrast. For every candidate root (weighted
   * by bass evidence plus root+fifth chroma support) the major and minor
   * third energies above it are compared directly. Direct third contrast is
   * robust against the strong 3rd-harmonic fifth that dilutes whole-triad
   * template margins.
   */
  private estimateMode(bassSum: number, tonal: number): number {
    const chroma = this.chroma;
    const rootEv = this.rootEv;
    if (bassSum > 1e-6) {
      let bassMax = 0;
      for (let c = 0; c < CHROMA_BINS; c++) bassMax = Math.max(bassMax, this.bass[c]);
      for (let c = 0; c < CHROMA_BINS; c++) {
        rootEv[c] = 0.75 * (this.bass[c] / bassMax) + 0.25 * chroma[c] * CHROMA_BINS * 0.5;
      }
    } else {
      // No bass content: fall back to chroma strength as root evidence.
      for (let c = 0; c < CHROMA_BINS; c++) rootEv[c] = chroma[c] * CHROMA_BINS * 0.5;
    }
    let num = 0;
    let den = 0;
    for (let r = 0; r < CHROMA_BINS; r++) {
      const ev = rootEv[r];
      if (ev < 1e-4) continue;
      const majThird = chroma[(r + MAJOR_THIRD) % CHROMA_BINS];
      const minThird = chroma[(r + MINOR_THIRD) % CHROMA_BINS];
      const support = ev * (chroma[r] + chroma[(r + FIFTH) % CHROMA_BINS]);
      const contrast = (majThird - minThird) / (majThird + minThird + 0.02);
      num += support * contrast;
      den += support;
    }
    if (den < 1e-6) return 0.5;
    const margin = num / den;
    // Atonal frames should not express a mode opinion.
    const confidence = Math.min(1, tonal * 2);
    return Math.min(1, Math.max(0, 0.5 + margin * 1.1 * confidence));
  }

  /**
   * Roughness from interval classes on a *sharpened* hard-assigned chroma:
   * energy below LEAK_FRACTION of a chromatic neighbor is FFT leakage from
   * that neighbor, not a played note, so it cannot form a fake semitone
   * pair. Genuine clusters keep comparable energy in adjacent classes and
   * survive the sharpening.
   */
  private estimateRoughness(): number {
    const hard = this.hard;
    const sharp = this.sharp;
    for (let c = 0; c < CHROMA_BINS; c++) {
      const left = hard[(c + CHROMA_BINS - 1) % CHROMA_BINS];
      const right = hard[(c + 1) % CHROMA_BINS];
      sharp[c] = Math.max(0, hard[c] - LEAK_FRACTION * Math.max(left, right));
    }
    let rough = 0;
    let pairs = 0;
    for (let a = 0; a < CHROMA_BINS; a++) {
      const ca = sharp[a];
      if (ca < 1e-4) continue;
      for (let b = a + 1; b < CHROMA_BINS; b++) {
        const cb = sharp[b];
        if (cb < 1e-4) continue;
        const d = Math.min(b - a, CHROMA_BINS - (b - a));
        const w = ca * cb;
        rough += INTERVAL_ROUGHNESS[d] * w;
        pairs += w;
      }
    }
    return pairs > 1e-9 ? Math.min(1, (rough / pairs) * 1.8) : 0;
  }
}

/**
 * Declared mode from a scene `key` string ("D_minor", "C major", "Am") —
 * 1 major, 0 minor, undefined when the format is unrecognized. Conservative
 * by design: a wrong guess is worse than no prior.
 */
export function modeFromKey(key: string | null | undefined): number | undefined {
  if (!key) return undefined;
  const k = key.trim().toLowerCase();
  if (/(min|moll)/.test(k)) return 0;
  if (/(maj|dur)/.test(k)) return 1;
  if (/^[a-g][#b♯♭]?m$/.test(k)) return 0;
  if (/^[a-g][#b♯♭]?$/.test(k)) return 1;
  return undefined;
}
