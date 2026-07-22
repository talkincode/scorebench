import { describe, expect, it } from "vitest";
import { analyzeTraits, pickStyle, type BufferLike } from "./auto";

const SAMPLE_RATE = 44100;

function bufferFrom(fill: (index: number) => number, seconds = 3): BufferLike {
  const length = Math.floor(seconds * SAMPLE_RATE);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = fill(i);
  return {
    length,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

/** Deterministic pseudo-noise so trait tests are reproducible. */
function noise(index: number): number {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

describe("analyzeTraits", () => {
  it("measures a steady sine as tonal and dense", () => {
    const traits = analyzeTraits(bufferFrom((i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE)));
    expect(traits.energy).toBeCloseTo(0.3 / Math.SQRT2, 1);
    expect(traits.brightness).toBeLessThan(0.2);
    expect(traits.dynamics).toBeLessThan(0.2);
    expect(traits.density).toBe(1);
  });

  it("measures broadband noise as bright", () => {
    const traits = analyzeTraits(bufferFrom((i) => 0.4 * noise(i)));
    expect(traits.brightness).toBe(1);
    expect(traits.energy).toBeGreaterThan(0.18);
    expect(traits.density).toBe(1);
  });

  it("measures gated bursts as dynamic", () => {
    const period = Math.floor(SAMPLE_RATE / 2);
    const traits = analyzeTraits(bufferFrom((i) => (i % period < period / 2 ? 0.5 * noise(i) : 0)));
    expect(traits.dynamics).toBeGreaterThan(0.9);
    expect(traits.density).toBeGreaterThan(0.35);
    expect(traits.density).toBeLessThan(0.75);
  });

  it("measures silence as empty", () => {
    const traits = analyzeTraits(bufferFrom(() => 0));
    expect(traits.energy).toBe(0);
    expect(traits.density).toBe(0);
  });
});

describe("pickStyle", () => {
  it("falls back to bars without traits", () => {
    expect(pickStyle(null)).toBe("bars");
    expect(pickStyle(undefined)).toBe("bars");
  });

  it("keeps near-silence on the plain readout", () => {
    expect(pickStyle(analyzeTraits(bufferFrom(() => 0)))).toBe("bars");
    expect(pickStyle({ energy: 0.2, dynamics: 0.2, brightness: 0.3, density: 0.05 })).toBe("bars");
  });

  it("sends musical material to the mood imagery", () => {
    const sine = analyzeTraits(bufferFrom((i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE)));
    expect(pickStyle(sine)).toBe("mood");
    expect(pickStyle(analyzeTraits(bufferFrom((i) => 0.4 * noise(i))))).toBe("mood");
    const period = Math.floor(SAMPLE_RATE / 2);
    const gated = analyzeTraits(bufferFrom((i) => (i % period < period / 2 ? 0.5 * noise(i) : 0)));
    expect(pickStyle(gated)).toBe("mood");
  });
});
