import { describe, expect, it } from "vitest";
import {
  fillBands,
  MIRAGE_MOTION,
  MirageBeatDynamics,
  mirageRimStrength,
  mirageSectionAngle,
  mirageShipPose,
  mirageWorldAngles,
} from "./mirage";

describe("fillBands", () => {
  it("keeps silence finite and exactly dark", () => {
    const target = new Float32Array(64);
    expect(fillBands(new Uint8Array(1024), target)).toBe(target);
    expect([...target]).toEqual(Array.from({ length: 64 }, () => 0));
  });

  it("normalizes a full-scale analyser without overshoot", () => {
    const target = fillBands(
      new Uint8Array(1024).fill(255),
      new Float32Array(64),
    );
    for (const value of target) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(Math.min(...target)).toBeCloseTo(1, 6);
  });

  it("keeps a high-frequency accent out of the low terrain columns", () => {
    const analyser = new Uint8Array(1024);
    analyser.fill(255, 300, 320);
    const target = fillBands(analyser, new Float32Array(64));

    expect(Math.max(...target.slice(0, 16))).toBe(0);
    expect(Math.max(...target.slice(32))).toBeGreaterThan(0.6);
  });
});

describe("MirageBeatDynamics", () => {
  it("moves the ship immediately but delays the engine flare by 50-100ms", () => {
    const dynamics = new MirageBeatDynamics();
    const hit = dynamics.update(0.8, 0.016);
    expect(hit.hit).toBe(true);
    expect(hit.shipThrust).toBeGreaterThan(0);
    expect(hit.engineBoost).toBe(0);

    const beforeDelay = dynamics.update(0.7, 0.03);
    expect(beforeDelay.engineBoost).toBe(0);

    const afterDelay = dynamics.update(0.6, 0.03);
    expect(afterDelay.engineBoost).toBeGreaterThan(0);
    expect(afterDelay.ringPulseProgress).toBeGreaterThan(0);
    expect(afterDelay.ringPulseProgress).toBeLessThan(1);
  });

  it("finishes the travelling ring pulse inside its short window", () => {
    const dynamics = new MirageBeatDynamics();
    dynamics.update(0.9, 0.016);
    const finished = dynamics.update(0, MIRAGE_MOTION.ringPulseSeconds + 0.01);
    expect(finished.ringPulseProgress).toBe(-1);
    expect(finished.ringPulseStrength).toBe(0);
  });

  it("expands and fades the planet-centred shockwave without scaling the sphere", () => {
    const dynamics = new MirageBeatDynamics();
    const started = dynamics.update(0.9, 0.016);
    const middle = dynamics.update(0.7, 0.5);
    const finished = dynamics.update(0, MIRAGE_MOTION.planetWaveSeconds + 0.01);

    expect(started.planetWaveProgress).toBeGreaterThanOrEqual(0);
    expect(started.planetWaveStrength).toBeGreaterThan(
      middle.planetWaveStrength,
    );
    expect(middle.planetWaveProgress).toBeGreaterThan(0);
    expect(middle.planetWaveProgress).toBeLessThan(1);
    expect(finished.planetWaveProgress).toBe(-1);
    expect(finished.planetWaveStrength).toBe(0);
  });

  it("does not turn repeated drum hits into a permanent atmosphere ring", () => {
    const dynamics = new MirageBeatDynamics();
    dynamics.update(0.9, 0.016);
    dynamics.update(0, MIRAGE_MOTION.planetWaveSeconds + 0.01);
    dynamics.update(0.9, 0.2);
    const retrigger = dynamics.update(0, 0.016);

    expect(retrigger.planetWaveProgress).toBe(-1);
    expect(retrigger.planetWaveStrength).toBe(0);
  });
});

describe("restrained cinematic motion", () => {
  it("makes the planet, blue stream and stars visibly progress at distinct rates", () => {
    const afterTwelveSeconds = mirageWorldAngles(12);

    expect(afterTwelveSeconds.planetBody).toBeGreaterThan((10 * Math.PI) / 180);
    expect(Math.abs(afterTwelveSeconds.planetParticles)).toBeGreaterThan(
      (7 * Math.PI) / 180,
    );
    expect(afterTwelveSeconds.blueStream).toBeGreaterThan((8 * Math.PI) / 180);
    expect(afterTwelveSeconds.stars).toBeGreaterThan(0);
    expect(afterTwelveSeconds.stars).toBeLessThan(
      afterTwelveSeconds.blueStream,
    );
    expect(afterTwelveSeconds.planetBody).not.toBe(
      Math.abs(afterTwelveSeconds.planetParticles),
    );
  });

  it("keeps bob, roll and yaw inside the authored limits", () => {
    for (let sample = 0; sample <= 2_000; sample++) {
      const pose = mirageShipPose(sample / 20, 1);
      expect(
        Math.abs(pose.bob) / MIRAGE_MOTION.shipModelHeight,
      ).toBeLessThanOrEqual(MIRAGE_MOTION.shipBobFraction);
      expect(Math.abs(pose.roll)).toBeLessThanOrEqual(
        MIRAGE_MOTION.shipRollRadians,
      );
      expect(Math.abs(pose.yaw)).toBeLessThanOrEqual(
        MIRAGE_MOTION.shipYawRadians,
      );
      expect(pose.forward).toBeGreaterThanOrEqual(0);
      expect(pose.forward).toBeLessThanOrEqual(0.34);
    }
  });

  it("keeps every section angle within the requested 1-3 degree language", () => {
    const worlds = ["cosmos", "starlight", "ocean", "meadow", "city"] as const;
    for (const world of worlds) {
      const weights = {
        cosmos: 0,
        starlight: 0,
        ocean: 0,
        meadow: 0,
        city: 0,
      };
      weights[world] = 1;
      expect(Math.abs(mirageSectionAngle(weights))).toBeGreaterThanOrEqual(1);
      expect(Math.abs(mirageSectionAngle(weights))).toBeLessThanOrEqual(3);
    }
  });

  it("breathes the rim gently and lets a beat brighten without scaling", () => {
    const quiet = mirageRimStrength(0, 0.3, 0.2, 0);
    const inhale = mirageRimStrength(
      MIRAGE_MOTION.rimBreathSeconds / 4,
      0.3,
      0.2,
      0,
    );
    const beat = mirageRimStrength(0, 0.3, 0.2, 1);
    expect(inhale / quiet).toBeLessThan(1.06);
    expect(inhale).toBeGreaterThan(quiet);
    expect(beat).toBeGreaterThan(inhale);
  });
});
