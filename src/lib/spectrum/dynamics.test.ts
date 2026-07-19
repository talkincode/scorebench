import { describe, expect, it } from "vitest";
import { AudioPulse, BandSmoother, Envelope, idleSpectrum } from "./dynamics";

describe("Envelope", () => {
  it("attacks faster than it releases", () => {
    const env = new Envelope(20, 5);
    env.step(1, 0.05);
    const afterAttack = env.value;
    expect(afterAttack).toBeGreaterThan(0.5);
    env.step(0, 0.05);
    expect(env.value).toBeGreaterThan(afterAttack * 0.6);
  });

  it("converges to the target", () => {
    const env = new Envelope();
    for (let i = 0; i < 200; i++) env.step(0.8, 1 / 60);
    expect(env.value).toBeCloseTo(0.8, 2);
  });
});

describe("BandSmoother", () => {
  it("keeps band count and smooths towards input", () => {
    const smoother = new BandSmoother(4);
    const out = smoother.step([1, 0.5, 0, 0.25], 1 / 60);
    expect(out.length).toBe(4);
    expect(out[0]).toBeGreaterThan(out[1]);
    expect(out[2]).toBe(0);
  });
});

describe("AudioPulse", () => {
  it("spikes impact on a bass onset and decays afterwards", () => {
    const pulse = new AudioPulse();
    for (let i = 0; i < 60; i++) pulse.update(0.1, 0.1, 1 / 60);
    const hit = pulse.update(0.6, 0.9, 1 / 60);
    expect(hit.impact).toBeGreaterThan(0.5);
    let frame = hit;
    for (let i = 0; i < 30; i++) frame = pulse.update(0.1, 0.1, 1 / 60);
    expect(frame.impact).toBeLessThan(hit.impact * 0.25);
  });

  it("stays calm on steady sustained bass", () => {
    const pulse = new AudioPulse();
    let frame = pulse.update(0.5, 0.7, 1 / 60);
    for (let i = 0; i < 240; i++) frame = pulse.update(0.5, 0.7, 1 / 60);
    expect(frame.impact).toBeLessThan(0.2);
    expect(frame.bass).toBeCloseTo(0.7, 1);
  });
});

describe("idleSpectrum", () => {
  it("produces a quiet low-weighted spectrum in byte range", () => {
    const data = idleSpectrum(new Uint8Array(64), 2.5);
    expect(Math.max(...data)).toBeLessThanOrEqual(96);
    expect(data[0]).toBeGreaterThan(data[40]);
  });
});
