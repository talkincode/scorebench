/**
 * Trait-based automatic visual style selection.
 *
 * `analyzeTraits` extracts coarse, deterministic features from a decoded
 * audio buffer (no playback, no network); `pickStyle` maps them onto the
 * visual style registry. Both are pure so the mapping is unit-testable.
 */

export const AUTO_STYLE_ID = "auto";

/** Structural subset of `AudioBuffer` so tests can pass plain objects. */
export interface BufferLike {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioTraits {
  /** Mean window RMS, 0..~0.7 for typical mixes. */
  energy: number;
  /** Coefficient of variation of window RMS — punchiness. */
  dynamics: number;
  /** Normalized zero-crossing rate — spectral brightness proxy. */
  brightness: number;
  /** Fraction of windows above the audibility floor. */
  density: number;
}

const WINDOW = 1024;
const MAX_WINDOWS = 220;
const FLOOR = 0.02;

export function analyzeTraits(buffer: BufferLike): AudioTraits {
  const channels = Math.min(2, buffer.numberOfChannels);
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  const usable = Math.max(0, buffer.length - WINDOW);
  const windows = Math.min(MAX_WINDOWS, Math.max(1, Math.floor(buffer.length / WINDOW)));
  const stride = windows > 1 ? usable / (windows - 1) : 0;

  const rmsValues: number[] = [];
  let zcrSum = 0;
  for (let w = 0; w < windows; w++) {
    const start = Math.floor(w * stride);
    let sumSquares = 0;
    let crossings = 0;
    let previous = 0;
    for (let i = 0; i < WINDOW; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += data[c][start + i] ?? 0;
      sample /= channels || 1;
      sumSquares += sample * sample;
      if (i > 0 && sample * previous < 0) crossings++;
      previous = sample;
    }
    rmsValues.push(Math.sqrt(sumSquares / WINDOW));
    zcrSum += crossings / WINDOW;
  }

  const energy = rmsValues.reduce((sum, value) => sum + value, 0) / rmsValues.length;
  const variance = rmsValues.reduce((sum, value) => sum + (value - energy) ** 2, 0) / rmsValues.length;
  const dynamics = Math.min(3, Math.sqrt(variance) / Math.max(energy, 1e-4));
  const brightness = Math.min(1, (zcrSum / rmsValues.length) * 6);
  const density = rmsValues.filter((value) => value > FLOOR).length / rmsValues.length;
  return { energy, dynamics, brightness, density };
}

/**
 * Deterministic trait → style mapping. With the registry pruned to the bars
 * readout and the mood imagery, the rule is simple: anything with musical
 * content gets the atmosphere instrument; near-silence and undecodable input
 * stay on the plain readout. The trait analysis above remains the substrate
 * for emotion-affinity selection once more imageries land (roadmap M9).
 */
export function pickStyle(traits: AudioTraits | null | undefined): string {
  if (!traits) return "bars";
  if (traits.density < 0.1 || traits.energy < 0.02) return "bars";
  return "mood";
}
