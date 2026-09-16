import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { AudioPulse, BandSmoother } from "../dynamics";
import { neutralMoodState, seededRandom } from "../mood";
import { bassLevel, createShell, energyLevel, glowTexture } from "./common";
import { createMoodHud } from "./moodHud";
import type { ThreeFrame, ThreeInstance } from "./types";

/**
 * Mirage — cinematic particle world.
 *
 * The scene is built as real 3D first: an occluding planet, a physical ring
 * plane, a foreground interceptor, and a perspective terrain. Particles then
 * describe those surfaces and their energy. They never have to fake an object
 * by tracing a flat pictogram.
 *
 * Music mapping:
 * - spectrum -> terrain relief and local brightness
 * - bass     -> terrain breathing and engine volume
 * - impact   -> engine flare and a forward terrain pulse
 * - V/A/T    -> camera drive, ring motion, and atmospheric balance
 */

const SEED = 0x7363_6f72;
const BLOOM_LAYER = 1;
const BANDS = 64;
const TERRAIN_COLS = 220;
const TERRAIN_ROWS = 110;
const TERRAIN_COUNT = TERRAIN_COLS * TERRAIN_ROWS;
const PLANET_PARTICLES = 6_400;
const RING_PARTICLES = 72_000;
const STAR_COUNT = 1_800;
const SWIRL_PARTICLES = 7_200;
const TRAIL_PARTICLES = 760;
const FOREGROUND_DUST_COUNT = 36;
const RING_SPARK_COUNT = 48;
const TAU = Math.PI * 2;
const RING_TILT_X = 0.16;
const RING_TILT_Z = 0.52;

export const MIRAGE_MOTION = {
  planetBodyRadiansPerSecond: 0.018,
  planetPatternRadiansPerSecond: 0.0045,
  planetParticleRadiansPerSecond: -0.012,
  blueStreamRadiansPerSecond: 0.014,
  starFieldRadiansPerSecond: 0.0015,
  rimBreathSeconds: 8,
  shipModelHeight: 5.8,
  shipBobFraction: 0.015,
  shipRollRadians: THREE.MathUtils.degToRad(0.9),
  shipYawRadians: THREE.MathUtils.degToRad(0.42),
  engineDelaySeconds: 0.075,
  ringPulseSeconds: 0.42,
  planetWaveSeconds: 1.2,
  planetWaveCooldownSeconds: 3.6,
  cameraPushDistance: 0.85,
  cameraShakePixels: 0.1,
} as const;

const TERRAIN_VERTEX = /* glsl */ `
attribute float aSeed;
uniform sampler2D uBands;
uniform float uTime;
uniform float uEnergy;
uniform float uBass;
uniform float uImpact;
uniform float uPointScale;
varying vec3 vColor;
varying float vAlpha;
varying float vPeak;

void main() {
  vec3 p = position;
  p.x += (aSeed - 0.5) * 1.06;
  p.z += (fract(aSeed * 17.37) - 0.5) * 0.96;
  float lateral = clamp(p.x / 124.0 + 0.5, 0.0, 1.0);
  float depth = clamp((-p.z - 12.0) / 104.0, 0.0, 1.0);
  float band = texture2D(uBands, vec2(pow(lateral, 1.7), 0.5)).r;

  float longWave =
    sin(p.x * 0.085 + p.z * 0.052 + uTime * 0.26) * 1.7 +
    sin(p.x * 0.19 - p.z * 0.073 - uTime * 0.18) * 0.8;
  float ridges = sin(p.x * 0.42 + p.z * 0.115 + aSeed * 4.0) * 0.32;
  float perspectiveGain = mix(2.8, 0.72, depth);
  float music = band * (1.8 + uEnergy * 7.2) * perspectiveGain;
  float bassBreath = uBass * sin(p.z * 0.055 - uTime * 0.7) * 2.4;

  float pulseCentre = 14.0 + fract(uTime * 0.19) * 98.0;
  float pulse = exp(-abs((-p.z) - pulseCentre) * 0.13) * uImpact;
  p.y += longWave + ridges + music + bassBreath + pulse * 5.5;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float cameraDepth = -mv.z;
  float nearFade = smoothstep(16.0, 30.0, cameraDepth);
  float farFade = 1.0 - smoothstep(120.0, 182.0, cameraDepth);
  float grain = smoothstep(0.975, 1.0, fract(aSeed * 31.17));
  float peak = clamp(
    band * 0.78 + pulse * 0.7 + max(0.0, longWave) * 0.045 + grain * 0.5,
    0.0,
    1.0
  );
  vec3 shadow = vec3(0.004, 0.01, 0.026);
  vec3 steel = vec3(0.032, 0.13, 0.3);
  vec3 ice = vec3(0.36, 0.64, 0.98);
  float ridgeLight = smoothstep(0.18, 0.9, peak + max(0.0, longWave) * 0.055);
  vColor = mix(shadow, steel, 0.22 + ridgeLight * 0.68);
  vColor = mix(vColor, ice, smoothstep(0.72, 1.0, peak) * 0.74);
  vAlpha = nearFade * farFade * (0.18 + ridgeLight * 0.7);
  vPeak = peak;

  float pointSize = (0.78 + peak * 1.72 + aSeed * 0.36) *
    (230.0 / max(38.0, cameraDepth)) * uPointScale;
  gl_PointSize = min(4.6, pointSize);
}
`;

const TERRAIN_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vPeak;

void main() {
  vec2 q = gl_PointCoord - vec2(0.5);
  float r = length(q) * 2.0;
  if (r > 1.0) discard;
  float core = pow(max(0.0, 1.0 - r), 4.0);
  float halo = pow(max(0.0, 1.0 - r), 1.7);
  gl_FragColor = vec4(vColor * (0.75 + core * (0.8 + vPeak)), (core + halo * 0.24) * vAlpha);
}
`;

const PLANET_VERTEX = /* glsl */ `
attribute vec3 aNormal;
attribute float aSeed;
uniform float uTime;
uniform float uEnergy;
uniform float uHue;
uniform float uPointScale;
uniform vec3 uRingNormal;
varying vec3 vColor;
varying float vAlpha;

vec3 hsl2rgb(vec3 hsl) {
  vec3 rgb = clamp(
    abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
    0.0,
    1.0
  );
  rgb = rgb * rgb * (3.0 - 2.0 * rgb);
  float chroma = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  return (rgb - 0.5) * chroma + hsl.z;
}

void main() {
  vec3 p = position;
  p += aNormal * sin(uTime * (0.22 + aSeed * 0.24) + aSeed * 20.0) * (0.08 + uEnergy * 0.24);
  vec4 world = modelMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;

  vec3 worldNormal = normalize(mat3(modelMatrix) * aNormal);
  vec3 viewDirection = normalize(cameraPosition - world.xyz);
  vec3 lightDirection = normalize(vec3(-0.7, 0.4, 0.9));
  float facing = max(0.0, dot(worldNormal, viewDirection));
  float rim = pow(1.0 - facing, 2.4);
  float silhouetteMask = smoothstep(0.075, 0.28, facing);
  float light = max(0.0, dot(worldNormal, lightDirection));
  float sparkle = smoothstep(0.9, 1.0, sin(uTime * (0.7 + aSeed) + aSeed * 54.0) * 0.5 + 0.5);
  float surface = smoothstep(0.72, 0.97, sin(aSeed * 91.7) * 0.5 + 0.5);
  float hue = fract(uHue + 0.045 + aSeed * 0.025);
  vec3 base = hsl2rgb(vec3(hue, 0.62, 0.2 + rim * 0.28 + light * 0.08));
  vec3 warm = vec3(1.0, 0.48, 0.15);
  vec3 hot = vec3(0.9, 0.95, 1.0);
  vColor = mix(base, warm, light * surface * 0.54);
  vColor = mix(vColor, hot, rim * sparkle * 0.34);
  vAlpha = (
    0.002 +
    light * surface * 0.082 +
    sparkle * (0.012 + light * 0.052)
  ) * silhouetteMask;
  float ringClearance = smoothstep(
    0.025,
    0.095,
    abs(dot(normalize(aNormal), normalize(uRingNormal)))
  );
  vAlpha *= smoothstep(0.0, 0.42, ringClearance);

  float size = (0.42 + light * 0.48 + sparkle * 0.46) *
    (220.0 / max(40.0, -mv.z)) * uPointScale;
  gl_PointSize = min(2.8, size);
}
`;

const POINT_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 q = gl_PointCoord - vec2(0.5);
  float r = length(q) * 2.0;
  if (r > 1.0) discard;
  float core = pow(max(0.0, 1.0 - r), 4.5);
  float halo = pow(max(0.0, 1.0 - r), 2.0);
  gl_FragColor = vec4(vColor * (0.8 + core * 1.25), (core + halo * 0.28) * vAlpha);
}
`;

const RING_VERTEX = /* glsl */ `
attribute vec3 color;
attribute float aFlow;
attribute float aSeed;
uniform float uTime;
uniform float uEnergy;
uniform float uPulseProgress;
uniform float uPulseStrength;
uniform float uPointScale;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  float flowPhase = fract(aFlow - uTime * (0.016 + uEnergy * 0.007));
  float pinprick = pow(max(0.0, sin((flowPhase + aSeed * 0.07) * 56.5487)), 18.0);
  float pulseDistance = abs(aFlow - uPulseProgress);
  float pulse = exp(-pulseDistance * pulseDistance * 360.0) * uPulseStrength;
  float sparkle = smoothstep(0.94, 1.0, sin(uTime * (1.3 + aSeed) + aSeed * 61.0) * 0.5 + 0.5);

  vColor = color * (0.68 + pinprick * 1.35 + pulse * 2.5 + sparkle * 0.34);
  vAlpha = 0.48 + pinprick * 0.36 + pulse * 0.52;
  float size = (0.46 + pinprick * 0.72 + pulse * 1.6 + sparkle * 0.2) *
    (220.0 / max(42.0, -mv.z)) * uPointScale;
  gl_PointSize = min(4.2, size);
}
`;

const RING_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord - vec2(0.5);
  float r = length(q) * 2.0;
  if (r > 1.0) discard;
  float core = pow(max(0.0, 1.0 - r), 4.2);
  float halo = pow(max(0.0, 1.0 - r), 1.8);
  gl_FragColor = vec4(vColor * (0.72 + core * 1.25), (core + halo * 0.2) * vAlpha);
}
`;

const SWIRL_VERTEX = /* glsl */ `
attribute vec3 color;
attribute float aFlow;
attribute float aSeed;
attribute float aSpeed;
uniform float uTime;
uniform float uEnergy;
uniform float uPointScale;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 p = position;
  float travel = uTime * aSpeed;
  mat2 orbit = mat2(
    cos(travel), -sin(travel),
    sin(travel), cos(travel)
  );
  p.xz = orbit * p.xz;
  p.y += sin(
    uTime * (0.24 + aSeed * 0.13) +
    aFlow * 12.5664 +
    aSeed * 19.0
  ) * (0.22 + aSeed * 0.34);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float flowPhase = fract(aFlow - uTime * (0.032 + aSeed * 0.009));
  float packet = pow(max(0.0, sin(flowPhase * 18.8496)), 10.0);
  float shimmer = sin(uTime * (0.7 + aSeed) + aSeed * 47.0) * 0.5 + 0.5;
  vColor = color * (0.7 + packet * 1.18 + shimmer * 0.26 + uEnergy * 0.26);
  vAlpha = 0.38 + packet * 0.44 + shimmer * 0.16;
  float size = (0.58 + aSeed * 0.36 + packet * 0.72) *
    (220.0 / max(42.0, -mv.z)) * uPointScale;
  gl_PointSize = min(4.2, size);
}
`;

const SWIRL_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord - vec2(0.5);
  float r = length(q) * 2.0;
  if (r > 1.0) discard;
  float core = pow(max(0.0, 1.0 - r), 4.0);
  float halo = pow(max(0.0, 1.0 - r), 1.8);
  gl_FragColor = vec4(vColor * (0.78 + core * 1.2), (core + halo * 0.22) * vAlpha);
}
`;

const STAR_VERTEX = /* glsl */ `
attribute vec3 color;
attribute float aSeed;
attribute float aSize;
uniform float uTime;
uniform float uEnergy;
uniform float uPointScale;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  float wave = sin(
    uTime * (0.55 + aSeed * 1.9) +
    aSeed * 91.7
  ) * 0.5 + 0.5;
  float glint = pow(wave, 12.0);
  vColor = color * (0.34 + wave * 0.76 + glint * 1.25 + uEnergy * 0.08);
  vAlpha = 0.2 + wave * 0.52 + glint * 0.24;
  float size = (0.36 + aSize * 0.48 + glint * 1.25) *
    (190.0 / max(64.0, -mv.z)) * uPointScale;
  gl_PointSize = min(3.8, size);
}
`;

const STAR_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord - vec2(0.5);
  float r = length(q) * 2.0;
  if (r > 1.0) discard;
  float core = pow(max(0.0, 1.0 - r), 5.0);
  float halo = pow(max(0.0, 1.0 - r), 2.0);
  gl_FragColor = vec4(vColor * (0.72 + core * 1.4), (core + halo * 0.18) * vAlpha);
}
`;

const FOREGROUND_DUST_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aSeed;
uniform float uTime;
uniform float uDrive;
uniform float uPointScale;
varying float vLight;
varying float vAlpha;

void main() {
  vec3 p = position;
  float speed = 0.22 + aSeed * 0.22 + uDrive * 0.8;
  p.z = 22.0 + mod((position.z - 22.0) + uTime * speed, 42.0);
  p.x += sin(uTime * (0.08 + aSeed * 0.07) + aSeed * 17.0) * 0.7;
  p.y += cos(uTime * (0.06 + aSeed * 0.05) + aSeed * 23.0) * 0.45;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mv;
  gl_Position = clip;
  vec2 screen = clip.xy / max(0.001, clip.w);
  float distanceToBand = abs(screen.y - (screen.x * 0.62 + 0.02));
  vLight = smoothstep(0.2, 0.025, distanceToBand);
  vAlpha = 0.012 + vLight * (0.07 + aSeed * 0.045);
  gl_PointSize = min(
    24.0,
    aSize * (115.0 / max(6.0, -mv.z)) * uPointScale
  );
}
`;

const FOREGROUND_DUST_FRAGMENT = /* glsl */ `
varying float vLight;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord - vec2(0.5);
  float r = length(q) * 2.0;
  if (r > 1.0) discard;
  float blur = exp(-r * r * 2.4);
  vec3 shadow = vec3(0.035, 0.045, 0.075);
  vec3 lit = vec3(0.72, 0.46, 0.18);
  gl_FragColor = vec4(mix(shadow, lit, vLight * 0.42), blur * vAlpha);
}
`;

const PLANET_WAVE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const PLANET_WAVE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uProgress;
uniform float uStrength;
uniform vec2 uRingNormal2D;
varying vec2 vUv;
void main() {
  vec2 q = vUv - vec2(0.5);
  float radius = length(q);
  float eased = 1.0 - pow(1.0 - clamp(uProgress, 0.0, 1.0), 2.0);
  float waveRadius = mix(0.305, 0.67, eased);
  float width = mix(0.046, 0.024, eased);
  float shell = exp(
    -pow((radius - waveRadius) / max(0.001, width), 2.0)
  );
  float outerMist = exp(
    -pow((radius - waveRadius - width * 1.7) / max(0.001, width * 2.6), 2.0)
  );
  float bandDistance = abs(dot(q, normalize(uRingNormal2D)));
  float bandClearance = smoothstep(0.018, 0.058, bandDistance);
  float alpha = (shell * 0.052 + outerMist * 0.012) *
    uStrength * mix(0.18, 1.0, bandClearance);
  gl_FragColor = vec4(uColor * (0.54 + shell * 0.62), alpha);
}
`;

const PLANET_BODY_VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vLocal;

void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vLocal = position;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const PLANET_BODY_FRAGMENT = /* glsl */ `
uniform vec3 uDeep;
uniform vec3 uCool;
uniform vec3 uWarm;
uniform float uDarkAngle;
uniform float uGoldAngle;
uniform float uRimStrength;
uniform vec3 uRingNormal;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vLocal;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(hash31(cell), hash31(cell + vec3(1.0, 0.0, 0.0)), f.x),
      mix(
        hash31(cell + vec3(0.0, 1.0, 0.0)),
        hash31(cell + vec3(1.0, 1.0, 0.0)),
        f.x
      ),
      f.y
    ),
    mix(
      mix(
        hash31(cell + vec3(0.0, 0.0, 1.0)),
        hash31(cell + vec3(1.0, 0.0, 1.0)),
        f.x
      ),
      mix(
        hash31(cell + vec3(0.0, 1.0, 1.0)),
        hash31(cell + vec3(1.0, 1.0, 1.0)),
        f.x
      ),
      f.y
    ),
    f.z
  );
}

float fbm3(vec3 p) {
  float value = 0.0;
  float amplitude = 0.54;
  for (int octave = 0; octave < 4; octave++) {
    value += noise3(p) * amplitude;
    p = p * 2.03 + vec3(7.1, 3.7, 5.9);
    amplitude *= 0.47;
  }
  return value;
}

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDirection = normalize(cameraPosition - vWorld);
  vec3 lightDirection = normalize(vec3(-0.78, 0.34, 0.52));
  vec3 halfDirection = normalize(lightDirection + viewDirection);
  float light = max(0.0, dot(normal, lightDirection));
  float rim = pow(1.0 - max(0.0, dot(normal, viewDirection)), 3.6);
  float ringClearance = smoothstep(
    0.02,
    0.085,
    abs(dot(normalize(vLocal), normalize(uRingNormal)))
  );
  mat2 darkRotation = mat2(
    cos(uDarkAngle), -sin(uDarkAngle),
    sin(uDarkAngle), cos(uDarkAngle)
  );
  mat2 goldRotation = mat2(
    cos(uGoldAngle), -sin(uGoldAngle),
    sin(uGoldAngle), cos(uGoldAngle)
  );
  vec3 darkLocal = vLocal;
  vec3 goldLocal = vLocal;
  darkLocal.xz = darkRotation * darkLocal.xz;
  goldLocal.xz = goldRotation * goldLocal.xz;
  vec3 sphere = normalize(darkLocal);
  float continentField =
    fbm3(sphere * 2.15 + vec3(2.7, 8.1, 4.3)) * 0.68 +
    fbm3(sphere * 4.7 + vec3(11.4, 1.8, 7.6)) * 0.25 +
    noise3(sphere * 12.8 + vec3(5.2, 14.6, 3.1)) * 0.07;
  float land = smoothstep(0.52, 0.595, continentField);
  float coast = 1.0 - smoothstep(
    0.012,
    0.052,
    abs(continentField - 0.557)
  );
  float landDetail = fbm3(sphere * 9.2 + vec3(3.4, 17.1, 9.8));
  float mountain = land * smoothstep(0.62, 0.82, landDetail);
  float oceanDetail = fbm3(sphere * 6.4 + vec3(13.2, 5.5, 2.1));
  float lakeField = fbm3(sphere * 5.8 + vec3(21.7, 4.2, 16.3));
  float lake = smoothstep(0.7, 0.78, lakeField) *
    smoothstep(0.72, 0.94, land);

  vec3 gp = normalize(goldLocal);
  float emberField =
    (sin(dot(gp, vec3(18.7, 11.1, 23.9))) * 0.5 + 0.5) *
    (sin(dot(gp, vec3(-13.3, 21.7, 9.5)) + 1.7) * 0.5 + 0.5) *
    (sin(dot(gp, vec3(7.9, -17.5, 19.1)) + 3.2) * 0.5 + 0.5);
  float ember = smoothstep(0.82, 1.0, emberField) * land * (1.0 - lake);

  vec3 ocean = vec3(0.005, 0.006, 0.011) +
    vec3(0.008, 0.011, 0.019) * oceanDetail;
  vec3 continent = vec3(0.012, 0.008, 0.007) +
    vec3(0.045, 0.022, 0.011) *
      (0.24 + landDetail * 0.52 + mountain * 0.34);
  vec3 lakeColor = vec3(0.002, 0.003, 0.007) + uCool * 0.002;
  vec3 color = mix(ocean, continent, land);
  color = mix(color, lakeColor, lake);
  color *= 0.5 + light * 0.74;
  float oceanGlint = pow(max(0.0, dot(normal, halfDirection)), 42.0) *
    (1.0 - land);
  color += vec3(0.11, 0.14, 0.2) * oceanGlint * 0.13;
  color += uWarm * coast * (0.002 + light * 0.006);
  color += uCool * (
    rim * uRimStrength * smoothstep(0.0, 0.46, ringClearance) +
    oceanDetail * light * (1.0 - land) * 0.004
  );
  color += uWarm * ember * 0.07 * (0.18 + light * 0.82);
  gl_FragColor = vec4(color, 1.0);
}
`;

export interface MirageBeatFrame {
  hit: boolean;
  shipThrust: number;
  engineBoost: number;
  ringPulseProgress: number;
  ringPulseStrength: number;
  planetWaveProgress: number;
  planetWaveStrength: number;
}

/**
 * Separates the physical response of a hit from the engine's delayed flare.
 * The renderer feeds it the already-smoothed bass-onset envelope.
 */
export class MirageBeatDynamics {
  private previousImpact = 0;
  private cooldown = 0;
  private pendingEngineDelay = -1;
  private pendingEngineStrength = 0;
  private shipThrust = 0;
  private engineBoost = 0;
  private ringPulseAge = Number.POSITIVE_INFINITY;
  private planetWaveAge = Number.POSITIVE_INFINITY;
  private planetWaveCooldown = 0;

  update(impact: number, dt: number): MirageBeatFrame {
    const delta = Math.max(0, dt);
    this.cooldown = Math.max(0, this.cooldown - delta);
    this.planetWaveCooldown = Math.max(0, this.planetWaveCooldown - delta);
    const hit =
      impact > 0.22 &&
      impact > this.previousImpact + 0.035 &&
      this.cooldown <= 0;
    this.previousImpact = impact;

    if (hit) {
      this.cooldown = 0.11;
      this.pendingEngineDelay = MIRAGE_MOTION.engineDelaySeconds;
      this.pendingEngineStrength = impact;
      this.shipThrust = Math.max(this.shipThrust, impact);
      this.ringPulseAge = 0;
      if (this.planetWaveCooldown <= 0) {
        this.planetWaveAge = 0;
        this.planetWaveCooldown = MIRAGE_MOTION.planetWaveCooldownSeconds;
      }
    }

    if (this.pendingEngineDelay >= 0) {
      this.pendingEngineDelay -= delta;
      if (this.pendingEngineDelay <= 0) {
        this.engineBoost = Math.max(
          this.engineBoost,
          this.pendingEngineStrength,
        );
        this.pendingEngineDelay = -1;
        this.pendingEngineStrength = 0;
      }
    }

    this.shipThrust *= Math.exp(-delta / 0.12);
    this.engineBoost *= Math.exp(-delta / 0.18);
    this.ringPulseAge += delta;
    this.planetWaveAge += delta;
    const ringActive = this.ringPulseAge <= MIRAGE_MOTION.ringPulseSeconds;
    const planetWaveActive =
      this.planetWaveAge <= MIRAGE_MOTION.planetWaveSeconds;
    const planetWaveProgress = planetWaveActive
      ? this.planetWaveAge / MIRAGE_MOTION.planetWaveSeconds
      : -1;

    return {
      hit,
      shipThrust: this.shipThrust,
      engineBoost: this.engineBoost,
      ringPulseProgress: ringActive
        ? this.ringPulseAge / MIRAGE_MOTION.ringPulseSeconds
        : -1,
      ringPulseStrength: ringActive ? Math.exp(-this.ringPulseAge / 0.28) : 0,
      planetWaveProgress,
      planetWaveStrength: planetWaveActive
        ? Math.pow(1 - Math.max(0, planetWaveProgress), 1.65)
        : 0,
    };
  }
}

export interface MirageShipPose {
  bob: number;
  roll: number;
  yaw: number;
  forward: number;
}

export interface MirageWorldAngles {
  planetBody: number;
  planetParticles: number;
  blueStream: number;
  stars: number;
}

export function mirageWorldAngles(
  elapsed: number,
  target: MirageWorldAngles = {
    planetBody: 0,
    planetParticles: 0,
    blueStream: 0,
    stars: 0,
  },
): MirageWorldAngles {
  const time = Math.max(0, elapsed);
  target.planetBody = time * MIRAGE_MOTION.planetBodyRadiansPerSecond;
  target.planetParticles = time * MIRAGE_MOTION.planetParticleRadiansPerSecond;
  target.blueStream = time * MIRAGE_MOTION.blueStreamRadiansPerSecond;
  target.stars = time * MIRAGE_MOTION.starFieldRadiansPerSecond;
  return target;
}

export function mirageShipPose(
  elapsed: number,
  shipThrust: number,
  target: MirageShipPose = { bob: 0, roll: 0, yaw: 0, forward: 0 },
): MirageShipPose {
  target.bob =
    Math.sin(elapsed * 0.68) *
    MIRAGE_MOTION.shipModelHeight *
    MIRAGE_MOTION.shipBobFraction;
  target.roll = Math.sin(elapsed * 0.31 + 0.4) * MIRAGE_MOTION.shipRollRadians;
  target.yaw = Math.sin(elapsed * 0.19 + 1.1) * MIRAGE_MOTION.shipYawRadians;
  target.forward = Math.max(0, Math.min(1, shipThrust)) * 0.34;
  return target;
}

export function mirageSectionAngle(weights: {
  cosmos: number;
  starlight: number;
  ocean: number;
  meadow: number;
  city: number;
}): number {
  return (
    weights.cosmos * -1.2 +
    weights.starlight * 1 +
    weights.ocean * -2 +
    weights.meadow * 1.6 +
    weights.city * 2.4
  );
}

export function mirageRimStrength(
  elapsed: number,
  energy: number,
  buildUp: number,
  beatStrength: number,
): number {
  const breath =
    1 + Math.sin((elapsed / MIRAGE_MOTION.rimBreathSeconds) * TAU) * 0.055;
  return (
    (0.074 + energy * 0.055 + buildUp * 0.025) * breath +
    Math.max(0, beatStrength) * 0.12
  );
}

export function fillBands(
  freq: Uint8Array,
  target: Float32Array,
): Float32Array {
  const usable = Math.max(2, Math.floor(freq.length * 0.78));
  for (let band = 0; band < target.length; band++) {
    const from = Math.floor(Math.pow(band / target.length, 2.1) * usable);
    const to = Math.max(
      from + 1,
      Math.floor(Math.pow((band + 1) / target.length, 2.1) * usable),
    );
    let peak = 0;
    let sum = 0;
    for (let bin = from; bin < to; bin++) {
      const value = (freq[bin] ?? 0) / 255;
      peak = Math.max(peak, value);
      sum += value;
    }
    target[band] = peak * 0.7 + (sum / (to - from)) * 0.3;
  }
  return target;
}

function hullGeometry(): THREE.BufferGeometry {
  const vertices = new Float32Array([
    0, 0.3, -10.5, -2.2, 1.05, -2.2, 2.2, 1.05, -2.2, -3.1, 0.68, 4.8, 3.1,
    0.68, 4.8, 0, 1.72, 2.8, 0, -1.5, -1.4, -2.25, -1.08, 4.8, 2.25, -1.08, 4.8,
  ]);
  const index = [
    0, 1, 2, 1, 5, 2, 1, 3, 5, 5, 3, 4, 5, 4, 2, 0, 6, 1, 0, 2, 6, 1, 6, 7, 1,
    7, 3, 2, 4, 8, 2, 8, 6, 6, 8, 7, 7, 8, 4, 7, 4, 3,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

function wingGeometry(side: -1 | 1): THREE.BufferGeometry {
  const s = side;
  const vertices = new Float32Array([
    s * 1.1,
    0.38,
    -2.4,
    s * 10.5,
    0.06,
    3.2,
    s * 4.2,
    0.18,
    6,
    s * 1.7,
    -0.68,
    4.4,
    s * 1.1,
    -0.58,
    -2.1,
    s * 9.4,
    -0.5,
    3.15,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 1, 4, 1, 0, 1, 5, 2, 5, 3, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

function createEngineTrail(
  rand: () => number,
  x: number,
  map: THREE.Texture,
): {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  phases: Float32Array;
  speeds: Float32Array;
  radialX: Float32Array;
  radialY: Float32Array;
  engineX: number;
} {
  const positions = new Float32Array(TRAIL_PARTICLES * 3);
  const colors = new Float32Array(TRAIL_PARTICLES * 3);
  const phases = new Float32Array(TRAIL_PARTICLES);
  const speeds = new Float32Array(TRAIL_PARTICLES);
  const radialX = new Float32Array(TRAIL_PARTICLES);
  const radialY = new Float32Array(TRAIL_PARTICLES);
  for (let index = 0; index < TRAIL_PARTICLES; index++) {
    const phase = rand();
    const angle = rand() * TAU;
    const radial = Math.pow(rand(), 1.9);
    phases[index] = phase;
    speeds[index] = 0.82 + rand() * 0.36;
    radialX[index] = Math.cos(angle) * radial;
    radialY[index] = Math.sin(angle) * radial;
    positions[index * 3] = x;
    positions[index * 3 + 1] = -0.35;
    positions[index * 3 + 2] = 6.1 + phase * 12;
    colors[index * 3] = 0.18;
    colors[index * 3 + 1] = 0.5;
    colors[index * 3 + 2] = 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    map,
    vertexColors: true,
    size: 0.34,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.26,
    alphaTest: 0.02,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.layers.enable(BLOOM_LAYER);
  return {
    points,
    material,
    phases,
    speeds,
    radialX,
    radialY,
    engineX: x,
  };
}

export function create(canvas: HTMLCanvasElement): ThreeInstance {
  const shell = createShell(canvas, 50);
  const { renderer, scene, camera } = shell;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  scene.background = new THREE.Color("#010207");
  camera.near = 0.1;
  camera.far = 500;
  camera.updateProjectionMatrix();

  const rand = seededRandom(SEED);
  const glowTextureMap = glowTexture(64);
  const moodHud = createMoodHud();
  const fallbackMood = neutralMoodState();

  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(1, 1),
    0.34,
    0.32,
    0.42,
  );
  bloomComposer.addPass(bloomPass);

  const finalComposer = new EffectComposer(renderer);
  if (renderer.capabilities.isWebGL2) {
    // EffectComposer renders through off-screen targets, so the renderer's
    // canvas antialias flag alone does not smooth the planet silhouette.
    finalComposer.renderTarget1.samples = 4;
    finalComposer.renderTarget2.samples = 4;
  }
  finalComposer.addPass(new RenderPass(scene, camera));
  finalComposer.addPass(
    new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          baseTexture: { value: null },
          bloomTexture: { value: bloomComposer.renderTarget2.texture },
        },
        vertexShader:
          "varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
        fragmentShader:
          "uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv; void main(){ gl_FragColor=texture2D(baseTexture,vUv)+texture2D(bloomTexture,vUv); }",
      }),
      "baseTexture",
    ),
  );
  finalComposer.addPass(new OutputPass());

  const ambient = new THREE.HemisphereLight(0x6a79a8, 0x03040a, 0.42);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffdcc0, 1.45);
  key.position.set(-40, 30, 50);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x588cff, 1.15);
  rim.position.set(50, 10, -20);
  scene.add(rim);

  const bandBytes = new Uint8Array(BANDS);
  const bandTexture = new THREE.DataTexture(
    bandBytes,
    BANDS,
    1,
    THREE.RedFormat,
  );
  bandTexture.minFilter = THREE.LinearFilter;
  bandTexture.magFilter = THREE.LinearFilter;
  bandTexture.needsUpdate = true;

  // -----------------------------------------------------------------------
  // Perspective particle terrain
  // -----------------------------------------------------------------------
  const terrainPositions = new Float32Array(TERRAIN_COUNT * 3);
  const terrainSeeds = new Float32Array(TERRAIN_COUNT);
  for (let row = 0; row < TERRAIN_ROWS; row++) {
    const depth = row / (TERRAIN_ROWS - 1);
    const z = 16 - depth * 118;
    for (let col = 0; col < TERRAIN_COLS; col++) {
      const index = row * TERRAIN_COLS + col;
      terrainPositions[index * 3] = (col / (TERRAIN_COLS - 1) - 0.5) * 124;
      terrainPositions[index * 3 + 1] = -15;
      terrainPositions[index * 3 + 2] = z;
      terrainSeeds[index] = rand();
    }
  }
  const terrainGeometry = new THREE.BufferGeometry();
  terrainGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(terrainPositions, 3),
  );
  terrainGeometry.setAttribute(
    "aSeed",
    new THREE.BufferAttribute(terrainSeeds, 1),
  );

  const terrainUniforms = {
    uBands: { value: bandTexture },
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uBass: { value: 0 },
    uImpact: { value: 0 },
    uPointScale: { value: 1 },
  };
  const terrainPointMaterial = new THREE.ShaderMaterial({
    uniforms: terrainUniforms,
    vertexShader: TERRAIN_VERTEX,
    fragmentShader: TERRAIN_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const terrainPoints = new THREE.Points(terrainGeometry, terrainPointMaterial);
  terrainPoints.layers.enable(BLOOM_LAYER);
  scene.add(terrainPoints);

  // -----------------------------------------------------------------------
  // Ringed planet: physical occluder + particle skin + real ring plane
  // -----------------------------------------------------------------------
  const planet = new THREE.Group();
  planet.position.set(17, 9, -42);
  planet.rotation.z = -0.06;
  scene.add(planet);

  const planetRadius = 19.5;
  const ringPlaneNormal = new THREE.Vector3(0, 1, 0)
    .applyEuler(new THREE.Euler(RING_TILT_X, 0, RING_TILT_Z))
    .normalize();
  const planetBodyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uDeep: { value: new THREE.Color("#050207") },
      uCool: { value: new THREE.Color("#3f57b8") },
      uWarm: { value: new THREE.Color("#ff8b35") },
      uDarkAngle: { value: 0 },
      uGoldAngle: { value: 0 },
      uRimStrength: { value: 0.08 },
      uRingNormal: { value: ringPlaneNormal },
    },
    vertexShader: PLANET_BODY_VERTEX,
    fragmentShader: PLANET_BODY_FRAGMENT,
  });
  const planetBody = new THREE.Mesh(
    new THREE.SphereGeometry(planetRadius, 128, 80),
    planetBodyMaterial,
  );
  // Keep the opaque body in the bloom pass as a dark depth occluder. Without
  // it, the bloom-only camera sees the far half of the ring through the planet.
  planetBody.layers.enable(BLOOM_LAYER);
  planetBody.renderOrder = 2;
  planet.add(planetBody);

  const planetWaveMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color("#61708a") },
      uProgress: { value: 0 },
      uStrength: { value: 0 },
      uRingNormal2D: { value: new THREE.Vector2(-0.5, 0.866) },
    },
    vertexShader: PLANET_WAVE_VERTEX,
    fragmentShader: PLANET_WAVE_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  const planetWave = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 64),
    planetWaveMaterial,
  );
  planetWave.position.copy(planet.position);
  planetWave.quaternion.copy(camera.quaternion);
  planetWave.visible = false;
  planetWave.renderOrder = 0;
  scene.add(planetWave);

  const planetParticlePositions = new Float32Array(PLANET_PARTICLES * 3);
  const planetNormals = new Float32Array(PLANET_PARTICLES * 3);
  const planetSeeds = new Float32Array(PLANET_PARTICLES);
  for (let index = 0; index < PLANET_PARTICLES; index++) {
    const y = rand() * 2 - 1;
    const angle = rand() * TAU;
    const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
    const nx = Math.cos(angle) * ringRadius;
    const nz = Math.sin(angle) * ringRadius;
    const radius = planetRadius * (1.006 + (rand() - 0.5) * 0.018);
    planetParticlePositions[index * 3] = nx * radius;
    planetParticlePositions[index * 3 + 1] = y * radius;
    planetParticlePositions[index * 3 + 2] = nz * radius;
    planetNormals[index * 3] = nx;
    planetNormals[index * 3 + 1] = y;
    planetNormals[index * 3 + 2] = nz;
    planetSeeds[index] = rand();
  }
  const planetParticleGeometry = new THREE.BufferGeometry();
  planetParticleGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(planetParticlePositions, 3),
  );
  planetParticleGeometry.setAttribute(
    "aNormal",
    new THREE.BufferAttribute(planetNormals, 3),
  );
  planetParticleGeometry.setAttribute(
    "aSeed",
    new THREE.BufferAttribute(planetSeeds, 1),
  );
  const planetParticleUniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uHue: { value: 215 / 360 },
    uPointScale: { value: 1 },
    uRingNormal: { value: ringPlaneNormal },
  };
  const planetParticleMaterial = new THREE.ShaderMaterial({
    uniforms: planetParticleUniforms,
    vertexShader: PLANET_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const planetParticlePoints = new THREE.Points(
    planetParticleGeometry,
    planetParticleMaterial,
  );
  planetParticlePoints.layers.enable(BLOOM_LAYER);
  planetParticlePoints.renderOrder = 2;
  planet.add(planetParticlePoints);

  const ringPositions = new Float32Array(RING_PARTICLES * 3);
  const ringColors = new Float32Array(RING_PARTICLES * 3);
  const ringFlows = new Float32Array(RING_PARTICLES);
  const ringSeeds = new Float32Array(RING_PARTICLES);
  const ringShadow = new THREE.Color("#8b3e17");
  const ringGold = new THREE.Color("#ff9b3d");
  const ringWhite = new THREE.Color("#fff0c8");
  const ringColor = new THREE.Color();
  for (let index = 0; index < RING_PARTICLES; index++) {
    // Concentrate most samples into the bright inner body, then let the final
    // third fall away as a loose particulate halo. This reads as one energy
    // volume instead of a handful of evenly spaced orbital lanes.
    const band = Math.pow(rand(), 1.42);
    const radius = 23 + band * 13.8 + (rand() - 0.5) * 0.72;
    const flare = index < Math.floor(RING_PARTICLES * 0.2);
    const angle = flare
      ? (rand() < 0.5 ? 0 : Math.PI) + (rand() - 0.5) * 0.42
      : rand() * TAU;
    ringPositions[index * 3] = Math.cos(angle) * radius;
    ringPositions[index * 3 + 1] =
      (rand() + rand() + rand() - 1.5) * (0.38 + band * 0.62);
    ringPositions[index * 3 + 2] = Math.sin(angle) * radius;
    const heat = 0.58 + rand() * 0.42;
    ringColor.copy(ringShadow).lerp(ringGold, heat);
    if (rand() > 0.972) ringColor.lerp(ringWhite, 0.9);
    ringColors[index * 3] = ringColor.r;
    ringColors[index * 3 + 1] = ringColor.g;
    ringColors[index * 3 + 2] = ringColor.b;
    ringFlows[index] = Math.cos(angle) * 0.5 + 0.5;
    ringSeeds[index] = rand();
  }
  const ringGeometry = new THREE.BufferGeometry();
  ringGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(ringPositions, 3),
  );
  ringGeometry.setAttribute("color", new THREE.BufferAttribute(ringColors, 3));
  ringGeometry.setAttribute("aFlow", new THREE.BufferAttribute(ringFlows, 1));
  ringGeometry.setAttribute("aSeed", new THREE.BufferAttribute(ringSeeds, 1));
  const ringUniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uPulseProgress: { value: -1 },
    uPulseStrength: { value: 0 },
    uPointScale: { value: 1 },
  };
  const ringMaterial = new THREE.ShaderMaterial({
    uniforms: ringUniforms,
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ringSystem = new THREE.Group();
  ringSystem.rotation.x = RING_TILT_X;
  ringSystem.rotation.z = RING_TILT_Z;
  planet.add(ringSystem);

  const ringPoints = new THREE.Points(ringGeometry, ringMaterial);
  ringPoints.layers.enable(BLOOM_LAYER);
  ringPoints.renderOrder = 4;
  ringSystem.add(ringPoints);

  const ringSparkPositions = new Float32Array(RING_SPARK_COUNT * 3);
  const ringSparkHome = new Float32Array(RING_SPARK_COUNT * 3);
  const ringSparkColors = new Float32Array(RING_SPARK_COUNT * 3);
  const ringSparkVelocity = new Float32Array(RING_SPARK_COUNT * 3);
  const ringSparkSeeds = new Float32Array(RING_SPARK_COUNT);
  for (let index = 0; index < RING_SPARK_COUNT; index++) {
    const seed = rand();
    ringSparkSeeds[index] = seed;
    ringSparkPositions[index * 3] = 36 + (rand() - 0.5) * 1.4;
    ringSparkPositions[index * 3 + 1] = (rand() - 0.5) * 0.28;
    ringSparkPositions[index * 3 + 2] = (rand() - 0.5) * 1.4;
    ringSparkHome[index * 3] = ringSparkPositions[index * 3];
    ringSparkHome[index * 3 + 1] = ringSparkPositions[index * 3 + 1];
    ringSparkHome[index * 3 + 2] = ringSparkPositions[index * 3 + 2];
    ringSparkVelocity[index * 3] = 0.7 + rand() * 1.6;
    ringSparkVelocity[index * 3 + 1] = (rand() - 0.35) * 2.6;
    ringSparkVelocity[index * 3 + 2] = (rand() - 0.5) * 2.2;
    ringSparkColors[index * 3] = 1;
    ringSparkColors[index * 3 + 1] = 0.55;
    ringSparkColors[index * 3 + 2] = 0.16;
  }
  const ringSparkGeometry = new THREE.BufferGeometry();
  const ringSparkPositionAttribute = new THREE.BufferAttribute(
    ringSparkPositions,
    3,
  );
  const ringSparkColorAttribute = new THREE.BufferAttribute(ringSparkColors, 3);
  ringSparkGeometry.setAttribute("position", ringSparkPositionAttribute);
  ringSparkGeometry.setAttribute("color", ringSparkColorAttribute);
  const ringSparkMaterial = new THREE.PointsMaterial({
    map: glowTextureMap,
    vertexColors: true,
    size: 0.34,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
    alphaTest: 0.015,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ringSparks = new THREE.Points(ringSparkGeometry, ringSparkMaterial);
  ringSparks.layers.enable(BLOOM_LAYER);
  ringSparks.renderOrder = 4;
  ringSystem.add(ringSparks);

  // Broad blue-violet streams bind the planet to the frame. They are sparse
  // arcs, not fog sprites, so the eye can follow their perspective.
  const swirlPositions = new Float32Array(SWIRL_PARTICLES * 3);
  const swirlColors = new Float32Array(SWIRL_PARTICLES * 3);
  const swirlFlows = new Float32Array(SWIRL_PARTICLES);
  const swirlSeeds = new Float32Array(SWIRL_PARTICLES);
  const swirlSpeeds = new Float32Array(SWIRL_PARTICLES);
  const swirlBlue = new THREE.Color("#285dff");
  const swirlViolet = new THREE.Color("#7a38dc");
  const swirlColor = new THREE.Color();
  for (let index = 0; index < SWIRL_PARTICLES; index++) {
    const arm = index % 3;
    const t = rand();
    const angle = t * TAU * 1.38 + arm * (TAU / 3) + (rand() - 0.5) * 0.08;
    const radius = 34 + t * 28 + (rand() - 0.5) * 2.8;
    swirlPositions[index * 3] = Math.cos(angle) * radius;
    swirlPositions[index * 3 + 1] =
      Math.sin(angle * 0.56 + arm) * (6 + t * 7) + (rand() - 0.5) * 2.4;
    swirlPositions[index * 3 + 2] =
      Math.sin(angle) * radius * 0.72 + (rand() - 0.5) * 2.2;
    swirlColor.copy(swirlBlue).lerp(swirlViolet, 0.28 + t * 0.58);
    const level = 0.36 + rand() * 0.64;
    swirlColors[index * 3] = swirlColor.r * level;
    swirlColors[index * 3 + 1] = swirlColor.g * level;
    swirlColors[index * 3 + 2] = swirlColor.b * level;
    swirlFlows[index] = t;
    swirlSeeds[index] = rand();
    swirlSpeeds[index] = 0.016 + arm * 0.0035 + rand() * 0.0045;
  }
  const swirlGeometry = new THREE.BufferGeometry();
  swirlGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(swirlPositions, 3),
  );
  swirlGeometry.setAttribute(
    "color",
    new THREE.BufferAttribute(swirlColors, 3),
  );
  swirlGeometry.setAttribute("aFlow", new THREE.BufferAttribute(swirlFlows, 1));
  swirlGeometry.setAttribute("aSeed", new THREE.BufferAttribute(swirlSeeds, 1));
  swirlGeometry.setAttribute(
    "aSpeed",
    new THREE.BufferAttribute(swirlSpeeds, 1),
  );
  const swirlUniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uPointScale: { value: 1 },
  };
  const swirlMaterial = new THREE.ShaderMaterial({
    uniforms: swirlUniforms,
    vertexShader: SWIRL_VERTEX,
    fragmentShader: SWIRL_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const swirlPoints = new THREE.Points(swirlGeometry, swirlMaterial);
  swirlPoints.rotation.set(0.18, -0.08, -0.16);
  swirlPoints.layers.enable(BLOOM_LAYER);
  planet.add(swirlPoints);

  // -----------------------------------------------------------------------
  // Background field and nebula masses
  // -----------------------------------------------------------------------
  const starPositions = new Float32Array(STAR_COUNT * 3);
  const starColors = new Float32Array(STAR_COUNT * 3);
  const starSeeds = new Float32Array(STAR_COUNT);
  const starSizes = new Float32Array(STAR_COUNT);
  const starColor = new THREE.Color();
  for (let index = 0; index < STAR_COUNT; index++) {
    starPositions[index * 3] = (rand() * 2 - 1) * 135;
    starPositions[index * 3 + 1] = -10 + rand() * 85;
    starPositions[index * 3 + 2] = -55 - rand() * 180;
    const roll = rand();
    starColor.set(
      roll > 0.96 ? "#ffd7ac" : roll > 0.83 ? "#9db6ff" : "#d8e2f0",
    );
    const level = 0.28 + rand() * 0.72;
    starColors[index * 3] = starColor.r * level;
    starColors[index * 3 + 1] = starColor.g * level;
    starColors[index * 3 + 2] = starColor.b * level;
    starSeeds[index] = rand();
    starSizes[index] =
      rand() > 0.94 ? 1.35 + rand() * 0.65 : 0.35 + rand() * 0.55;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(starPositions, 3),
  );
  starGeometry.setAttribute("color", new THREE.BufferAttribute(starColors, 3));
  starGeometry.setAttribute("aSeed", new THREE.BufferAttribute(starSeeds, 1));
  starGeometry.setAttribute("aSize", new THREE.BufferAttribute(starSizes, 1));
  const starUniforms = {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uPointScale: { value: 1 },
  };
  const starMaterial = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.layers.enable(BLOOM_LAYER);
  scene.add(stars);

  const nebulae: THREE.Sprite[] = [];
  const nebulaDefinitions = [
    { x: 48, y: 23, z: -90, sx: 80, sy: 32, color: "#4434b8", opacity: 0.12 },
    { x: -42, y: 8, z: -82, sx: 74, sy: 24, color: "#114ab5", opacity: 0.1 },
    { x: 12, y: 37, z: -120, sx: 96, sy: 26, color: "#6e2eb3", opacity: 0.075 },
    { x: 12, y: -4, z: -72, sx: 118, sy: 19, color: "#3e4574", opacity: 0.065 },
    { x: 28, y: -9, z: -58, sx: 92, sy: 15, color: "#70411f", opacity: 0.04 },
  ];
  for (const definition of nebulaDefinitions) {
    const material = new THREE.SpriteMaterial({
      map: glowTextureMap,
      color: definition.color,
      transparent: true,
      opacity: definition.opacity,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(definition.x, definition.y, definition.z);
    sprite.scale.set(definition.sx, definition.sy, 1);
    sprite.layers.enable(BLOOM_LAYER);
    nebulae.push(sprite);
    scene.add(sprite);
  }

  // A very small near-camera layer buys more depth than another distant
  // particle cloud. It stays almost black unless it crosses the ring's
  // projected diagonal.
  const foregroundDustPositions = new Float32Array(FOREGROUND_DUST_COUNT * 3);
  const foregroundDustSizes = new Float32Array(FOREGROUND_DUST_COUNT);
  const foregroundDustSeeds = new Float32Array(FOREGROUND_DUST_COUNT);
  for (let index = 0; index < FOREGROUND_DUST_COUNT; index++) {
    foregroundDustPositions[index * 3] = (rand() * 2 - 1) * 54;
    foregroundDustPositions[index * 3 + 1] = (rand() * 2 - 1) * 29;
    foregroundDustPositions[index * 3 + 2] = 22 + rand() * 42;
    foregroundDustSizes[index] = 1.8 + rand() * 4.8;
    foregroundDustSeeds[index] = rand();
  }
  const foregroundDustGeometry = new THREE.BufferGeometry();
  foregroundDustGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(foregroundDustPositions, 3),
  );
  foregroundDustGeometry.setAttribute(
    "aSize",
    new THREE.BufferAttribute(foregroundDustSizes, 1),
  );
  foregroundDustGeometry.setAttribute(
    "aSeed",
    new THREE.BufferAttribute(foregroundDustSeeds, 1),
  );
  const foregroundDustUniforms = {
    uTime: { value: 0 },
    uDrive: { value: 0 },
    uPointScale: { value: 1 },
  };
  const foregroundDustMaterial = new THREE.ShaderMaterial({
    uniforms: foregroundDustUniforms,
    vertexShader: FOREGROUND_DUST_VERTEX,
    fragmentShader: FOREGROUND_DUST_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const foregroundDust = new THREE.Points(
    foregroundDustGeometry,
    foregroundDustMaterial,
  );
  foregroundDust.renderOrder = 8;
  scene.add(foregroundDust);

  // -----------------------------------------------------------------------
  // Foreground interceptor: actual meshes, not a particle outline
  // -----------------------------------------------------------------------
  const ship = new THREE.Group();
  ship.position.set(-7.5, -9.1, 13);
  ship.rotation.set(-0.13, -0.24, 0.025);
  ship.scale.setScalar(1.2);
  scene.add(ship);

  const shipLight = new THREE.PointLight(0x8bb8ff, 48, 44, 1.7);
  shipLight.position.set(0, 5, 11);
  ship.add(shipLight);

  const hullMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#5d7193"),
    emissive: new THREE.Color("#101d35"),
    emissiveIntensity: 0.72,
    roughness: 0.36,
    metalness: 0.76,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const hull = new THREE.Mesh(hullGeometry(), hullMaterial);
  hull.layers.enable(2);
  ship.add(hull);

  const spine = new THREE.Mesh(
    new THREE.CapsuleGeometry(1.25, 7.2, 8, 24),
    hullMaterial,
  );
  spine.rotation.x = Math.PI / 2;
  spine.scale.set(0.92, 1, 0.72);
  spine.position.set(0, 0.28, 0.2);
  spine.layers.enable(2);
  ship.add(spine);

  for (const side of [-1, 1] as const) {
    const wing = new THREE.Mesh(wingGeometry(side), hullMaterial);
    wing.layers.enable(2);
    ship.add(wing);

    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 2.4, 3.8),
      hullMaterial,
    );
    tail.position.set(side * 2.6, 1.25, 3.9);
    tail.rotation.z = side * -0.18;
    tail.layers.enable(2);
    ship.add(tail);
  }

  const cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(1.25, 24, 14),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#632c18"),
      emissive: new THREE.Color("#d5591b"),
      emissiveIntensity: 1.65,
      roughness: 0.18,
      metalness: 0.55,
      transmission: 0.08,
    }),
  );
  cockpit.scale.set(0.92, 0.5, 1.55);
  cockpit.position.set(0, 1.42, -1.35);
  cockpit.layers.enable(2);
  ship.add(cockpit);

  const engineMaterials: THREE.MeshBasicMaterial[] = [];
  const engineSprites: THREE.Sprite[] = [];
  const trails: ReturnType<typeof createEngineTrail>[] = [];
  for (const x of [-1.55, 1.55]) {
    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.78, 1.02, 1.5, 24, 1, true),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#17233c"),
        emissive: new THREE.Color("#07132c"),
        roughness: 0.32,
        metalness: 0.82,
        side: THREE.DoubleSide,
      }),
    );
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(x, -0.35, 5.25);
    nozzle.layers.enable(2);
    ship.add(nozzle);

    const engineMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#8edbff"),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
    });
    const engine = new THREE.Mesh(
      new THREE.CircleGeometry(0.7, 32),
      engineMaterial,
    );
    engine.position.set(x, -0.35, 6.03);
    engine.layers.enable(BLOOM_LAYER);
    ship.add(engine);
    engineMaterials.push(engineMaterial);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTextureMap,
        color: new THREE.Color("#4fb5ff"),
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    sprite.position.set(x, -0.35, 6.3);
    sprite.scale.set(2.55, 2.55, 1);
    sprite.layers.enable(BLOOM_LAYER);
    ship.add(sprite);
    engineSprites.push(sprite);

    const trail = createEngineTrail(rand, x, glowTextureMap);
    ship.add(trail.points);
    trails.push(trail);
  }

  const pulse = new AudioPulse();
  const beatDynamics = new MirageBeatDynamics();
  const smoother = new BandSmoother(BANDS, 24, 8);
  const rawBands = new Float32Array(BANDS);
  const lookAt = new THREE.Vector3(1, 1, -24);
  const ringScreenA = new THREE.Vector3();
  const ringScreenB = new THREE.Vector3();
  const ringScreenDirection = new THREE.Vector2();
  const shipPoseState: MirageShipPose = {
    bob: 0,
    roll: 0,
    yaw: 0,
    forward: 0,
  };
  const worldAnglesState: MirageWorldAngles = {
    planetBody: 0,
    planetParticles: 0,
    blueStream: 0,
    stars: 0,
  };
  let pointScale = 1;
  let viewportHeight = 720;

  return {
    render(frame: ThreeFrame) {
      const mood = frame.mood ?? fallbackMood;
      const motion = frame.prefersReducedMotion ? 0.22 : 1;
      const { energy, bass, impact } = pulse.update(
        energyLevel(frame.freq),
        bassLevel(frame.freq),
        frame.dt,
      );
      const beat = beatDynamics.update(impact, frame.dt);
      const bands = smoother.step(fillBands(frame.freq, rawBands), frame.dt);
      for (let index = 0; index < BANDS; index++) {
        bandBytes[index] = Math.max(
          0,
          Math.min(255, Math.round(Math.pow(bands[index], 0.8) * 255)),
        );
      }
      bandTexture.needsUpdate = true;

      // Keep the reference's disciplined dual palette: a cool theme family
      // plus a fixed warm ring accent. Mood changes luminance, not hue count.
      const sourceHue = (((frame.options.themeHue ?? 215) % 360) + 360) % 360;
      // The global hue modulates the cool family without ever turning the sky
      // green, red or orange. Mirage's identity depends on cobalt versus gold.
      const coolHue = (225 + Math.sin((sourceHue / 360) * TAU) * 14) / 360;
      terrainUniforms.uTime.value = frame.elapsed;
      terrainUniforms.uEnergy.value = energy;
      terrainUniforms.uBass.value = bass;
      terrainUniforms.uImpact.value = Math.max(impact, mood.buildUp * 0.2);
      terrainUniforms.uPointScale.value = pointScale;

      planetParticleUniforms.uTime.value = frame.elapsed;
      planetParticleUniforms.uEnergy.value = energy;
      planetParticleUniforms.uHue.value = coolHue;
      planetParticleUniforms.uPointScale.value = pointScale;
      planetBodyMaterial.uniforms.uDarkAngle.value =
        frame.elapsed * MIRAGE_MOTION.planetPatternRadiansPerSecond * motion;
      planetBodyMaterial.uniforms.uGoldAngle.value =
        -frame.elapsed * MIRAGE_MOTION.planetParticleRadiansPerSecond * motion;

      ringUniforms.uTime.value = frame.elapsed * motion;
      ringUniforms.uEnergy.value = energy;
      ringUniforms.uPulseProgress.value = beat.ringPulseProgress;
      ringUniforms.uPulseStrength.value = beat.ringPulseStrength;
      ringUniforms.uPointScale.value = pointScale;

      swirlUniforms.uTime.value = frame.elapsed * motion;
      swirlUniforms.uEnergy.value = energy;
      swirlUniforms.uPointScale.value = pointScale;

      starUniforms.uTime.value = frame.elapsed * motion;
      starUniforms.uEnergy.value = energy;
      starUniforms.uPointScale.value = pointScale;

      foregroundDustUniforms.uTime.value = frame.elapsed * motion;
      foregroundDustUniforms.uDrive.value =
        energy * 0.55 + beat.shipThrust * 0.45;
      foregroundDustUniforms.uPointScale.value = pointScale;

      planetBodyMaterial.uniforms.uRimStrength.value = mirageRimStrength(
        frame.elapsed,
        energy,
        mood.buildUp,
        beat.ringPulseStrength,
      );
      planetWaveMaterial.uniforms.uProgress.value = beat.planetWaveProgress;
      planetWaveMaterial.uniforms.uStrength.value = beat.planetWaveStrength;
      planetWave.visible = beat.planetWaveStrength > 0.002;
      planetBodyMaterial.uniforms.uCool.value.setHSL(coolHue, 0.34, 0.26);

      // The spherical silhouette stays stable, while its textured body,
      // particle skin, orbital streams and star field all move at visibly
      // distinct rates. No frame-to-frame accumulation is used.
      const worldAngles = mirageWorldAngles(frame.elapsed, worldAnglesState);
      planetBody.rotation.y = worldAngles.planetBody * motion;
      planetParticlePoints.rotation.y = worldAngles.planetParticles * motion;
      swirlPoints.rotation.y =
        -0.08 +
        worldAngles.blueStream * motion +
        Math.sin(frame.elapsed * 0.11) * 0.012 * motion;
      stars.rotation.y = worldAngles.stars * motion;

      for (let index = 0; index < RING_SPARK_COUNT; index++) {
        const burstGroup = index % 3;
        const age =
          (frame.elapsed + burstGroup * 2.13 + ringSparkSeeds[index] * 0.08) %
          6.4;
        const active = age < 0.52;
        const fade = active ? Math.max(0, 1 - age / 0.52) : 0;
        const offset = index * 3;
        ringSparkPositions[offset] = active
          ? ringSparkHome[offset] + ringSparkVelocity[offset] * age
          : 36;
        ringSparkPositions[offset + 1] = active
          ? ringSparkHome[offset + 1] +
            ringSparkVelocity[offset + 1] * age -
            age * age * 1.8
          : 999;
        ringSparkPositions[offset + 2] = active
          ? ringSparkHome[offset + 2] + ringSparkVelocity[offset + 2] * age
          : 0;
        ringSparkColors[offset] = fade;
        ringSparkColors[offset + 1] = fade * 0.55;
        ringSparkColors[offset + 2] = fade * 0.16;
      }
      ringSparkPositionAttribute.needsUpdate = true;
      ringSparkColorAttribute.needsUpdate = true;
      for (let index = 0; index < nebulae.length; index++) {
        const material = nebulae[index].material as THREE.SpriteMaterial;
        material.opacity =
          nebulaDefinitions[index].opacity *
          (0.72 + mood.weights.cosmos * 0.38 + energy * 0.22);
      }

      const engineLevel =
        0.55 + energy * 0.42 + bass * 0.28 + beat.engineBoost * 0.6;
      for (const material of engineMaterials) {
        material.opacity = Math.min(1, 0.5 + engineLevel * 0.38);
        material.color.setHSL(
          coolHue,
          0.5,
          Math.min(0.94, 0.66 + engineLevel * 0.1),
        );
      }
      for (const sprite of engineSprites) {
        sprite.scale.set(2.55, 2.55, 1);
        (sprite.material as THREE.SpriteMaterial).opacity = Math.min(
          0.72,
          0.18 + engineLevel * 0.26,
        );
      }

      const trailLength = 10.5 + bass * 8.5 + energy * 6.5;
      for (const trail of trails) {
        const position = trail.points.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        const color = trail.points.geometry.getAttribute(
          "color",
        ) as THREE.BufferAttribute;
        for (let index = 0; index < TRAIL_PARTICLES; index++) {
          const phase = trail.phases[index];
          const speed = trail.speeds[index];
          const progress =
            (phase +
              frame.elapsed * (0.16 + energy * 0.22 + bass * 0.08) * speed) %
            1;
          const spread = 0.32 + progress * 1.5;
          const turbulence =
            Math.sin(frame.elapsed * (1.15 + speed * 0.8) + phase * TAU * 4) *
            progress *
            0.16;
          position.setXYZ(
            index,
            trail.engineX + trail.radialX[index] * spread + turbulence,
            -0.35 +
              trail.radialY[index] * spread * 0.68 +
              Math.cos(frame.elapsed * 1.3 + phase * TAU * 3) *
                progress *
                0.045,
            6.1 + progress * trailLength,
          );

          const core = Math.pow(1 - progress, 3);
          const fade = Math.pow(1 - progress, 1.15);
          color.setXYZ(
            index,
            (0.08 + core * 0.58) * fade,
            (0.34 + core * 0.58) * fade,
            (0.78 + core * 0.22) * fade,
          );
        }
        position.needsUpdate = true;
        color.needsUpdate = true;
        trail.material.opacity = Math.min(
          0.58,
          0.25 + energy * 0.13 + bass * 0.09 + beat.engineBoost * 0.11,
        );
      }

      const shipPose = mirageShipPose(
        frame.elapsed,
        beat.shipThrust,
        shipPoseState,
      );
      ship.position.y = -9.1 + shipPose.bob * motion;
      ship.position.z = 13 - shipPose.forward * motion;
      ship.rotation.z = 0.006 + shipPose.roll * motion;
      ship.rotation.y = -0.24 + shipPose.yaw * motion;

      const progress = Math.max(0, Math.min(1, frame.positionFraction));
      const sectionAngle = THREE.MathUtils.degToRad(
        mirageSectionAngle(mood.weights),
      );
      const cameraToSubject = 92;
      const worldPerPixel =
        (2 *
          Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) *
          cameraToSubject) /
        Math.max(1, viewportHeight);
      const microShake =
        worldPerPixel *
        MIRAGE_MOTION.cameraShakePixels *
        beat.shipThrust *
        motion;
      camera.position.set(
        Math.sin(frame.elapsed * 0.026) * 0.14 * motion +
          Math.sin(frame.elapsed * 51.7) * microShake,
        5.2 +
          Math.sin(frame.elapsed * 0.021 + 0.8) * 0.1 * motion +
          Math.sin(frame.elapsed * 47.3 + 1.4) * microShake * 0.72,
        67 -
          progress * MIRAGE_MOTION.cameraPushDistance -
          energy * 0.12 * motion,
      );
      lookAt.set(
        1.5 + Math.tan(sectionAngle) * cameraToSubject,
        0.2 + (mood.valence - 0.5) * 0.35,
        -25,
      );
      camera.lookAt(lookAt);
      planetWave.quaternion.copy(camera.quaternion);
      camera.updateMatrixWorld();
      ringScreenA.set(-36, 0, 0);
      ringSystem.localToWorld(ringScreenA);
      ringScreenA.project(camera);
      ringScreenB.set(36, 0, 0);
      ringSystem.localToWorld(ringScreenB);
      ringScreenB.project(camera);
      ringScreenDirection.set(
        ringScreenB.x - ringScreenA.x,
        ringScreenB.y - ringScreenA.y,
      );
      if (ringScreenDirection.lengthSq() > 1e-6) {
        ringScreenDirection.normalize();
        planetWaveMaterial.uniforms.uRingNormal2D.value.set(
          -ringScreenDirection.y,
          ringScreenDirection.x,
        );
      }

      bloomPass.strength = 0.28 + energy * 0.12 + mood.buildUp * 0.07;
      bloomPass.radius = 0.27 + energy * 0.05;
      const cameraMask = camera.layers.mask;
      camera.layers.set(BLOOM_LAYER);
      bloomComposer.render();
      camera.layers.mask = cameraMask;
      finalComposer.render();
      moodHud.render(
        renderer,
        mood,
        frame.positionFraction,
        sourceHue,
        frame.dt,
        (frame.options.moodHud ?? 1) >= 0.5,
      );
    },
    resize(width, height, dpr) {
      shell.resize(width, height, dpr);
      viewportHeight = Math.max(1, height);
      bloomComposer.setPixelRatio(Math.min(dpr, 2));
      bloomComposer.setSize(width, height);
      finalComposer.setPixelRatio(Math.min(dpr, 2));
      finalComposer.setSize(width, height);
      pointScale = Math.min(
        1.65,
        Math.max(
          0.85,
          Math.sqrt((width * height * Math.min(dpr, 2)) / (1280 * 720)),
        ),
      );
      moodHud.resize(width, height);
    },
    dispose() {
      bloomComposer.dispose();
      finalComposer.dispose();
      moodHud.dispose();
      bandTexture.dispose();
      glowTextureMap.dispose();
      shell.dispose();
    },
  };
}
