import { describe, expect, it } from "vitest";
import {
  neutralMoodState,
  type MoodState,
  type MoodWorld,
  type WeatherMode,
} from "./mood";
import {
  CRUISE_BASE,
  CRUISE_MAX,
  DAGGER_BOW_Z,
  DAGGER_STERN_Z,
  ENGINE_BEAT_RELEASE_SECONDS,
  ENGINE_CORE_DIAMETER_RATIO,
  ENGINE_GLOW_WIDTH_RATIO,
  ENGINE_JET_LENGTH_DIAMETERS,
  ENGINE_PARTICLE_FLOW_SPEED,
  ENGINE_PARTICLE_OPACITY,
  LOGO_BREATH_PERIOD_SECONDS,
  SHIP_BOW_Z,
  SHIP_STERN_Z,
  VOYAGE_PARALLAX_RATES,
  attackRelease,
  bezier3,
  bowToSternFlowU,
  compressLevel,
  cruiseSpeed,
  daggerProfile,
  daggerU,
  engineBeatEnvelope,
  engineCoreBrightnessScale,
  engineJetLengthScale,
  helixPoints,
  hullProfile,
  hullRadius,
  logoBreathLevel,
  logoGlowOpacity,
  parallaxDepth,
  parallaxEdgeFade,
  robotPose,
  samplePath,
  shipU,
  stagePhase,
  voyageAtmosphere,
  voyageStateWeights,
  wrapCoord,
  type RobotPose,
} from "./voyage";

const CALM = { arousal: 0, pulse: 0, buildUp: 0, swell: 0 };
const FULL = { arousal: 1, pulse: 1, buildUp: 1, swell: 1 };

function sceneMood(
  world: MoodWorld,
  weather: WeatherMode,
  axes: Partial<Pick<MoodState, "arousal" | "valence" | "tension" | "buildUp" | "swell" | "wind">> = {},
): MoodState {
  const state = neutralMoodState();
  for (const key of Object.keys(state.weights) as MoodWorld[]) state.weights[key] = key === world ? 1 : 0;
  for (const key of Object.keys(state.weather) as WeatherMode[]) {
    state.weather[key] = key === weather ? 1 : 0;
  }
  state.dominant = world;
  state.weatherMode = weather;
  return Object.assign(state, axes);
}

describe("cruiseSpeed", () => {
  it("keeps drifting forward in silence", () => {
    expect(cruiseSpeed(CALM)).toBeCloseTo(CRUISE_BASE);
    expect(cruiseSpeed(CALM)).toBeGreaterThan(0);
  });

  it("is monotone in every axis and clamped at full burn", () => {
    let previous = cruiseSpeed(CALM);
    for (const axis of ["arousal", "pulse", "buildUp", "swell"] as const) {
      const next = cruiseSpeed({ ...CALM, [axis]: 1 });
      expect(next).toBeGreaterThan(cruiseSpeed(CALM));
      previous = Math.max(previous, next);
    }
    expect(cruiseSpeed(FULL, 1)).toBe(CRUISE_MAX);
  });

  it("kicks on impact and ignores negative swell", () => {
    expect(cruiseSpeed(CALM, 0.8)).toBeGreaterThan(cruiseSpeed(CALM));
    expect(cruiseSpeed({ ...CALM, swell: -1 })).toBeCloseTo(cruiseSpeed(CALM));
  });
});

describe("wrapCoord", () => {
  it("wraps past the far edge back to the near edge", () => {
    expect(wrapCoord(12, -10, 10)).toBeCloseTo(-8);
    expect(wrapCoord(-13, -10, 10)).toBeCloseTo(7);
  });

  it("keeps in-range values untouched", () => {
    expect(wrapCoord(3, -10, 10)).toBeCloseTo(3);
  });

  it("degrades safely on an empty span", () => {
    expect(wrapCoord(5, 2, 2)).toBe(2);
  });
});

describe("hull logo breathing light", () => {
  it("breathes smoothly from dim to bright and returns to dim", () => {
    expect(logoBreathLevel(0)).toBeCloseTo(0);
    expect(logoBreathLevel(LOGO_BREATH_PERIOD_SECONDS / 4)).toBeCloseTo(0.5);
    expect(logoBreathLevel(LOGO_BREATH_PERIOD_SECONDS / 2)).toBeCloseTo(1);
    expect(logoBreathLevel(LOGO_BREATH_PERIOD_SECONDS)).toBeCloseTo(0);
  });

  it("stays at a steady midpoint when reduced motion is requested", () => {
    expect(logoBreathLevel(0, true)).toBe(0.5);
    expect(logoBreathLevel(42, true)).toBe(0.5);
  });

  it("remains visible in silence and lets a beat accent the crest without clipping", () => {
    const dim = logoGlowOpacity(0, 0, 0);
    const bright = logoGlowOpacity(1, 0, 0);
    const accented = logoGlowOpacity(1, 1, 1);
    expect(dim).toBeGreaterThan(0.08);
    expect(bright).toBeGreaterThan(dim);
    expect(accented).toBeGreaterThan(bright);
    expect(accented).toBeLessThanOrEqual(1);
  });
});

describe("voyage parallax", () => {
  it("keeps every depth plane ordered from celestial light to near dust", () => {
    expect(VOYAGE_PARALLAX_RATES.farStars).toBeLessThan(VOYAGE_PARALLAX_RATES.brightStars);
    expect(VOYAGE_PARALLAX_RATES.brightStars).toBeLessThan(VOYAGE_PARALLAX_RATES.deepGas);
    expect(VOYAGE_PARALLAX_RATES.deepGas).toBeLessThan(VOYAGE_PARALLAX_RATES.landmarks);
    expect(VOYAGE_PARALLAX_RATES.landmarks).toBeLessThan(VOYAGE_PARALLAX_RATES.nearDust);
  });

  it("streams toward the camera and recycles behind the far plane", () => {
    expect(parallaxDepth(-500, 100, 0.1, -600, -200)).toBeCloseTo(-490);
    expect(parallaxDepth(-210, 200, 0.1, -600, -200)).toBeCloseTo(-590);
    expect(parallaxDepth(-500, -100, 0.1, -600, -200)).toBeCloseTo(-500);
  });

  it("fades landmarks at recycling boundaries but not through the flight corridor", () => {
    expect(parallaxEdgeFade(-600, -600, -200, 40)).toBe(0);
    expect(parallaxEdgeFade(-580, -600, -200, 40)).toBeCloseTo(0.5);
    expect(parallaxEdgeFade(-400, -600, -200, 40)).toBe(1);
    expect(parallaxEdgeFade(-200, -600, -200, 40)).toBe(0);
  });
});

describe("bowToSternFlowU", () => {
  it("moves continuously from the bow toward the stern", () => {
    expect(bowToSternFlowU(0, 0.25)).toBe(1);
    expect(bowToSternFlowU(1, 0.25)).toBeCloseTo(0.75);
    expect(bowToSternFlowU(2, 0.25)).toBeCloseTo(0.5);
  });

  it("wraps back to the bow and supports lane phase offsets", () => {
    expect(bowToSternFlowU(4, 0.25)).toBe(1);
    expect(bowToSternFlowU(0, 0.25, 0.2)).toBeCloseTo(0.8);
  });
});

describe("hull silhouette", () => {
  it("maps stern and bow onto the u axis", () => {
    expect(shipU(SHIP_STERN_Z)).toBe(0);
    expect(shipU(SHIP_BOW_Z)).toBe(1);
  });

  it("flares midship and tapers to a ram bow", () => {
    const stern = hullProfile(0.05);
    const mid = hullProfile(0.35);
    const bow = hullProfile(1);
    expect(mid.halfWidth).toBeGreaterThan(stern.halfWidth);
    expect(mid.halfWidth).toBeGreaterThan(bow.halfWidth);
    expect(bow.halfWidth).toBeLessThan(stern.halfWidth + 1);
  });

  it("keeps the clearance envelope positive along the ship", () => {
    for (let u = 0; u <= 1; u += 0.1) expect(hullRadius(u)).toBeGreaterThan(0);
  });
});

describe("helixPoints", () => {
  it("runs stern to bow while clearing the hull", () => {
    const points = helixPoints(64, 2.5, 0.4, 1.2);
    expect(points).toHaveLength(64 * 3);
    expect(points[2]).toBeCloseTo(SHIP_STERN_Z);
    expect(points[63 * 3 + 2]).toBeCloseTo(SHIP_BOW_Z);
    for (let i = 0; i < 64; i++) {
      const x = points[i * 3];
      const y = points[i * 3 + 1];
      const z = points[i * 3 + 2];
      const clearance = Math.hypot(x, y / 0.82) - hullRadius(shipU(z));
      expect(clearance).toBeGreaterThan(1.2 - 1e-6);
    }
  });

  it("is deterministic per phase", () => {
    expect(helixPoints(16, 2, 1.1, 1)).toEqual(helixPoints(16, 2, 1.1, 1));
    expect(helixPoints(16, 2, 1.1, 1)).not.toEqual(helixPoints(16, 2, 2.3, 1));
  });
});

describe("samplePath", () => {
  const path = new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0]);
  const out = new Float32Array(3);

  it("interpolates linearly inside segments", () => {
    samplePath(path, 0.25, out);
    expect([...out]).toEqual([5, 0, 0]);
    samplePath(path, 0.75, out);
    expect([...out]).toEqual([10, 10, 0]);
  });

  it("clamps beyond both ends", () => {
    samplePath(path, -1, out);
    expect([...out]).toEqual([0, 0, 0]);
    samplePath(path, 2, out);
    expect([...out]).toEqual([10, 20, 0]);
  });
});

describe("robotPose", () => {
  const params = {
    centerZ: -6,
    radiusX: 9,
    radiusY: 7,
    spanZ: 14,
    freqX: 0.31,
    freqY: 0.43,
    freqZ: 0.17,
    phaseX: 0.2,
    phaseY: 1.4,
    phaseZ: 2.6,
  };
  const pose: RobotPose = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, hullDistance: 0 };

  it("stays inside its bounding box forever", () => {
    for (let t = 0; t < 600; t += 1.7) {
      robotPose(t, params, pose);
      expect(Math.abs(pose.x)).toBeLessThanOrEqual(params.radiusX + 1e-6);
      expect(Math.abs(pose.y)).toBeLessThanOrEqual(params.radiusY + 1e-6);
      expect(Math.abs(pose.z - params.centerZ)).toBeLessThanOrEqual(params.spanZ + 1e-6);
    }
  });

  it("reports an analytic velocity consistent with finite differences", () => {
    const eps = 1e-4;
    const a: RobotPose = { ...pose };
    const b: RobotPose = { ...pose };
    robotPose(10, params, a);
    robotPose(10 + eps, params, b);
    expect((b.x - a.x) / eps).toBeCloseTo(a.vx, 2);
    expect((b.y - a.y) / eps).toBeCloseTo(a.vy, 2);
    expect((b.z - a.z) / eps).toBeCloseTo(a.vz, 2);
  });

  it("is deterministic and measures hull clearance", () => {
    const again: RobotPose = { ...pose };
    robotPose(42, params, pose);
    robotPose(42, params, again);
    expect(again).toEqual(pose);
    expect(Number.isFinite(pose.hullDistance)).toBe(true);
  });
});

describe("daggerProfile", () => {
  it("tapers to a ram bow and carries its mass aft", () => {
    const bow = daggerProfile(1);
    const stern = daggerProfile(0);
    const beam = daggerProfile(0.18);
    expect(bow.halfWidth).toBeLessThan(2);
    expect(bow.halfHeight).toBeLessThan(1.5);
    expect(beam.halfWidth).toBeGreaterThan(stern.halfWidth);
    expect(beam.halfWidth).toBeGreaterThan(10);
  });

  it("is continuous — no jagged silhouette steps", () => {
    let prev = daggerProfile(0);
    for (let i = 1; i <= 200; i++) {
      const next = daggerProfile(i / 200);
      expect(Math.abs(next.halfWidth - prev.halfWidth)).toBeLessThan(0.6);
      expect(Math.abs(next.halfHeight - prev.halfHeight)).toBeLessThan(0.4);
      expect(Math.abs(next.mid - prev.mid)).toBeLessThan(0.2);
      prev = next;
    }
  });

  it("maps dagger z to u across the long hull", () => {
    expect(daggerU(DAGGER_STERN_Z)).toBe(0);
    expect(daggerU(DAGGER_BOW_Z)).toBe(1);
    expect(daggerU((DAGGER_STERN_Z + DAGGER_BOW_Z) / 2)).toBeCloseTo(0.5);
  });
});

describe("attackRelease", () => {
  it("rises fast and falls slow", () => {
    const up = attackRelease(0, 1, 0.05, 0.04, 0.5);
    const down = attackRelease(1, 0, 0.05, 0.04, 0.5);
    expect(up).toBeGreaterThan(0.6);
    expect(down).toBeGreaterThan(0.85);
  });

  it("converges to the target and never overshoots", () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = attackRelease(v, 0.8, 1 / 60, 0.05, 0.4);
    expect(v).toBeCloseTo(0.8, 3);
    expect(attackRelease(0.2, 0.5, 100, 0.01, 0.01)).toBeLessThanOrEqual(0.5);
  });
});

describe("engine optics", () => {
  it("keeps every fixed optical proportion inside the design bounds", () => {
    expect(ENGINE_CORE_DIAMETER_RATIO).toBeGreaterThanOrEqual(0.25);
    expect(ENGINE_CORE_DIAMETER_RATIO).toBeLessThanOrEqual(0.35);
    expect(ENGINE_JET_LENGTH_DIAMETERS * 0.8).toBeGreaterThanOrEqual(2.5);
    expect(ENGINE_JET_LENGTH_DIAMETERS * 1.2).toBeLessThanOrEqual(4);
    expect(ENGINE_GLOW_WIDTH_RATIO).toBeGreaterThanOrEqual(1.5);
    expect(ENGINE_GLOW_WIDTH_RATIO).toBeLessThanOrEqual(2);
    expect(ENGINE_PARTICLE_OPACITY).toBe(0.3);
  });

  it("maps bass to jet length only within ±20%", () => {
    expect(engineJetLengthScale(0)).toBeCloseTo(0.8);
    expect(engineJetLengthScale(0.5)).toBeCloseTo(1);
    expect(engineJetLengthScale(1)).toBeCloseTo(1.2);
    expect(engineJetLengthScale(-1)).toBeCloseTo(0.8);
    expect(engineJetLengthScale(2)).toBeCloseTo(1.2);
  });

  it("maps overall energy to core brightness only within ±15%", () => {
    expect(engineCoreBrightnessScale(0)).toBeCloseTo(0.85);
    expect(engineCoreBrightnessScale(0.5)).toBeCloseTo(1);
    expect(engineCoreBrightnessScale(1)).toBeCloseTo(1.15);
  });

  it("runs embedded exhaust particles at five times wall-clock", () => {
    expect(ENGINE_PARTICLE_FLOW_SPEED).toBe(5);
  });

  it("shapes each beat as a fast brightness pulse with a 100 ms release", () => {
    expect(ENGINE_BEAT_RELEASE_SECONDS).toBeGreaterThanOrEqual(0.08);
    expect(ENGINE_BEAT_RELEASE_SECONDS).toBeLessThanOrEqual(0.12);
    let pulse = engineBeatEnvelope(0, true, 1 / 60);
    expect(pulse).toBeGreaterThan(0.8);
    const peak = pulse;
    for (let i = 0; i < 6; i++) pulse = engineBeatEnvelope(pulse, false, 1 / 60);
    expect(pulse).toBeLessThan(peak);
    expect(pulse).toBeGreaterThan(0);
  });
});

describe("voyageAtmosphere", () => {
  it("turns every emotion world into a distinct navigation-sector hue", () => {
    const hues = (["cosmos", "starlight", "ocean", "meadow", "city"] as const).map(
      (world) => Math.round(voyageAtmosphere(sceneMood(world, "clear")).hueShift),
    );
    expect(new Set(hues).size).toBe(hues.length);
  });

  it("turns misty ocean material into local gas and dark dust", () => {
    const clear = voyageAtmosphere(sceneMood("starlight", "clear"));
    const mist = voyageAtmosphere(sceneMood("ocean", "mist"));
    expect(mist.nebula).toBeGreaterThan(clear.nebula);
    expect(mist.dust).toBeGreaterThan(clear.dust);
    expect(mist.starClarity).toBeLessThan(clear.starClarity);
  });

  it("separates rain debris, snow crystals, and tense ion storms", () => {
    const clear = voyageAtmosphere(sceneMood("cosmos", "clear"));
    const rain = voyageAtmosphere(sceneMood("city", "rain", { wind: 0.8 }));
    const snow = voyageAtmosphere(sceneMood("starlight", "snow"));
    const storm = voyageAtmosphere(
      sceneMood("cosmos", "storm", { arousal: 0.9, tension: 0.95, buildUp: 0.8 }),
    );
    expect(rain.debris).toBeGreaterThan(clear.debris);
    expect(snow.ice).toBeGreaterThan(rain.ice);
    expect(storm.ion).toBeGreaterThan(0.8);
    expect(storm.cameraTremor).toBeGreaterThan(clear.cameraTremor);
    expect(storm.travelScale).toBeGreaterThan(clear.travelScale);
    expect(storm.bloom).toBeGreaterThan(clear.bloom);
  });
});

describe("compressLevel", () => {
  it("is monotone, zero at zero, and saturates below one", () => {
    expect(compressLevel(0)).toBe(0);
    let prev = 0;
    for (let x = 0.1; x <= 4; x += 0.1) {
      const y = compressLevel(x);
      expect(y).toBeGreaterThan(prev);
      expect(y).toBeLessThan(1);
      prev = y;
    }
    expect(compressLevel(0.5)).toBeGreaterThan(0.5);
  });
});

describe("voyageStateWeights", () => {
  const out = new Float32Array(4);

  it("partitions unity across the whole trend range", () => {
    for (let t = 0; t <= 1; t += 0.02) {
      const w = voyageStateWeights(t, 0, out);
      const sum = w[0] + w[1] + w[2] + w[3];
      expect(sum).toBeCloseTo(1, 5);
      for (let i = 0; i < 4; i++) expect(w[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("hands off dormant → cruise → charged → transcend", () => {
    expect(voyageStateWeights(0, 0, out)[0]).toBeCloseTo(1);
    expect(voyageStateWeights(0.35, 0, out)[1]).toBeGreaterThan(0.8);
    expect(voyageStateWeights(0.68, 0, out)[2]).toBeGreaterThan(0.8);
    expect(voyageStateWeights(1, 0, out)[3]).toBeCloseTo(1);
  });

  it("lets a surge lean toward transcend early", () => {
    const calm = voyageStateWeights(0.8, 0, out)[3];
    const surged = voyageStateWeights(0.8, 1, new Float32Array(4))[3];
    expect(surged).toBeGreaterThan(calm);
  });
});

describe("bezier3", () => {
  const controls = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 10, 10, 10]);
  const out = new Float32Array(3);

  it("hits the endpoints exactly", () => {
    bezier3(controls, 0, out);
    expect([...out]).toEqual([0, 0, 0]);
    bezier3(controls, 1, out);
    expect([...out]).toEqual([10, 10, 10]);
  });

  it("stays inside the control hull and clamps t", () => {
    bezier3(controls, 0.5, out);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
    }
    bezier3(controls, 2, out);
    expect([...out]).toEqual([10, 10, 10]);
  });
});

describe("stagePhase", () => {
  const durations = [4, 8, 6, 3.5, 4];
  const out = { index: 0, u: 0 };

  it("walks the program in order and loops", () => {
    expect(stagePhase(0, durations, out).index).toBe(0);
    expect(stagePhase(4.1, durations, out).index).toBe(1);
    expect(stagePhase(12.1, durations, out).index).toBe(2);
    expect(stagePhase(25.5 + 0.1, durations, out).index).toBe(0);
  });

  it("reports normalized progress inside a stage", () => {
    stagePhase(6, durations, out);
    expect(out.index).toBe(1);
    expect(out.u).toBeCloseTo(0.25);
    stagePhase(-1, durations, out);
    expect(out.index).toBe(4);
  });
});
