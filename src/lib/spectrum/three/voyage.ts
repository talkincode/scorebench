/**
 * 航线 · Voyage — a capital ship held together by music.
 *
 * V8 keeps the established dreadnought topology while opening the surrounding
 * sector to the shared mood substrate: world weights steer the navigation
 * palette, weather becomes fog/debris/ice/ion activity, and V/A/T/build-up
 * shape travel, bloom, and camera breath. The five engines retain deep
 * concentric metal nozzles, compact cyan-white cores, analytic axial/radial
 * jets, and embedded particle spray. Music also lives as *travelling* energy:
 * beats launch packets at the stern that run the spine bow-ward, lighting
 * armor bays, spine nodes and portholes as they pass; climax links the
 * bays sequentially instead of brightening the whole ship.
 *
 * Exposure budget: ~70% of the frame near black, 20% dim structure,
 * 8% mid energy, 2% peak highlights. Glow sprites only on engine cores,
 * nodes, lamps and drones — never on the whole wireframe.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { neutralMoodState, seededRandom } from "../mood";
import type { ThreeFrame, ThreeInstance } from "./types";
import { bandLevels, bassLevel, createShell, energyLevel, glowTexture } from "./common";
import { createMoodHud } from "./moodHud";
import { AudioPulse, BandSmoother } from "../dynamics";
import {
  DAGGER_LENGTH,
  DAGGER_STERN_Z,
  ENGINE_CORE_DIAMETER_RATIO,
  ENGINE_GLOW_WIDTH_RATIO,
  ENGINE_JET_LENGTH_DIAMETERS,
  ENGINE_PARTICLE_FLOW_SPEED,
  ENGINE_PARTICLE_OPACITY,
  VOYAGE_PARALLAX_RATES,
  attackRelease,
  bezier3,
  bowToSternFlowU,
  compressLevel,
  daggerProfile,
  engineBeatEnvelope,
  engineCoreBrightnessScale,
  engineJetLengthScale,
  logoBreathLevel,
  logoGlowOpacity,
  parallaxDepth,
  parallaxEdgeFade,
  stagePhase,
  voyageAtmosphere,
  voyageStateWeights,
  type StagePhase,
} from "../voyage";

const SEED = 0x20260721;
const BLOOM_LAYER = 1;
const STAR_FAR_Z = -720;
const STAR_NEAR_Z = 48;
const GAS_FAR_Z = -700;
const GAS_NEAR_Z = -250;
const LANDMARK_FAR_Z = -560;
const LANDMARK_NEAR_Z = -210;
const PARTICLE_FAR_Z = -210;
const PARTICLE_NEAR_Z = 210;

// --- palette ---------------------------------------------------------------
const BG = new THREE.Color("#010308");
const STAR_NEUTRAL = new THREE.Color("#d3d9dc");
const AMBIENT_NEUTRAL = new THREE.Color("#aeb7bb");
const GROUND_NEUTRAL = new THREE.Color("#020307");
const FILL_NEUTRAL = new THREE.Color("#879195");
const RIM_NEUTRAL = new THREE.Color("#c7d0d3");
const NEBULA_BLUE = new THREE.Color("#245f8e");
const NEBULA_TEAL = new THREE.Color("#27777a");
const NEBULA_PURPLE = new THREE.Color("#4b315d");
const DUST_COLD = new THREE.Color("#010207");
const DUST_WARM = new THREE.Color("#0b090a");
const ARMOR_BASE = new THREE.Color("#60676a");
const ARMOR_SHADOW = new THREE.Color("#32383b");
const ARMOR_REPAIR = new THREE.Color("#777c7f");
const ARMOR_RUST_DARK = new THREE.Color("#44261b");
const ARMOR_RUST_RED = new THREE.Color("#7a3422");

/** Hull cross-section: 8 chined stations (flat armor facets, not a tube). */
const CHINE_X = [0, 0.72, 1, 0.94, 0.62, 0, -0.62, -0.94, -1, -0.72];
const CHINE_Y = [1, 0.78, 0.18, -0.42, -0.86, -1, -0.86, -0.42, 0.18, 0.78];
const CHINES = CHINE_X.length;

/** The hull ends here (blunt bow with a sensor boom), not at a needle tip. */
const BOW_CLIP = 0.93;
/** Armor bays: u-ranges along the flanks that light as energy passes. */
const BAY_COUNT = 8;
const BAY_U0 = 0.05;
const BAY_PITCH = 0.105;

function bayIdxOfU(u: number): number {
  return Math.max(0, Math.min(BAY_COUNT - 1, Math.floor((u - BAY_U0) / BAY_PITCH)));
}

function uz(u: number): number {
  return DAGGER_STERN_Z - u * DAGGER_LENGTH;
}

function deckY(u: number): number {
  const p = daggerProfile(u);
  return p.halfHeight + p.mid;
}

/**
 * Deterministic grayscale cavity shading. The shader owns the neutral gunmetal
 * palette; vertex color only carries broad form and never injects cyan.
 */
function bakeShade(geo: THREE.BufferGeometry, gain: number, structural = false): void {
  const norm = geo.getAttribute("normal") as THREE.BufferAttribute;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const cols = new Float32Array(norm.count * 3);
  for (let i = 0; i < norm.count; i++) {
    const top = Math.max(0, norm.getY(i));
    const side = Math.abs(norm.getX(i));
    const lowerCavity = Math.max(0, -norm.getY(i));
    const zone = 0.5 + 0.5 * Math.sin(pos.getZ(i) * 0.115 + pos.getX(i) * 0.21);
    const grain = 0.5 + 0.5 * Math.sin(pos.getZ(i) * 0.73 + pos.getY(i) * 1.37 + pos.getX(i) * 0.43);
    const shade =
      (0.78 + top * 0.12 + side * 0.05 + zone * 0.045 + grain * 0.025 - lowerCavity * 0.16) *
      gain *
      (structural ? 0.9 : 1);
    cols[i * 3] = shade;
    cols[i * 3 + 1] = shade;
    cols[i * 3 + 2] = shade;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
}

function enableBloom(object: THREE.Object3D): void {
  object.traverse((child) => child.layers.enable(BLOOM_LAYER));
}

/** Keep fast foreground debris out of the title, close control and footer. */
function isUiSafeZone(ndc: THREE.Vector3): boolean {
  const title = ndc.x <= -0.16 && ndc.y >= 0.6;
  const closeControl = ndc.x >= 0.72 && ndc.y >= 0.7;
  const footer = ndc.y <= -0.8;
  return title || closeControl || footer;
}

function armorMaterial(structural = false): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: structural ? 0.9 : 0.74,
    metalness: structural ? 0.05 : 0.12,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  const structuralWeight = structural ? "1.0" : "0.0";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uArmorBase = { value: ARMOR_BASE };
    shader.uniforms.uArmorShadow = { value: ARMOR_SHADOW };
    shader.uniforms.uArmorRepair = { value: ARMOR_REPAIR };
    shader.uniforms.uArmorRustDark = { value: ARMOR_RUST_DARK };
    shader.uniforms.uArmorRustRed = { value: ARMOR_RUST_RED };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vArmorPosition;
varying vec3 vArmorWorldPosition;
varying vec3 vArmorWorldNormal;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vArmorPosition = transformed;
vArmorWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
vArmorWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform vec3 uArmorBase;
uniform vec3 uArmorShadow;
uniform vec3 uArmorRepair;
uniform vec3 uArmorRustDark;
uniform vec3 uArmorRustRed;
varying vec3 vArmorPosition;
varying vec3 vArmorWorldPosition;
varying vec3 vArmorWorldNormal;

struct ArmorSurface {
  float grain;
  float seam;
  float bareMetal;
  float repair;
  float rust;
  float dust;
  float scorch;
  float ao;
  float height;
};

float armorHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float armorNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(armorHash(i), armorHash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(armorHash(i + vec3(0.0, 1.0, 0.0)), armorHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(armorHash(i + vec3(0.0, 0.0, 1.0)), armorHash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(armorHash(i + vec3(0.0, 1.0, 1.0)), armorHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z
  );
}

float armorFbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.55;
  for (int i = 0; i < 4; i++) {
    value += armorNoise(p) * amplitude;
    p = p * 2.03 + vec3(7.1, 3.7, 5.9);
    amplitude *= 0.48;
  }
  return value;
}

float armorSeamBand(float coordinate, float spacing, float width) {
  float distanceToSeam = abs(fract(coordinate / spacing + 0.5) - 0.5) * spacing;
  return 1.0 - smoothstep(width, width * 2.8, distanceToSeam);
}

float armorPatch(vec2 p, vec2 center, vec2 halfSize, float feather) {
  vec2 distanceToEdge = abs(p - center) - halfSize;
  return 1.0 - smoothstep(0.0, feather, max(distanceToEdge.x, distanceToEdge.y));
}

ArmorSurface sampleArmorSurface(vec3 p, vec3 surfaceNormal) {
  ArmorSurface surface;
  vec3 n = normalize(surfaceNormal);
  surface.grain = armorFbm(p * 0.18 + vec3(2.7, 8.1, 4.3));
  float fine = armorFbm(p * 0.62 + vec3(11.3, 3.7, 7.9));
  float bulkhead = armorSeamBand(p.z + 2.4, 17.8, 0.3);
  float flankCut = armorSeamBand(p.x + p.y * 0.58, 8.4, 0.17);
  float deckCut = armorSeamBand(p.y - p.x * 0.21, 6.6, 0.15);
  float crossCut = max(flankCut, deckCut) * (0.25 + ${structuralWeight} * 0.2);
  surface.seam = clamp(bulkhead * 0.82 + crossCut, 0.0, 1.0);

  float seamLip = smoothstep(0.06, 0.48, surface.seam) * (1.0 - smoothstep(0.82, 1.0, surface.seam));
  float chipBreakup = smoothstep(0.34, 0.6, fine * 0.72 + surface.grain * 0.32);
  surface.bareMetal = clamp(
    (seamLip + surface.seam * 0.28) * chipBreakup * (0.94 - ${structuralWeight} * 0.28),
    0.0,
    1.0
  );
  float sideFacing = smoothstep(0.2, 0.72, n.x);
  float topFacing = smoothstep(0.22, 0.78, n.y);
  float sideRepairA = armorPatch(vec2(p.z, p.y), vec2(-38.0, 1.2), vec2(11.0, 3.8), 0.7) * sideFacing;
  float sideRepairB = armorPatch(vec2(p.z, p.y), vec2(-118.0, -1.4), vec2(8.5, 3.1), 0.65) * sideFacing;
  float topRepair = armorPatch(vec2(p.z, p.x), vec2(-82.0, -1.8), vec2(9.5, 4.6), 0.75) * topFacing;
  surface.repair = clamp(max(max(sideRepairA, sideRepairB), topRepair) * (1.0 - surface.seam * 0.42), 0.0, 1.0);

  float underside = smoothstep(0.12, 0.86, max(0.0, -n.y));
  float recess = clamp(surface.seam * (0.68 + underside * 0.22), 0.0, 1.0);
  float corrosion = smoothstep(0.34, 0.62, armorFbm(p * 0.31 + vec3(4.2, 1.7, 9.4)));
  surface.rust = recess * corrosion * (0.94 - ${structuralWeight} * 0.24);
  surface.dust = clamp(
    surface.seam * smoothstep(0.38, 0.68, surface.grain) * 0.62 +
    underside * smoothstep(0.44, 0.72, fine) * (0.12 + ${structuralWeight} * 0.1),
    0.0,
    1.0
  );

  float aftExposure = smoothstep(18.0, 39.0, p.z);
  float heatBreakup = smoothstep(0.42, 0.72, armorFbm(vec3(p.x, p.y, p.z * 0.35) * 0.24 + 12.7));
  surface.scorch = aftExposure * heatBreakup * (0.34 + underside * 0.22);
  surface.ao = clamp(1.0 - surface.seam * 0.52 - surface.dust * 0.3 - surface.rust * 0.16, 0.26, 1.0);
  surface.height =
    (surface.grain - 0.5) * 0.05 +
    (fine - 0.5) * 0.018 +
    surface.rust * 0.065 -
    surface.seam * 0.12;
  return surface;
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
ArmorSurface armor = sampleArmorSurface(vArmorPosition, vArmorWorldNormal);
float bakedShade = clamp(diffuseColor.r, 0.28, 1.12);
vec3 paintTone = mix(uArmorBase, uArmorShadow, ${structuralWeight} * 0.64);
vec3 oldPaint = paintTone * bakedShade * (0.9 + armor.grain * 0.18);
float paintFade = smoothstep(0.34, 0.72, armorFbm(vArmorPosition * 0.07 + vec3(1.8, 6.2, 3.4)));
oldPaint *= 0.9 + paintFade * 0.14;
oldPaint *= 1.0 - armor.seam * 0.28;
vec3 repairPaint = uArmorRepair * bakedShade * (0.94 + armor.grain * 0.08);
oldPaint = mix(oldPaint, repairPaint, armor.repair);
vec3 exposedSteel = uArmorRepair * bakedShade * (1.02 + armor.grain * 0.16);
vec3 darkRust = mix(uArmorRustDark, uArmorRustRed, armor.grain);
diffuseColor.rgb = mix(oldPaint, exposedSteel, armor.bareMetal);
diffuseColor.rgb = mix(diffuseColor.rgb, darkRust, armor.rust);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.15, 0.125), armor.dust * 0.38);
diffuseColor.rgb = mix(diffuseColor.rgb, uArmorShadow * 0.42, armor.scorch * 0.72);
`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (armor.grain - 0.5) * 0.34, 0.34, 0.98);
roughnessFactor = mix(roughnessFactor, 0.58, armor.repair * 0.68);
roughnessFactor = mix(roughnessFactor, 0.22, armor.bareMetal);
roughnessFactor = mix(roughnessFactor, 0.96, armor.rust);
roughnessFactor = mix(roughnessFactor, 0.98, armor.dust);
roughnessFactor = mix(roughnessFactor, 0.9, armor.scorch);`,
      )
      .replace(
        "#include <metalnessmap_fragment>",
        `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.9, armor.bareMetal);
metalnessFactor *= 1.0 - armor.rust * 0.95;
metalnessFactor *= 1.0 - armor.dust * 0.88;
metalnessFactor *= 1.0 - armor.scorch * 0.55;`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
vec3 armorWorldNormal = normalize(vArmorWorldNormal);
vec3 sigmaX = dFdx(vArmorWorldPosition);
vec3 sigmaY = dFdy(vArmorWorldPosition);
vec3 r1 = cross(sigmaY, armorWorldNormal);
vec3 r2 = cross(armorWorldNormal, sigmaX);
float determinant = dot(sigmaX, r1);
vec3 surfaceGradient =
  sign(determinant) * (dFdx(armor.height) * r1 + dFdy(armor.height) * r2);
vec3 mappedArmorNormal =
  normalize(abs(determinant) * armorWorldNormal - surfaceGradient * 0.62);
normal = normalize(mat3(viewMatrix) * mappedArmorNormal);`,
      )
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= armor.ao;
reflectedLight.indirectSpecular *= mix(armor.ao, 1.0, 0.3);`,
      );
  };
  material.customProgramCacheKey = () => `voyage-armor-${structural ? "structure" : "plate"}-v6`;
  return material;
}

const ENGINE_CORE_VERTEX = /* glsl */ `
  varying vec2 vCoreUv;
  void main() {
    vCoreUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ENGINE_CORE_FRAGMENT = /* glsl */ `
  varying vec2 vCoreUv;
  uniform float uIntensity;
  void main() {
    float radial = length((vCoreUv - 0.5) * 2.0);
    if (radial >= 1.0) discard;

    float edge = 1.0 - smoothstep(0.78, 1.0, radial);
    float cyanBody = 1.0 - smoothstep(0.34, 0.92, radial);
    float whiteCenter = 1.0 - smoothstep(0.12, 0.34, radial);
    vec3 color = mix(vec3(0.02, 0.31, 0.72), vec3(0.24, 0.84, 1.0), cyanBody);
    color = mix(color, vec3(0.92, 1.0, 1.0), whiteCenter);
    float alpha = edge * mix(0.62, 1.0, cyanBody) * uIntensity;
    gl_FragColor = vec4(color, alpha);
  }
`;

function engineCoreMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uIntensity: { value: 0 },
    },
    vertexShader: ENGINE_CORE_VERTEX,
    fragmentShader: ENGINE_CORE_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: true,
  });
}

const ENGINE_BEAM_VERTEX = /* glsl */ `
  varying vec2 vBeamUv;
  uniform float uLength;
  uniform float uRadius;
  void main() {
    vBeamUv = uv;
    float throat = mix(0.72, 1.0, smoothstep(0.0, 0.16, uv.y));
    vec3 p = position;
    p.x *= uRadius * throat;
    p.z *= uLength;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const ENGINE_BEAM_FRAGMENT = /* glsl */ `
  varying vec2 vBeamUv;
  uniform float uIntensity;
  uniform float uRadialPower;
  uniform float uTailStart;
  uniform float uParticleAmount;
  uniform float uParticleOffset;
  uniform vec3 uAxisColor;
  uniform vec3 uEdgeColor;

  float beamHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    float axial = vBeamUv.y;
    float radial = abs(vBeamUv.x * 2.0 - 1.0);
    float edgeMask = 1.0 - smoothstep(0.82, 1.0, radial);
    float radialFalloff = exp(-radial * radial * uRadialPower) * edgeMask;
    float centerline = exp(-radial * radial * uRadialPower * 4.5);
    float inlet = smoothstep(0.0, 0.035, axial);
    float outlet = 1.0 - smoothstep(uTailStart, 1.0, axial);
    float axialGradient = mix(1.0, 0.16, smoothstep(0.02, 0.96, axial));
    float plume = radialFalloff * inlet * outlet * axialGradient;
    vec2 particleGrid = vec2(axial * 42.0 - uParticleOffset * 1.6, vBeamUv.x * 9.0);
    vec2 particleCell = floor(particleGrid);
    vec2 particleLocal = fract(particleGrid) - 0.5;
    vec2 particleJitter = vec2(
      beamHash(particleCell + vec2(17.0, 3.0)),
      beamHash(particleCell + vec2(5.0, 29.0))
    ) - 0.5;
    float particleSeed = beamHash(particleCell);
    float particleShape =
      1.0 -
      smoothstep(
        0.025,
        0.085 + particleSeed * 0.055,
        length(particleLocal - particleJitter * 0.6)
      );
    float particleBand =
      smoothstep(0.08, 0.22, radial) * (1.0 - smoothstep(0.48, 0.68, radial));
    float particlePulse =
      particleShape * step(0.68, particleSeed) * particleBand *
      mix(1.0, axialGradient, 0.55) * uParticleAmount;
    float particle = plume * particlePulse;
    float alpha = plume * uIntensity + particle;
    if (alpha < 0.001) discard;
    vec3 color = mix(uEdgeColor, uAxisColor, centerline);
    color = mix(color, vec3(0.5, 0.85, 1.0), clamp(particlePulse * 2.4, 0.0, 0.72));
    gl_FragColor = vec4(color, alpha);
  }
`;

function engineBeamMaterial(
  axisColor: THREE.ColorRepresentation,
  edgeColor: THREE.ColorRepresentation,
  radialPower: number,
  tailStart: number,
  particleAmount: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLength: { value: 1 },
      uRadius: { value: 1 },
      uIntensity: { value: 0 },
      uRadialPower: { value: radialPower },
      uTailStart: { value: tailStart },
      uParticleAmount: { value: particleAmount },
      uParticleOffset: { value: 0 },
      uAxisColor: { value: new THREE.Color(axisColor) },
      uEdgeColor: { value: new THREE.Color(edgeColor) },
    },
    vertexShader: ENGINE_BEAM_VERTEX,
    fragmentShader: ENGINE_BEAM_FRAGMENT,
    transparent: true,
    blending: THREE.NormalBlending,
    depthWrite: false,
    toneMapped: true,
    side: THREE.DoubleSide,
  });
}

/** One support plane with analytical axial and radial falloff; no sprite cloud. */
function engineBeamGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 0, 1, 1, 0, 1], 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  return geometry;
}

function finishCanvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function scorebenchCatHeadTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const ctx = canvas.getContext("2d")!;
  const ink = "rgba(255, 255, 255, 0.92)";
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.translate(2, 0);

  const cx = 78;
  const cy = 80;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, 58, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + 4, 34, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(49, 71);
  ctx.lineTo(50, 29);
  ctx.lineTo(68, 49);
  ctx.moveTo(107, 71);
  ctx.lineTo(106, 29);
  ctx.lineTo(88, 49);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(64, 83, 6.5, 0, Math.PI * 2);
  ctx.arc(92, 83, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(72, 96);
  ctx.lineTo(84, 96);
  ctx.lineTo(78, 104);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(66, 110);
  ctx.quadraticCurveTo(72, 118, 78, 111);
  ctx.quadraticCurveTo(84, 118, 90, 110);
  ctx.stroke();

  ctx.lineWidth = 3;
  for (const offset of [-9, 0, 9]) {
    ctx.beginPath();
    ctx.moveTo(33, 91 + offset * 0.55);
    ctx.lineTo(51, 93 + offset * 0.35);
    ctx.moveTo(123, 91 + offset * 0.55);
    ctx.lineTo(105, 93 + offset * 0.35);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.moveTo(81, 50);
  ctx.lineTo(72, 68);
  ctx.lineTo(80, 68);
  ctx.lineTo(75, 82);
  ctx.lineTo(90, 63);
  ctx.lineTo(82, 63);
  ctx.closePath();
  ctx.fill();

  return finishCanvasTexture(canvas);
}

function scorebenchHullIdTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 160;
  const ctx = canvas.getContext("2d")!;
  const ink = "rgba(255, 255, 255, 0.92)";
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.62;
  ctx.fillRect(10, 27, 2, 106);
  ctx.fillRect(28, 35, 712, 2);
  ctx.fillRect(28, 123, 712, 2);
  ctx.globalAlpha = 1;
  ctx.font = "700 74px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.fillText("1911-0102", 42, 82);
  ctx.font = "16px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.globalAlpha = 0.65;
  ctx.fillText("SCOREBENCH / VOYAGE", 490, 112);

  return finishCanvasTexture(canvas);
}

function hullMarkPaint(texture: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: texture,
    color: new THREE.Color("#68817e"),
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    roughness: 0.86,
    metalness: 0.12,
    emissive: new THREE.Color("#102827"),
    emissiveIntensity: 0.08,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

function facetedAnnulus(
  outerRadius: number,
  innerRadius: number,
  depth: number,
  bevel: number,
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments: 16,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: bevel,
    bevelThickness: bevel,
  });
  geometry.center();
  return geometry;
}

const NEBULA_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NEBULA_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uPulse;
  uniform float uSeed;
  uniform vec3 uBlue;
  uniform vec3 uTeal;
  uniform vec3 uPurple;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.37, 289.11))) * 43758.5453); }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0; float a = 0.55;
    for (int i = 0; i < 5; i++) { v += noise2(p) * a; p = p * 2.04 + 9.7; a *= 0.48; }
    return v;
  }
  void main() {
    vec2 p = (vUv - 0.5) * vec2(2.1, 2.35);
    vec2 flow = vec2(uTime * 0.085, -uTime * 0.052);
    float edgeField = fbm(p * 1.15 - flow * 0.12 + uSeed * 3.1);
    float radial = dot(p, p);
    float boundary = 1.0 - smoothstep(
      0.48 + edgeField * 0.16,
      0.88 + edgeField * 0.2,
      radial
    );
    float warpField = fbm(p * 0.82 - flow * 0.38 + uSeed * 1.4);
    vec2 warp = vec2(cos(warpField * 6.283), sin(warpField * 6.283)) * 0.16;
    float broad = fbm((p + warp) * 1.35 + flow + uSeed);
    float filament = fbm((p - warp * 0.62) * 3.8 - flow * 1.7 + uSeed * 2.3);
    float torn = fbm((p + warp * 0.45) * 2.6 + flow * 0.7 + uSeed * 4.7);
    float cloud = broad * 0.7 + filament * 0.32;
    float density = smoothstep(0.49, 0.72, cloud);
    density *= boundary * mix(0.18, 1.0, smoothstep(0.34, 0.7, torn));
    float cavity = smoothstep(
      0.57,
      0.77,
      fbm(p * 2.35 - flow * 0.48 + uSeed * 6.2)
    );
    float darkLane = 1.0 - smoothstep(
      0.08,
      0.24,
      abs(p.y + p.x * 0.28 + sin(p.x * 2.4 + uSeed) * 0.1)
    );
    density *= 1.0 - cavity * 0.8;
    density *= 1.0 - darkLane * (0.24 + torn * 0.38);
    vec2 corePoint = p - vec2(0.14, -0.08);
    float core = exp(-dot(corePoint, corePoint) * 5.2) * smoothstep(0.5, 0.82, filament);
    density = max(density, core * 0.68 * boundary);
    float localBreath = 0.5 + 0.5 * sin(uTime * 0.92 + broad * 4.4 + filament * 2.1 + uSeed);
    density *= 0.7 + localBreath * 0.18 + uPulse * 0.12;
    vec3 color = mix(uBlue, uTeal, smoothstep(0.44, 0.78, filament));
    color = mix(color, uTeal * 1.3, core * 0.52);
    color = mix(color, uPurple, smoothstep(0.72, 0.94, broad) * 0.1);
    color *= 0.95 + localBreath * 0.18 + uPulse * 0.12 + core * 0.25;
    gl_FragColor = vec4(color, clamp(density * uOpacity, 0.0, 0.72));
  }
`;

const DUST_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uPulse;
  uniform float uSeed;
  uniform vec3 uCold;
  uniform vec3 uWarm;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(83.17, 271.91))) * 43758.5453); }
  float noise2(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0; float a = 0.55;
    for (int i = 0; i < 5; i++) { v += noise2(p) * a; p = p * 2.07 + 8.9; a *= 0.47; }
    return v;
  }
  void main() {
    vec2 p = (vUv - 0.5) * vec2(2.2, 2.55);
    vec2 drift = vec2(uTime * 0.052, -uTime * 0.034);
    float curl = fbm(p * 0.76 + drift * 0.45 + uSeed * 1.8);
    float edgeField = fbm(p * 1.22 - drift * 0.2 + uSeed * 3.6);
    float boundary = 1.0 - smoothstep(
      0.46 + edgeField * 0.14,
      0.92 + edgeField * 0.18,
      dot(p, p)
    );
    vec2 warp = vec2(sin(curl * 6.283), cos(curl * 6.283)) * 0.12;
    float broad = fbm(vec2(p.x * 0.72 + p.y * 0.24, p.y * 1.45) + warp + drift + uSeed);
    float torn = fbm((p - warp * 0.7) * 2.8 - drift * 1.6 + uSeed * 2.7);
    float cloudLane = smoothstep(0.43, 0.68, broad * 0.78 + torn * 0.3);
    float bend = p.y + sin(p.x * 2.1 + uSeed + torn * 1.3) * 0.16;
    float ribbon = 1.0 - smoothstep(0.12, 0.38, abs(bend));
    float branch = 1.0 - smoothstep(0.08, 0.25, abs(p.y + p.x * 0.34 - 0.3));
    float lane = max(cloudLane * 0.68, max(ribbon, branch * 0.62) * (0.55 + torn * 0.45));
    float hole = smoothstep(0.58, 0.78, fbm(p * 2.5 + drift * 0.4 + uSeed * 5.2));
    float localBreath = 0.5 + 0.5 * sin(uTime * 0.74 + torn * 4.8 + uSeed);
    vec3 color = mix(uCold, uWarm, smoothstep(0.52, 0.82, torn) * 0.38);
    float alpha = lane * boundary * (1.0 - hole * 0.58);
    gl_FragColor = vec4(color, alpha * uOpacity * (0.78 + localBreath * 0.1 + uPulse * 0.12));
  }
`;

/** Append a yaw-rotated box (36 verts, outward winding) into a position array. */
function pushBox(
  out: number[],
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  yaw = 0,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const P: number[][] = [];
  for (const [sx, sy, sz] of [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ]) {
    const x = sx * hx;
    const z = sz * hz;
    P.push([cx + x * c + z * s, cy + sy * hy, cz - x * s + z * c]);
  }
  const F = [
    [1, 2, 6, 1, 6, 5], // +x
    [4, 7, 3, 4, 3, 0], // -x
    [3, 7, 6, 3, 6, 2], // +y
    [0, 1, 5, 0, 5, 4], // -y
    [4, 5, 6, 4, 6, 7], // +z
    [1, 0, 3, 1, 3, 2], // -z
  ];
  for (const f of F) for (const i of f) out.push(P[i][0], P[i][1], P[i][2]);
}

/** Append the 12 edges of the same box into a line-segment position array. */
function pushBoxEdges(
  out: number[],
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  yaw = 0,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const P: number[][] = [];
  for (const [sx, sy, sz] of [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ]) {
    const x = sx * hx;
    const z = sz * hz;
    P.push([cx + x * c + z * s, cy + sy * hy, cz - x * s + z * c]);
  }
  const E = [0, 1, 1, 5, 5, 4, 4, 0, 3, 2, 2, 6, 6, 7, 7, 3, 0, 3, 1, 2, 5, 6, 4, 7];
  for (const i of E) out.push(P[i][0], P[i][1], P[i][2]);
}

function chinePoint(u: number, k: number, out: THREE.Vector3): THREE.Vector3 {
  const p = daggerProfile(u);
  out.set(CHINE_X[k] * p.halfWidth, CHINE_Y[k] * p.halfHeight + p.mid, DAGGER_STERN_Z - u * DAGGER_LENGTH);
  return out;
}

/** Paint a comet light-packet into a vertex-color attribute along a line. */

export function create(canvas: HTMLCanvasElement): ThreeInstance {
  const shell = createShell(canvas, 54);
  const { scene, camera, renderer } = shell;
  camera.far = 1000;
  camera.updateProjectionMatrix();
  scene.background = BG;
  scene.fog = null;
  const moodHud = createMoodHud();

  // Object-selective bloom. The bloom camera sees layer 1 only; the final pass
  // combines that target over the untouched layer-0 render. Luminance alone
  // never decides whether armor, seams or ordinary stars glow.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.28, 0.03);
  bloomComposer.addPass(bloomPass);
  const finalComposer = new EffectComposer(renderer);
  finalComposer.addPass(new RenderPass(scene, camera));
  finalComposer.addPass(
    new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          baseTexture: { value: null },
          bloomTexture: { value: bloomComposer.renderTarget2.texture },
        },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv; void main() { gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv); }`,
      }),
      "baseTexture",
    ),
  );
  finalComposer.addPass(new OutputPass());

  const rand = seededRandom(SEED);
  const glow = glowTexture();
  const hullCatMark = scorebenchCatHeadTexture();
  const hullIdMark = scorebenchHullIdTexture();

  const ship = new THREE.Group();
  scene.add(ship);

  // Neutral physical lights model the large planes without lifting space or
  // letting the engine glow wash over the hull.
  const ambientLight = new THREE.HemisphereLight(AMBIENT_NEUTRAL, GROUND_NEUTRAL, 0.72);
  scene.add(ambientLight);
  const nebulaFill = new THREE.DirectionalLight(FILL_NEUTRAL, 0.64);
  nebulaFill.position.set(-80, -30, -150);
  scene.add(nebulaFill);
  const rimLight = new THREE.DirectionalLight(RIM_NEUTRAL, 1.12);
  rimLight.position.set(95, -12, 92);
  scene.add(rimLight);
  // Hull and superstructure share a bounded music response.
  let hullMat: THREE.MeshStandardMaterial;
  let superMat: THREE.MeshStandardMaterial;
  const hullMarkMaterials: THREE.MeshStandardMaterial[] = [];
  let hullCatGlowMaterial: THREE.MeshBasicMaterial;
  let hullCatGlowMesh: THREE.Mesh;

  // ==========================================================================
  // LAYER 1 — the opaque hull. Priority one: an unmistakable silhouette.
  // A faceted titanium mass that stays readable against true-black space.
  // ==========================================================================
  const HULL_STATIONS = 64;
  {
    const positions: number[] = [];
    const v = new THREE.Vector3();
    for (let s = 0; s < HULL_STATIONS; s++) {
      const u0 = (s / HULL_STATIONS) * BOW_CLIP;
      const u1 = ((s + 1) / HULL_STATIONS) * BOW_CLIP;
      for (let k = 0; k < CHINES; k++) {
        const k1 = (k + 1) % CHINES;
        const a = chinePoint(u0, k, v).toArray();
        const b = chinePoint(u0, k1, v).toArray();
        const c = chinePoint(u1, k1, v).toArray();
        const d = chinePoint(u1, k, v).toArray();
        positions.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
    // stern cap
    const sternCenter = [0, daggerProfile(0).mid, DAGGER_STERN_Z];
    for (let k = 0; k < CHINES; k++) {
      const k1 = (k + 1) % CHINES;
      const a = chinePoint(0, k1, v).toArray();
      const b = chinePoint(0, k, v).toArray();
      positions.push(...sternCenter, ...a, ...b);
    }
    // bow cap — the hull ends in a blunt sensor face, not a needle
    const bowCenter = [0, daggerProfile(BOW_CLIP).mid, uz(BOW_CLIP)];
    for (let k = 0; k < CHINES; k++) {
      const k1 = (k + 1) % CHINES;
      const a = chinePoint(BOW_CLIP, k, v).toArray();
      const b = chinePoint(BOW_CLIP, k1, v).toArray();
      positions.push(...bowCenter, ...a, ...b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    bakeShade(geo, 1);
    hullMat = armorMaterial(false);
    ship.add(new THREE.Mesh(geo, hullMat));
  }

  // ==========================================================================
  // SUPERSTRUCTURE — the wedge is broken: a staggered citadel rises aft,
  // armor bays give the flanks rhythm, pods hang from the keel, and the
  // clipped bow carries a sensor boom. Solid boxes share the hull's baked
  // shading; their edges live on a separate faint line layer.
  // ==========================================================================
  const superEdges: number[] = [];
  const bayEdgePos: number[] = [];
  const bayEdgeIdx: number[] = []; // per-vertex bay index for pulse lighting
  let bridgeWin: THREE.Points;
  let bridgeWinColors: Float32Array;
  let bridgeWinPhase: Float32Array;
  {
    const solids: number[] = [];
    // --- staggered citadel blocks (asymmetric, climbing aft→mid) -----------
    // tall enough to clear the silhouette from the low stern camera
    const citadel = [
      { u: 0.1, dx: -2.4, h: 4.6, hx: 6.0, hz: 11.0, yaw: 0.02 },
      { u: 0.185, dx: 1.8, h: 7.8, hx: 4.2, hz: 7.4, yaw: -0.03 },
      { u: 0.255, dx: -0.9, h: 10.6, hx: 2.7, hz: 4.6, yaw: 0.05 },
      { u: 0.315, dx: 0.6, h: 5.6, hx: 1.9, hz: 3.2, yaw: 0 },
    ];
    for (const c of citadel) {
      const y = deckY(c.u);
      pushBox(solids, c.dx, y + c.h * 0.5 - 0.4, uz(c.u), c.hx, c.h * 0.5, c.hz, c.yaw);
      pushBoxEdges(superEdges, c.dx, y + c.h * 0.5 - 0.4, uz(c.u), c.hx, c.h * 0.5, c.hz, c.yaw);
    }
    // small comms shelf on the tallest tower
    pushBox(solids, -0.9, deckY(0.255) + 11.0, uz(0.262), 1.1, 0.5, 1.6, 0.05);

    // --- flank armor bays: 8 per side, proud plates with rhythm & gaps -----
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      for (let b = 0; b < BAY_COUNT; b++) {
        if ((side === 0 && b === 5) || (side === 1 && b === 2)) continue; // missing plate — a wound
        const u0 = BAY_U0 + b * BAY_PITCH;
        const uc = u0 + BAY_PITCH * 0.46;
        const p = daggerProfile(uc);
        const hz = BAY_PITCH * DAGGER_LENGTH * (0.26 + ((b * 5 + side * 3) % 4) * 0.055);
        const hy = p.halfHeight * (0.26 + ((b * 7 + side * 2) % 5) * 0.065);
        const hx = 0.55;
        const cx = sgn * (p.halfWidth * 0.99 + hx * 0.5);
        const cy = p.mid + p.halfHeight * (b % 2 === 0 ? 0.08 : -0.22);
        pushBox(solids, cx, cy, uz(uc), hx, hy, hz, 0);
        pushBoxEdges(bayEdgePos, cx, cy, uz(uc), hx, hy, hz, 0);
        for (let e = 0; e < 24; e++) bayEdgeIdx.push(b);
      }
    }

    // --- ventral pods: suspended modules + maintenance platform ------------
    const pods = [
      { u: 0.14, dx: -3.6, hx: 2.1, hy: 1.5, hz: 5.2, drop: 1.7 },
      { u: 0.34, dx: 4.1, hx: 2.6, hy: 1.9, hz: 6.8, drop: 2.2 },
      { u: 0.55, dx: -1.2, hx: 1.6, hy: 1.2, hz: 4.0, drop: 1.4 },
    ];
    for (const pd of pods) {
      const p = daggerProfile(pd.u);
      const keelY = p.mid - p.halfHeight;
      const cy = keelY - pd.drop - pd.hy * 0.5;
      pushBox(solids, pd.dx, cy, uz(pd.u), pd.hx, pd.hy, pd.hz, 0);
      pushBoxEdges(superEdges, pd.dx, cy, uz(pd.u), pd.hx, pd.hy, pd.hz, 0);
      // pylon connecting pod to keel
      pushBox(solids, pd.dx, keelY - pd.drop * 0.5, uz(pd.u), 0.4, pd.drop * 0.6, 0.9, 0);
    }
    // maintenance platform under the midship
    pushBox(solids, 1.2, daggerProfile(0.44).mid - daggerProfile(0.44).halfHeight - 0.7, uz(0.44), 4.6, 0.22, 2.6, 0);

    // --- bow command / sensor block just aft of the cut -------------------
    {
      const ub = BOW_CLIP - 0.045;
      const p = daggerProfile(ub);
      pushBox(solids, 0, p.mid + p.halfHeight + 0.7, uz(ub), 0.9, 0.75, 3.4, 0);
      pushBoxEdges(superEdges, 0, p.mid + p.halfHeight + 0.7, uz(ub), 0.9, 0.75, 3.4, 0);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(solids, 3));
    geo.computeVertexNormals();
    bakeShade(geo, 0.9, true);
    superMat = armorMaterial(true);
    ship.add(new THREE.Mesh(geo, superMat));

    // Split paint layers let the crest sit farther aft and pulse independently.
    const catU = 0.014;
    const catProfile = daggerProfile(catU);
    const catGeometry = new THREE.PlaneGeometry(3.5, 3.5);
    const catPaint = hullMarkPaint(hullCatMark);
    hullMarkMaterials.push(catPaint);
    const catMesh = new THREE.Mesh(catGeometry, catPaint);
    catMesh.position.set(
      catProfile.halfWidth + 0.18,
      catProfile.mid - catProfile.halfHeight * 0.16,
      uz(catU),
    );
    catMesh.rotation.y = Math.PI / 2;
    catMesh.renderOrder = 3;
    ship.add(catMesh);

    hullCatGlowMaterial = new THREE.MeshBasicMaterial({
      map: hullCatMark,
      color: new THREE.Color("#8ffff1"),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    hullCatGlowMesh = new THREE.Mesh(catGeometry, hullCatGlowMaterial);
    hullCatGlowMesh.position.copy(catMesh.position);
    hullCatGlowMesh.position.x += 0.012;
    hullCatGlowMesh.rotation.copy(catMesh.rotation);
    hullCatGlowMesh.renderOrder = 4;
    ship.add(hullCatGlowMesh);
    enableBloom(hullCatGlowMesh);

    const idU = 0.057;
    const idProfile = daggerProfile(idU);
    const idPaint = hullMarkPaint(hullIdMark);
    hullMarkMaterials.push(idPaint);
    const idMesh = new THREE.Mesh(new THREE.PlaneGeometry(16.32, 3.4), idPaint);
    idMesh.position.set(
      idProfile.halfWidth + 0.18,
      idProfile.mid - idProfile.halfHeight * 0.16,
      uz(idU),
    );
    idMesh.rotation.y = Math.PI / 2;
    idMesh.renderOrder = 3;
    ship.add(idMesh);

    // bridge windows: sparse light points on the citadel faces
    const BWIN = 64;
    const wpos = new Float32Array(BWIN * 3);
    bridgeWinColors = new Float32Array(BWIN * 3);
    bridgeWinPhase = new Float32Array(BWIN);
    let wi = 0;
    for (const c of [citadel[0], citadel[1], citadel[2]]) {
      const y0 = deckY(c.u) - 0.4;
      const rows = c === citadel[2] ? 4 : 2;
      const perRow = Math.floor(BWIN / 3 / rows);
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i < perRow && wi < BWIN; i++) {
          if (rand() < 0.24) continue; // gaps — lived-in, not printed
          const t = (i + 0.5) / perRow;
          wpos[wi * 3] = c.dx + c.hx + 0.12;
          wpos[wi * 3 + 1] = y0 + c.h * ((r + 0.6) / (rows + 0.6));
          wpos[wi * 3 + 2] = uz(c.u) + (t - 0.5) * c.hz * 1.7;
          bridgeWinPhase[wi] = rand() * Math.PI * 2;
          wi++;
        }
      }
    }
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute("position", new THREE.BufferAttribute(wpos, 3));
    wgeo.setAttribute("color", new THREE.BufferAttribute(bridgeWinColors, 3));
    bridgeWin = new THREE.Points(
      wgeo,
      new THREE.PointsMaterial({
        size: 0.55,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        map: glow,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    ship.add(bridgeWin);
    enableBloom(bridgeWin);
  }

  // faint edge lines for citadel/pods (structure tier, never all lit)
  let superLines: THREE.LineSegments;
  {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(superEdges, 3));
    superLines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: new THREE.Color("#293235"),
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ship.add(superLines);
  }

  // armor bay edges: lit per-bay as energy pulses travel the hull
  let bayLines: THREE.LineSegments;
  let bayColors: Float32Array;
  {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(bayEdgePos, 3));
    bayColors = new Float32Array(bayEdgePos.length);
    geo.setAttribute("color", new THREE.BufferAttribute(bayColors, 3));
    bayLines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ship.add(bayLines);
  }

  // --- bow sensor boom: spar + cross vanes + nav lamp ----------------------
  let bowLamp: THREE.Sprite;
  let bowBoomMaterial: THREE.LineBasicMaterial;
  {
    const p = daggerProfile(BOW_CLIP);
    const bx = 0;
    const by = p.mid;
    const bz = uz(BOW_CLIP);
    const tip = bz - 16;
    const positions = [
      bx, by, bz, bx, by, tip,
      bx, by, tip + 4.5, bx - 2.1, by - 0.6, tip + 6.5,
      bx, by, tip + 4.5, bx + 2.1, by + 0.9, tip + 6.5,
      bx, by, tip + 9, bx, by + 1.8, tip + 10.5,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    bowBoomMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color("#2a4f5e"),
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    ship.add(new THREE.LineSegments(geo, bowBoomMaterial));
    bowLamp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: new THREE.Color("#ff8a5f"),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    bowLamp.position.set(bx, by, tip);
    bowLamp.scale.setScalar(1.5);
    ship.add(bowLamp);
  }

  // --- silhouette layer: 10 chine longerons, low density, always on --------
  const silhouetteMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const SIL_PTS = 96;
  let silhouette: THREE.LineSegments;
  let silColors: Float32Array;
  let silBase: Float32Array; // per-vertex weight (bow fade, chine emphasis)
  let silU: Float32Array;
  {
    const positions: number[] = [];
    const weights: number[] = [];
    const stations: number[] = [];
    const v = new THREE.Vector3();
    for (let k = 0; k < CHINES; k++) {
      // top deck + keel + widest chines read strongest
      const emphasis = k === 0 || k === 5 ? 1 : k === 2 || k === 8 ? 0.9 : 0.68;
      for (let i = 0; i < SIL_PTS - 1; i++) {
        const u0 = (i / (SIL_PTS - 1)) * BOW_CLIP;
        const u1 = ((i + 1) / (SIL_PTS - 1)) * BOW_CLIP;
        positions.push(...chinePoint(u0, k, v).toArray(), ...chinePoint(u1, k, v).toArray());
        const w0 = emphasis * (1 - u0 * 0.55);
        const w1 = emphasis * (1 - u1 * 0.55);
        weights.push(w0, w1);
        stations.push(u0, u1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    silColors = new Float32Array(positions.length);
    silBase = new Float32Array(weights);
    silU = new Float32Array(stations);
    geo.setAttribute("color", new THREE.BufferAttribute(silColors, 3));
    silhouette = new THREE.LineSegments(geo, silhouetteMat);
    ship.add(silhouette);
  }

  // --- structure layer: bulkhead rings + armor panel seams, mid gated ------
  const structureMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const BULKHEADS = 14;
  let structure: THREE.LineSegments;
  let structColors: Float32Array;
  let structBand: Float32Array; // which length-band each vertex belongs to (0..1 by u)
  let structJitter: Float32Array;
  {
    const positions: number[] = [];
    const bands: number[] = [];
    const jit: number[] = [];
    const v = new THREE.Vector3();
    // bulkhead rings — denser aft where the machinery lives
    for (let r = 0; r < BULKHEADS; r++) {
      const t = r / (BULKHEADS - 1);
      const u = t * t * 0.92 + 0.015;
      const j = rand();
      for (let k = 0; k < CHINES; k++) {
        const k1 = (k + 1) % CHINES;
        positions.push(...chinePoint(u, k, v).toArray(), ...chinePoint(u, k1, v).toArray());
        bands.push(u, u);
        jit.push(j, j);
      }
    }
    // armor panel seams: short longitudinal cuts at mid-facets
    const SEAMS = 44;
    for (let s = 0; s < SEAMS; s++) {
      const k = Math.floor(rand() * CHINES);
      const k1 = (k + 1) % CHINES;
      const u0 = rand() * 0.78 + 0.03;
      const len = 0.03 + rand() * 0.07;
      const mix = 0.25 + rand() * 0.5;
      const j = rand();
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const STEPS = 3;
      for (let i = 0; i < STEPS; i++) {
        const ua = u0 + (len * i) / STEPS;
        const ub = u0 + (len * (i + 1)) / STEPS;
        chinePoint(ua, k, a).lerp(chinePoint(ua, k1, b), mix);
        const pa = a.toArray();
        chinePoint(ub, k, a).lerp(chinePoint(ub, k1, b), mix);
        positions.push(...pa, ...a.toArray());
        bands.push(u0, u0);
        jit.push(j, j);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    structColors = new Float32Array(positions.length);
    structBand = new Float32Array(bands);
    structJitter = new Float32Array(jit);
    geo.setAttribute("color", new THREE.BufferAttribute(structColors, 3));
    structure = new THREE.LineSegments(geo, structureMat);
    ship.add(structure);
  }

  // --- energy layer: dorsal/flank conduits with continuous bow-to-stern flow
  const ENERGY_PTS = 160;
  interface Conduit {
    line: THREE.Line;
    colors: Float32Array;
    markers: THREE.Points;
    markerPositions: Float32Array;
    k: number;
    lift: number;
    head: number;
    rate: number;
    lag: number;
  }
  const conduits: Conduit[] = [];
  {
    const defs = [
      { k: 0, lift: 0.35, rate: 0.34, lag: 0 }, // dorsal spine, proud of the deck
      { k: 2, lift: 0.12, rate: 0.27, lag: 0.35 }, // starboard chine duct
      { k: 8, lift: 0.12, rate: 0.29, lag: 0.62 }, // port chine duct
      { k: 5, lift: -0.22, rate: 0.31, lag: 0.18 }, // keel duct — reads from below
    ];
    const v = new THREE.Vector3();
    for (const d of defs) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < ENERGY_PTS; i++) {
        const u = (i / (ENERGY_PTS - 1)) * (BOW_CLIP - 0.01) + 0.005;
        chinePoint(u, d.k, v);
        const p = daggerProfile(u);
        pts.push(new THREE.Vector3(v.x * 1.01, v.y + d.lift + p.halfHeight * 0.02, v.z));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const colors = new Float32Array(ENERGY_PTS * 3);
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      ship.add(line);
      enableBloom(line);

      const markerPositions = new Float32Array(6);
      const markerGeometry = new THREE.BufferGeometry();
      markerGeometry.setAttribute(
        "position",
        new THREE.BufferAttribute(markerPositions, 3).setUsage(THREE.DynamicDrawUsage),
      );
      const markers = new THREE.Points(
        markerGeometry,
        new THREE.PointsMaterial({
          map: glow,
          color: new THREE.Color("#b8edf2"),
          size: 2.1,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        }),
      );
      ship.add(markers);
      enableBloom(markers);
      conduits.push({
        line,
        colors,
        markers,
        markerPositions,
        k: d.k,
        lift: d.lift,
        head: rand(),
        rate: d.rate,
        lag: d.lag,
      });
    }
  }

  // --- spine nodes: a few glowing junctions along the dorsal line ----------
  const NODES = 5;
  const nodeSprites: THREE.Sprite[] = [];
  {
    const v = new THREE.Vector3();
    for (let i = 0; i < NODES; i++) {
      const u = 0.1 + (i / (NODES - 1)) * 0.62;
      chinePoint(u, 0, v);
      const mat = new THREE.SpriteMaterial({
        map: glow,
        color: new THREE.Color("#3ad6e8"),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sp = new THREE.Sprite(mat);
      sp.position.set(v.x, v.y + 0.5, v.z);
      sp.scale.setScalar(2.2);
      ship.add(sp);
      enableBloom(sp);
      nodeSprites.push(sp);
    }
  }

  // --- portholes: deck lines of tiny lights, uneven like a lived-in ship ---
  const PORTS_PER_LINE = 56;
  const PORT_LINES = 6; // 3 decks × 2 sides
  const PORT_COUNT = PORTS_PER_LINE * PORT_LINES;
  let ports: THREE.Points;
  let portColors: Float32Array;
  let portPhase: Float32Array;
  let portU: Float32Array; // hull position → bay gating
  let portOn: Float32Array; // 0 = dark window (gap in the row)
  {
    const positions = new Float32Array(PORT_COUNT * 3);
    portColors = new Float32Array(PORT_COUNT * 3);
    portPhase = new Float32Array(PORT_COUNT);
    portU = new Float32Array(PORT_COUNT);
    portOn = new Float32Array(PORT_COUNT);
    const v = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let idx = 0;
    for (let side = 0; side < 2; side++) {
      const kA = side === 0 ? 1 : 9; // upper facet
      const kB = side === 0 ? 2 : 8; // widest chine
      for (let deck = 0; deck < 3; deck++) {
        const mix = 0.3 + deck * 0.28;
        for (let i = 0; i < PORTS_PER_LINE; i++) {
          const u = 0.045 + (i / PORTS_PER_LINE) * 0.75 + (rand() - 0.5) * 0.012;
          chinePoint(u, kA, a);
          chinePoint(u, kB, b);
          v.copy(a).lerp(b, mix + (rand() - 0.5) * 0.05);
          // push slightly outboard so they sit on the armor, not in it
          positions[idx * 3] = v.x * 1.012;
          positions[idx * 3 + 1] = v.y;
          positions[idx * 3 + 2] = v.z;
          portPhase[idx] = rand() * Math.PI * 2;
          portU[idx] = u;
          // ~22% of windows stay dark; whole stretches dim near the bow
          portOn[idx] = rand() < 0.22 ? 0 : 0.55 + rand() * 0.45;
          idx++;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(portColors, 3));
    ports = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.8,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        map: glow,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    ship.add(ports);
    enableBloom(ports);
  }

  // --- greebles: instanced dark boxes — spine clutter + flank grilles ------
  const GREEBLES = 90;
  const GRILLES = 40;
  {
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#07111d"),
      roughness: 0.92,
      metalness: 0.12,
    });
    const inst = new THREE.InstancedMesh(boxGeo, mat, GREEBLES + GRILLES);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < GREEBLES; i++) {
      const u = 0.02 + rand() * 0.8;
      const kPick = rand();
      const k = kPick < 0.55 ? 0 : kPick < 0.78 ? 1 : 9;
      chinePoint(u, k, v);
      const p = daggerProfile(u);
      pos.set(
        v.x + (rand() - 0.5) * p.halfWidth * (k === 0 ? 0.7 : 0.14),
        v.y + rand() * 0.5,
        v.z + (rand() - 0.5) * 3,
      );
      const w = 0.5 + rand() * 2.6;
      s.set(w, 0.3 + rand() * 1.1, 0.8 + rand() * 4.5);
      m.compose(pos, q, s);
      inst.setMatrixAt(i, m);
    }
    // flank grilles / hatches: thin plates standing just proud of the armor,
    // clustered in runs so they read as vents rather than noise
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < GRILLES; i++) {
      const run = Math.floor(i / 5);
      const uBase = 0.07 + (run * 0.11) % 0.72;
      const u = uBase + (i % 5) * 0.011;
      const side = run % 2 === 0 ? 0 : 1;
      const kA = side === 0 ? 2 : 8;
      const kB = side === 0 ? 3 : 7;
      chinePoint(u, kA, a);
      chinePoint(u, kB, b);
      v.copy(a).lerp(b, 0.3 + (run % 3) * 0.18);
      pos.set(v.x * 1.015, v.y, v.z);
      s.set(0.22, 0.5 + rand() * 0.9, 1.1 + rand() * 1.4);
      m.compose(pos, q, s);
      inst.setMatrixAt(GREEBLES + i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    ship.add(inst);
  }

  // --- comm towers: thin masts on the ridge + citadel antenna array --------
  let mastMaterial: THREE.LineBasicMaterial;
  {
    const positions: number[] = [];
    const v = new THREE.Vector3();
    for (const u of [0.06, 0.42, 0.55]) {
      chinePoint(u, 0, v);
      const h = 2 + rand() * 3.4;
      positions.push(v.x, v.y, v.z, v.x, v.y + h, v.z);
      positions.push(v.x, v.y + h, v.z, v.x + (rand() - 0.5) * 2, v.y + h * 0.75, v.z + (rand() - 0.5) * 2);
    }
    // antenna cluster on the tall citadel tower
    {
      const bx = -0.9;
      const by = deckY(0.255) + 7.2;
      const bz = uz(0.255);
      for (let i = 0; i < 4; i++) {
        const h = 2.4 + rand() * 3.8;
        const ox = (rand() - 0.5) * 3.4;
        const oz = (rand() - 0.5) * 5;
        positions.push(bx + ox, by, bz + oz, bx + ox, by + h, bz + oz);
        if (i % 2 === 0) {
          positions.push(bx + ox - 0.8, by + h * 0.8, bz + oz, bx + ox + 0.8, by + h * 0.8, bz + oz);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    mastMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color("#22434f"),
      transparent: true,
      opacity: 0.5,
    });
    const mast = new THREE.LineSegments(geo, mastMaterial);
    ship.add(mast);
  }

  // --- maintenance pads: two lit docking points with coral marker lamps ----
  const padLamps: THREE.Sprite[] = [];
  {
    const v = new THREE.Vector3();
    for (const def of [
      { u: 0.2, k: 1 },
      { u: 0.47, k: 9 },
    ]) {
      chinePoint(def.u, def.k, v);
      const padGeo = new THREE.BoxGeometry(1.8, 0.24, 1.8);
      const pad = new THREE.Mesh(
        padGeo,
        new THREE.MeshStandardMaterial({ color: new THREE.Color("#0b1b2b"), roughness: 0.84, metalness: 0.16 }),
      );
      pad.position.set(v.x * 1.01, v.y + 0.25, v.z);
      ship.add(pad);
      const lamp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          color: new THREE.Color("#ff8a5f"),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      lamp.position.set(v.x * 1.01, v.y + 0.7, v.z);
      lamp.scale.setScalar(1.1);
      ship.add(lamp);
      padLamps.push(lamp);
    }
  }

  // --- upper-deck light pools: sparse pools that reveal armor volume --------
  interface DeckLight {
    light: THREE.PointLight;
    beacon: THREE.Sprite;
    phase: number;
  }
  const deckLights: DeckLight[] = [];
  {
    for (const [index, def] of [
      { u: 0.12, x: 0.62 },
      { u: 0.24, x: 0.56 },
      { u: 0.39, x: 0.6 },
      { u: 0.57, x: 0.52 },
    ].entries()) {
      const p = daggerProfile(def.u);
      const position = new THREE.Vector3(
        p.halfWidth * def.x,
        p.mid + p.halfHeight + 0.72,
        uz(def.u),
      );
      const light = new THREE.PointLight(0x9fe8f2, 0, 48, 2);
      light.position.copy(position);
      ship.add(light);

      const beacon = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          color: new THREE.Color("#b9f5ef"),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      beacon.position.copy(position);
      beacon.scale.setScalar(1.15);
      beacon.renderOrder = 4;
      ship.add(beacon);
      enableBloom(beacon);
      deckLights.push({ light, beacon, phase: index * 1.83 + rand() * 0.4 });
    }
  }

  // --- spine crawlers: tiny service lights inching along the dorsal ridge --
  const CRAWLERS = 5;
  const crawlers: { sprite: THREE.Sprite; off: number; speed: number }[] = [];
  {
    for (let i = 0; i < CRAWLERS; i++) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          color: new THREE.Color("#9fd8e8"),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sp.scale.setScalar(0.7);
      ship.add(sp);
      crawlers.push({ sprite: sp, off: rand(), speed: 0.006 + rand() * 0.009 });
    }
  }

  // ==========================================================================
  // LAYER 2 — the engine cluster. Three mains + two dorsal auxiliaries.
  // Each engine is exactly four optical layers: concentric metal nozzle,
  // compact cyan-white core, analytical main jet, restrained blue envelope.
  // ==========================================================================
  interface Engine {
    beamFacing: THREE.Group;
    coreMat: THREE.ShaderMaterial;
    mainJetMat: THREE.ShaderMaterial;
    outerGlowMat: THREE.ShaderMaterial;
    radius: number;
  }
  const engines: Engine[] = [];
  {
    const sternMid = daggerProfile(0).mid;
    const defs = [
      { x: -10.4, y: sternMid - 1.5, r: 4.0 },
      { x: 0, y: sternMid - 1.9, r: 4.5 },
      { x: 10.4, y: sternMid - 1.5, r: 4.0 },
      { x: -5.6, y: sternMid + 5.9, r: 2.2 },
      { x: 5.6, y: sternMid + 5.9, r: 2.2 },
    ];
    const outerMetal = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#343f47"),
      roughness: 0.34,
      metalness: 0.42,
      flatShading: true,
    });
    const innerMetal = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#505d65"),
      roughness: 0.3,
      metalness: 0.46,
      flatShading: true,
    });
    const sideMetal = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#10171c"),
      roughness: 0.56,
      metalness: 0.46,
      flatShading: true,
    });
    const recessMetal = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#04070a"),
      roughness: 0.88,
      metalness: 0.24,
      flatShading: true,
    });
    const turbineMetal = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#5a6a74"),
      roughness: 0.3,
      metalness: 0.5,
      emissive: new THREE.Color("#0c2230"),
      emissiveIntensity: 1.1,
      flatShading: true,
    });
    const turbineBacklight = new THREE.MeshBasicMaterial({
      color: new THREE.Color("#0d3550"),
      side: THREE.DoubleSide,
    });

    for (const d of defs) {
      const g = new THREE.Group();
      g.position.set(d.x, d.y, DAGGER_STERN_Z + 0.4);
      ship.add(g);

      // Layer 1: deep barrel, recessed face and two thick concentric rings.
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(d.r * 0.99, d.r * 0.93, d.r * 0.66, 16, 1, true),
        sideMetal,
      );
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = -d.r * 0.17;
      g.add(barrel);
      const recess = new THREE.Mesh(
        new THREE.CircleGeometry(d.r * 0.72, 16),
        recessMetal,
      );
      recess.position.z = d.r * 0.02;
      g.add(recess);
      const outerRing = new THREE.Mesh(
        facetedAnnulus(d.r * 0.99, d.r * 0.68, d.r * 0.32, d.r * 0.025),
        [outerMetal, sideMetal],
      );
      outerRing.position.z = d.r * 0.1;
      g.add(outerRing);
      const innerRing = new THREE.Mesh(
        facetedAnnulus(d.r * 0.64, d.r * 0.56, d.r * 0.16, d.r * 0.014),
        [innerMetal, sideMetal],
      );
      innerRing.position.z = d.r * 0.23;
      g.add(innerRing);
      // Dim backlit annulus so the twelve louver vanes read as dark silhouettes.
      const backlight = new THREE.Mesh(
        new THREE.RingGeometry(d.r * 0.3, d.r * 0.58, 48),
        turbineBacklight,
      );
      backlight.position.z = d.r * 0.22;
      g.add(backlight);
      const turbineGrille = new THREE.Group();
      turbineGrille.position.z = d.r * 0.26;
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        const holder = new THREE.Group();
        holder.rotation.z = angle;
        const blade = new THREE.Mesh(
          new THREE.BoxGeometry(d.r * 0.3, d.r * 0.105, d.r * 0.045),
          turbineMetal,
        );
        blade.position.x = d.r * 0.45;
        blade.rotation.x = 0.62;
        holder.add(blade);
        turbineGrille.add(holder);
      }
      g.add(turbineGrille);
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(d.r * 0.15, d.r * 0.21, d.r * 0.09, 12),
        innerMetal,
      );
      hub.rotation.x = Math.PI / 2;
      hub.position.z = d.r * 0.27;
      g.add(hub);
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const lug = new THREE.Mesh(
          new THREE.BoxGeometry(d.r * 0.16, d.r * 0.09, d.r * 0.1),
          innerMetal,
        );
        lug.position.set(
          Math.cos(angle) * d.r * 0.82,
          Math.sin(angle) * d.r * 0.82,
          d.r * 0.29,
        );
        lug.rotation.z = angle;
        g.add(lug);
      }

      // Layer 2: the core is 31% of nozzle diameter. Only its center is white.
      const coreMat = engineCoreMaterial();
      const core = new THREE.Mesh(
        new THREE.CircleGeometry(d.r * ENGINE_CORE_DIAMETER_RATIO, 48),
        coreMat,
      );
      core.position.z = d.r * 0.3;
      core.renderOrder = 6;
      g.add(core);
      enableBloom(core);

      // Layers 3–4: one fixed-radius beam and one 1.7× wider, dim blue envelope.
      const mainJetMat = engineBeamMaterial(
        "#74e1ff",
        "#0869c6",
        3.6,
        0.76,
        ENGINE_PARTICLE_OPACITY,
      );
      mainJetMat.uniforms.uRadius.value = d.r * 0.48;
      const outerGlowMat = engineBeamMaterial(
        "#0b519f",
        "#010a24",
        2.4,
        0.68,
        0,
      );
      outerGlowMat.uniforms.uRadius.value =
        d.r * 0.48 * ENGINE_GLOW_WIDTH_RATIO;
      const beamGeometry = engineBeamGeometry();
      const mainJet = new THREE.Mesh(beamGeometry, mainJetMat);
      const outerGlow = new THREE.Mesh(beamGeometry.clone(), outerGlowMat);
      mainJet.frustumCulled = false;
      outerGlow.frustumCulled = false;
      mainJet.renderOrder = 5;
      outerGlow.renderOrder = 4;
      const beamFacing = new THREE.Group();
      beamFacing.position.z = d.r * 0.24;
      beamFacing.add(outerGlow, mainJet);
      g.add(beamFacing);
      enableBloom(mainJet);

      engines.push({
        beamFacing,
        coreMat,
        mainJetMat,
        outerGlowMat,
        radius: d.r,
      });
    }
  }

  // ==========================================================================
  // LAYER 4 — three drones on a staged spline program.
  // docked → inspect → orbit → flyby → return. Trails flash on transitions.
  // ==========================================================================
  const DRONES = 3;
  const DRONE_STAGES = [4.5, 8, 6, 3.2, 4.3]; // docked, inspect, orbit, flyby, return
  const TRAIL_PTS = 40;
  interface Drone {
    body: THREE.Sprite;
    lamp: THREE.Sprite;
    trail: THREE.Line;
    trailPos: Float32Array;
    trailColors: Float32Array;
    trailHeat: number;
    clock: number;
    offset: number;
    lastStage: number;
    dockU: number;
    dockK: number;
    inspectK: number;
    flyby: Float32Array; // 12 floats bezier controls
    ret: Float32Array;
    orbitPhase: number;
    weld: number;
    pos: THREE.Vector3;
    prev: THREE.Vector3;
  }
  const drones: Drone[] = [];
  const phaseOut: StagePhase = { index: 0, u: 0 };
  {
    for (let i = 0; i < DRONES; i++) {
      const body = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          color: new THREE.Color("#ffffff"),
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      body.scale.setScalar(1.25);
      scene.add(body);
      const lamp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          color: new THREE.Color("#ff7a55"),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      lamp.scale.setScalar(1.6);
      scene.add(lamp);

      const trailPos = new Float32Array(TRAIL_PTS * 3);
      const trailColors = new Float32Array(TRAIL_PTS * 3);
      const tGeo = new THREE.BufferGeometry();
      tGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
      tGeo.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
      const trail = new THREE.Line(
        tGeo,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      scene.add(trail);
      enableBloom(trail);

      drones.push({
        body,
        lamp,
        trail,
        trailPos,
        trailColors,
        trailHeat: 0,
        clock: rand() * 26,
        offset: rand() * 26,
        lastStage: -1,
        dockU: 0.12 + rand() * 0.4,
        dockK: rand() < 0.5 ? 1 : 9,
        inspectK: rand() < 0.5 ? 2 : 8,
        flyby: new Float32Array(12),
        ret: new Float32Array(12),
        orbitPhase: rand() * Math.PI * 2,
        weld: 0,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
      });
    }
  }

  // ==========================================================================
  // LAYER 5 — background: five parallax speeds, one travel vector (+Z drift
  // relative to the ship; the world streams sternward past the camera).
  // ==========================================================================

  // far: three star populations with independent density, size and colour
  // temperature. Only the scarce primary stars enter the bloom layer.
  interface StarLayer {
    points: THREE.Points;
    rate: number;
    baseSize: number;
    baseZ: Float32Array;
  }
  const starLayers: StarLayer[] = [];
  interface NebulaLayer {
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
    base: THREE.Vector3;
    rate: number;
    depthRate: number;
    baseOpacity: number;
  }
  const nebulaLayers: NebulaLayer[] = [];
  interface ClusterLayer {
    points: THREE.Points;
    base: THREE.Vector3;
    rate: number;
    phase: number;
  }
  const clusterLayers: ClusterLayer[] = [];
  interface DustLayer {
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
    base: THREE.Vector3;
    rate: number;
    depthRate: number;
    tilt: number;
    baseOpacity: number;
  }
  const dustLayers: DustLayer[] = [];
  {
    for (const def of [
      {
        n: 1200,
        rMin: 390,
        rMax: 690,
        size: 0.78,
        rate: VOYAGE_PARALLAX_RATES.farStars,
        o: 0.38,
        light: 0.5,
        bloom: false,
      },
      {
        n: 220,
        rMin: 300,
        rMax: 520,
        size: 1.55,
        rate: VOYAGE_PARALLAX_RATES.brightStars,
        o: 0.62,
        light: 0.7,
        bloom: false,
      },
      {
        n: 18,
        rMin: 330,
        rMax: 560,
        size: 3.3,
        rate: VOYAGE_PARALLAX_RATES.farStars * 1.3,
        o: 0.9,
        light: 0.9,
        bloom: true,
      },
    ]) {
      const positions = new Float32Array(def.n * 3);
      const colors = new Float32Array(def.n * 3);
      const baseZ = new Float32Array(def.n);
      for (let i = 0; i < def.n; i++) {
        const r = def.rMin + rand() * (def.rMax - def.rMin);
        const th = rand() * Math.PI * 2;
        const ph = Math.acos(2 * rand() - 1);
        positions[i * 3] = r * Math.sin(ph) * Math.cos(th);
        positions[i * 3 + 1] = def.bloom ? -82 + rand() * 102 : r * Math.cos(ph) * 0.6;
        positions[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        baseZ[i] = positions[i * 3 + 2];
        const warm = rand() < 0.2;
        const color = new THREE.Color().setHSL(
          warm ? 0.095 + rand() * 0.035 : 0.52 + rand() * 0.08,
          warm ? 0.22 : 0.18 + rand() * 0.28,
          def.light * (0.72 + rand() * 0.28),
        );
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const pts = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size: def.size,
          vertexColors: true,
          transparent: true,
          opacity: def.o,
          map: glow,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
          sizeAttenuation: true,
        }),
      );
      pts.renderOrder = -3;
      scene.add(pts);
      if (def.bloom) enableBloom(pts);
      starLayers.push({ points: pts, rate: def.rate, baseSize: def.size, baseZ });
    }

    // Several bounded billboards form one local right-rear nebula volume.
    // Their broken masks overlap at different depths without washing the frame.
    for (const d of [
      { x: -82, y: 205, z: -520, w: 235, h: 145, o: 0.42, seed: 1.7, rate: 0.24, depthRate: 0.72 },
      { x: -12, y: 135, z: -410, w: 175, h: 105, o: 0.34, seed: 8.3, rate: 0.34, depthRate: 0.9 },
      { x: -145, y: 290, z: -620, w: 155, h: 105, o: 0.28, seed: 12.6, rate: 0.18, depthRate: 0.58 },
      { x: 32, y: 65, z: -340, w: 140, h: 78, o: 0.24, seed: 17.4, rate: 0.42, depthRate: 1.12 },
      { x: -178, y: 185, z: -550, w: 110, h: 68, o: 0.2, seed: 21.8, rate: 0.28, depthRate: 0.78 },
    ]) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: d.o },
          uPulse: { value: 0 },
          uSeed: { value: d.seed },
          uBlue: { value: NEBULA_BLUE.clone() },
          uTeal: { value: NEBULA_TEAL.clone() },
          uPurple: { value: NEBULA_PURPLE.clone() },
        },
        vertexShader: NEBULA_VERTEX,
        fragmentShader: NEBULA_FRAGMENT,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), material);
      const base = new THREE.Vector3(d.x, d.y, d.z);
      mesh.position.copy(base);
      mesh.renderOrder = -4;
      scene.add(mesh);
      nebulaLayers.push({
        mesh,
        base,
        rate: d.rate,
        depthRate: VOYAGE_PARALLAX_RATES.deepGas * d.depthRate,
        baseOpacity: d.o,
      });
    }

    // Localized star clusters break the even procedural scatter. They stay
    // outside bloom so the eye reads depth and galactic structure, not glitter.
    for (const d of [
      { n: 250, x: -168, y: 104, z: -430, sx: 29, sy: 11, sz: 22, size: 1.04, rate: 0.018, phase: 0.7 },
      { n: 155, x: 176, y: -74, z: -350, sx: 22, sy: 9, sz: 17, size: 0.9, rate: 0.027, phase: 2.9 },
    ]) {
      const positions = new Float32Array(d.n * 3);
      const colors = new Float32Array(d.n * 3);
      for (let i = 0; i < d.n; i++) {
        const gx = (rand() + rand() + rand() + rand() - 2) * 0.72;
        const gy = (rand() + rand() + rand() + rand() - 2) * 0.72;
        const gz = (rand() + rand() + rand() + rand() - 2) * 0.72;
        positions[i * 3] = gx * d.sx;
        positions[i * 3 + 1] = gy * d.sy;
        positions[i * 3 + 2] = gz * d.sz;
        const core = Math.max(0, 1 - Math.hypot(gx, gy) * 0.58);
        const color = new THREE.Color().setHSL(
          rand() < 0.16 ? 0.09 : 0.54 + rand() * 0.045,
          0.18 + rand() * 0.22,
          0.46 + core * 0.2,
        );
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size: d.size,
          vertexColors: true,
          transparent: true,
          opacity: 0.66,
          map: glow,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
          sizeAttenuation: true,
        }),
      );
      const base = new THREE.Vector3(d.x, d.y, d.z);
      points.position.copy(base);
      points.renderOrder = -2;
      scene.add(points);
      clusterLayers.push({ points, base, rate: d.rate, phase: d.phase });
    }

    // Local molecular lanes sit just in front of the matching nebula regions.
    for (const d of [
      { x: -65, y: 204, z: -485, w: 190, h: 80, o: 0.72, seed: 4.7, rate: 0.3, depthRate: 1.08, tilt: -0.16 },
      { x: -20, y: 145, z: -404, w: 130, h: 55, o: 0.58, seed: 10.9, rate: 0.38, depthRate: 1.24, tilt: 0.11 },
      { x: -122, y: 252, z: -565, w: 110, h: 60, o: 0.52, seed: 15.2, rate: 0.22, depthRate: 0.92, tilt: -0.08 },
      { x: 28, y: 72, z: -326, w: 100, h: 42, o: 0.42, seed: 19.6, rate: 0.46, depthRate: 1.42, tilt: 0.14 },
    ]) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uOpacity: { value: d.o },
          uPulse: { value: 0 },
          uSeed: { value: d.seed },
          uCold: { value: DUST_COLD.clone() },
          uWarm: { value: DUST_WARM.clone() },
        },
        vertexShader: NEBULA_VERTEX,
        fragmentShader: DUST_FRAGMENT,
        transparent: true,
        blending: THREE.NormalBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), material);
      const base = new THREE.Vector3(d.x, d.y, d.z);
      mesh.position.copy(base);
      mesh.renderOrder = -1;
      scene.add(mesh);
      dustLayers.push({
        mesh,
        base,
        rate: d.rate,
        depthRate: VOYAGE_PARALLAX_RATES.deepGas * d.depthRate,
        tilt: d.tilt,
        baseOpacity: d.o,
      });
    }
  }

  // mid: a distant dark planet + far convoy lights (scale events, not noise)
  let planetGroup: THREE.Group;
  let planetGlow: THREE.Sprite;
  const planetBase = new THREE.Vector3(-71, 245, -463);
  {
    // A dim physical sphere: the lit limb now belongs to the body instead of
    // surviving as a disconnected arc when the night side falls to black.
    planetGroup = new THREE.Group();
    const R = 65;
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(R, 48, 32),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#061016"),
        emissive: new THREE.Color("#010304"),
        emissiveIntensity: 0.35,
        roughness: 1,
        metalness: 0,
        fog: false,
      }),
    );
    planetGroup.add(body);
    planetGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glow,
        color: new THREE.Color("#0e2436"),
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    planetGlow.scale.setScalar(R * 2.75);
    planetGroup.add(planetGlow);
    planetGroup.position.copy(planetBase);
    scene.add(planetGroup);
  }
  // far traffic: two tiny convoy lights crawling across the deep field
  const farShips: {
    sprite: THREE.Sprite;
    x: number;
    y: number;
    z: number;
    sp: number;
    rate: number;
    ph: number;
  }[] = [];
  {
    for (const d of [
      { x: 210, y: 40, z: -420, sp: 1.6, rate: 1.12, c: "#6fb6c9" },
      { x: -260, y: -70, z: -380, sp: 1.1, rate: 0.86, c: "#c9a06f" },
    ]) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          color: new THREE.Color(d.c),
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        }),
      );
      sp.scale.setScalar(2.6);
      sp.position.set(d.x, d.y, d.z);
      scene.add(sp);
      farShips.push({
        sprite: sp,
        x: d.x,
        y: d.y,
        z: d.z,
        sp: d.sp,
        rate: VOYAGE_PARALLAX_RATES.landmarks * d.rate,
        ph: rand() * Math.PI * 2,
      });
    }
  }

  // near: fast streaks + motes crossing the lens
  const STREAKS = 32;
  let streaks: THREE.LineSegments;
  let streakColors: Float32Array;
  const streakSeeds: { x: number; y: number; z: number; len: number; sp: number }[] = [];
  {
    const positions = new Float32Array(STREAKS * 6);
    streakColors = new Float32Array(STREAKS * 6);
    for (let i = 0; i < STREAKS; i++) {
      streakSeeds.push({
        x: (rand() - 0.5) * 130,
        y: -48 + rand() * 62,
        z: rand() * 420 - 210,
        len: 2 + rand() * 7,
        sp: 0.7 + rand() * 0.9,
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(streakColors, 3));
    streaks = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    scene.add(streaks);
  }

  const MOTES = 56;
  let motes: THREE.Points;
  const moteSeeds: { x: number; y: number; z: number; sp: number }[] = [];
  const safeZoneProbe = new THREE.Vector3();
  {
    const positions = new Float32Array(MOTES * 3);
    for (let i = 0; i < MOTES; i++) {
      moteSeeds.push({
        x: (rand() - 0.5) * 150,
        y: -58 + rand() * 70,
        z: rand() * 420 - 210,
        sp: 0.8 + rand() * 1.4,
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    motes = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.9,
        color: new THREE.Color("#4d7d95"),
        transparent: true,
        opacity: 0.5,
        map: glow,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    scene.add(motes);
  }

  // --- transcend particles: the hull briefly de-rezzes at climax -----------
  const TPARTS = 480;
  let tParticles: THREE.Points;
  let tPositions: Float32Array;
  let tHome: Float32Array;
  let tDir: Float32Array;
  {
    tPositions = new Float32Array(TPARTS * 3);
    tHome = new Float32Array(TPARTS * 3);
    tDir = new Float32Array(TPARTS * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < TPARTS; i++) {
      const u = rand() * 0.9 + 0.02;
      const k = Math.floor(rand() * CHINES);
      const k1 = (k + 1) % CHINES;
      const a = new THREE.Vector3();
      chinePoint(u, k, v);
      chinePoint(u, k1, a);
      v.lerp(a, rand());
      tHome[i * 3] = v.x;
      tHome[i * 3 + 1] = v.y;
      tHome[i * 3 + 2] = v.z;
      const n = Math.hypot(v.x, v.y) || 1;
      tDir[i * 3] = (v.x / n) * (2 + rand() * 8);
      tDir[i * 3 + 1] = (v.y / n) * (2 + rand() * 8);
      tDir[i * 3 + 2] = (rand() - 0.3) * 10;
    }
    tPositions.set(tHome);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(tPositions, 3));
    tParticles = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.7,
        color: new THREE.Color("#8fe4f2"),
        transparent: true,
        opacity: 0,
        map: glow,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    ship.add(tParticles);
  }

  // ==========================================================================
  // Audio plumbing + scene state
  // ==========================================================================
  const BANDS = 48;
  const smoother = new BandSmoother(BANDS, 24, 8);
  const pulse = new AudioPulse();

  // six duty envelopes (values), stepped with attackRelease + compressLevel
  const env = {
    sub: 0,
    lowmid: 0,
    mid: 0,
    highmid: 0,
    treble: 0,
    beat: 0,
  };
  let trendFast = 0;
  let trendSlow = 0;
  // hush: tracks the raw band total so true silence strips the ship down
  // even when the slow trend still reads "cruise"
  let hush = 0;
  const stateW = new Float32Array(4); // dormant, cruise, charged, transcend
  let travel = 0; // accumulated travel distance (drives all parallax)
  let flowClock = 0;
  let engineParticleClock = 0;
  let nebulaClock = 0;
  let camSway = 0;
  let breath = 0;
  let shudder = 0;
  let shudderVel = 0;
  let engineBeat = 0;
  let previousEngineImpact = 0;
  let engineBeatCooldown = 0;

  // --- the pulse system: beat packets born at the bow travel toward the stern
  const PULSES = 6;
  const pulseU = new Float32Array(PULSES); // head position along hull
  const pulseE = new Float32Array(PULSES); // packet energy
  const pulseLane = new Int8Array(PULSES); // which conduit carries it
  let pulseCooldown = 0;
  let lastBeat = 0;
  let nextLane = 0;
  const bayFlash = new Float32Array(BAY_COUNT); // lit as pulses pass
  const bayLink = new Float32Array(BAY_COUNT); // climax sequential link

  // scratch objects — zero per-frame allocation
  const colA = new THREE.Color();
  const colB = new THREE.Color();
  const colEnergy = new THREE.Color();
  const colFlow = new THREE.Color();
  const colBeat = new THREE.Color("#ffe9c4");
  const colCoral = new THREE.Color();
  const colSector = new THREE.Color();
  const colSectorAlt = new THREE.Color();
  const colSectorDeep = new THREE.Color();
  const colStar = new THREE.Color();
  const colIce = new THREE.Color();
  const colDebris = new THREE.Color();
  const colWeather = new THREE.Color();
  const vec = new THREE.Vector3();
  const vecB = new THREE.Vector3();
  const bez = new Float32Array(3);

  // composition: ship center ~60% down-frame, stern x≈27%, bow x≈78%,
  // flames held inside y 42–66% — the top-left title zone stays empty
  const camPos = new THREE.Vector3(58, -30, 78);
  const camLook = new THREE.Vector3(-32, 15, -50);

  camera.fov = 46;
  camera.updateProjectionMatrix();
  camera.position.copy(camPos);
  camera.lookAt(camLook);

  function render(frame: ThreeFrame): void {
    const { freq, dt, elapsed } = frame;
    const mood = frame.mood ?? neutralMoodState();
    const themeHue = frame.options.themeHue ?? 171;
    const atmosphere = voyageAtmosphere(mood);
    const sectorHue = (((themeHue + atmosphere.hueShift) % 360) + 360) % 360 / 360;
    const materialPreview = frame.options.materialPreview === 1;
    const backgroundPass = Math.round(frame.options.backgroundPass ?? 0);
    const backgroundOnly = backgroundPass > 0;
    const compositionVisibility = backgroundOnly ? 0 : 1;
    const spaceLayerVisibility = backgroundPass === 1 ? 0 : 1;
    const effectVisibility = materialPreview ? 0 : compositionVisibility;
    const backgroundVisibility = materialPreview ? 0.08 : 1;
    const localSpaceVisibility = backgroundVisibility * spaceLayerVisibility;
    const lineVisibility = frame.options.wireframe === 0 ? 0 : compositionVisibility;
    const motion = frame.prefersReducedMotion ? 0.15 : 1;
    ship.visible = !backgroundOnly;
    planetGroup.visible = localSpaceVisibility > 0;

    // ---- band analysis → compressed, envelope-followed duties -------------
    const bands = smoother.step(bandLevels(freq, BANDS), dt);
    const rawEnergy = energyLevel(freq);
    const rawBass = bassLevel(freq);
    const p = pulse.update(rawEnergy, rawBass, dt);

    let sub = 0;
    let lowmid = 0;
    let mid = 0;
    let highmid = 0;
    let treble = 0;
    for (let i = 0; i < BANDS; i++) {
      const v = bands[i];
      if (i < 5) sub += v;
      else if (i < 12) lowmid += v;
      else if (i < 24) mid += v;
      else if (i < 36) highmid += v;
      else treble += v;
    }
    env.sub = attackRelease(env.sub, compressLevel(sub / 5, 2.2), dt, 0.05, 0.32);
    env.lowmid = attackRelease(env.lowmid, compressLevel(lowmid / 7, 2.4), dt, 0.08, 0.45);
    env.mid = attackRelease(env.mid, compressLevel(mid / 12, 2.6), dt, 0.1, 0.55);
    env.highmid = attackRelease(env.highmid, compressLevel(highmid / 12, 2.8), dt, 0.05, 0.3);
    env.treble = attackRelease(env.treble, compressLevel(treble / 12, 3.2), dt, 0.02, 0.16);
    env.beat = attackRelease(env.beat, p.impact, dt, 0.012, 0.22);

    // energy trend: fast vs slow EMA → state weights
    trendFast = attackRelease(trendFast, p.energy, dt, 1.2, 2.4);
    trendSlow = attackRelease(trendSlow, p.energy, dt, 3.5, 6);
    const surge = Math.max(0, trendFast - trendSlow) * 3 + mood.buildUp * 0.5;
    voyageStateWeights(
      Math.min(1, trendSlow * 1.35 + mood.arousal * 0.15),
      Math.min(1, surge),
      stateW,
    );
    const wDormant = stateW[0];
    const wCruise = stateW[1];
    const wCharged = stateW[2];
    const wTranscend = stateW[3];
    // loudness gate: total envelope mapped through a steep knee, so the
    // Silent Running leg (faint ember spectrum) reads structurally hollow
    const loud = env.sub * 0.9 + env.lowmid + env.mid + env.highmid * 0.7 + env.treble * 0.4;
    hush = attackRelease(hush, Math.min(1, Math.max(0, (loud - 0.22) / 0.75)), dt, 0.9, 2.2);
    const alive = (1 - wDormant) * (0.25 + hush * 0.75); // structural integrity 0..1

    // ---- mood atmosphere: one ship, five emotional navigation sectors ------
    const ionFlash = atmosphere.ion * Math.min(1, env.beat * 1.25 + Math.max(0, mood.swell) * 0.12);
    colSector.setHSL(sectorHue, 0.72, 0.54);
    colSectorAlt.setHSL((sectorHue + 0.11) % 1, 0.66, 0.42);
    colSectorDeep.setHSL((sectorHue + 0.56) % 1, 0.48, 0.075);
    colStar.copy(STAR_NEUTRAL);
    colIce.setHSL((sectorHue + 0.035) % 1, 0.24, 0.9);
    colDebris.setHSL((sectorHue + 0.1) % 1, 0.38, 0.62);

    if (materialPreview) {
      renderer.toneMappingExposure = 1.18;
      bloomPass.strength = 0;
      ambientLight.color.setHex(0xf2eee6);
      ambientLight.groundColor.setHex(0x252b2e);
      ambientLight.intensity = 0.98;
      nebulaFill.color.setHex(0xfff7e8);
      nebulaFill.intensity = 1.32;
      rimLight.color.setHex(0xe8edf0);
      rimLight.intensity = 0.86;
    } else {
      renderer.toneMappingExposure = 1.06;
      bloomPass.strength =
        frame.options.bloom === 0 ? 0 : 0.18 * atmosphere.bloom + ionFlash * 0.16;
      ambientLight.color.copy(AMBIENT_NEUTRAL);
      ambientLight.groundColor.copy(GROUND_NEUTRAL);
      ambientLight.intensity = 0.98 + atmosphere.starClarity * 0.06;
      nebulaFill.color.copy(FILL_NEUTRAL).lerp(colSectorAlt, 0.08);
      nebulaFill.intensity = 0.82 + atmosphere.nebula * 0.14 + ionFlash * 0.1;
      rimLight.color.copy(RIM_NEUTRAL).lerp(colSector, 0.05);
      rimLight.intensity = 1.46 + mood.arousal * 0.12 + ionFlash * 0.15;
    }

    // Music changes the armor's presence without making the ship disappear:
    // even dormant facets retain a readable neutral titanium floor.
    const massLift =
      materialPreview
        ? 1
        : Math.min(1.06, 0.88 + alive * 0.14 + wCharged * 0.02 + mood.valence * 0.02);
    hullMat.color.setScalar(massLift);
    superMat.color.setScalar(materialPreview ? 1 : massLift * 0.98);

    // Sector color reaches the ship's signal layers while armor stays neutral.
    const eHue = (sectorHue + (mood.valence - 0.5) * 0.025 + 1) % 1;
    colEnergy.setHSL(eHue, 0.82, 0.58);
    colFlow.copy(colEnergy).lerp(colStar, 0.42);
    colA.setHSL(sectorHue, 0.09, 0.32); // soft, nearly neutral silhouette base
    colB.setHSL(sectorHue, 0.12, 0.29); // restrained structure base
    colCoral.setHSL(0.04, 0.85, 0.6);
    for (const material of hullMarkMaterials) {
      material.color.copy(colStar).lerp(colA, materialPreview ? 0.58 : 0.74);
      material.emissive.copy(colStar).lerp(colB, 0.84);
      material.emissiveIntensity = materialPreview
        ? 0.1
        : 0.035 + alive * 0.045 + ionFlash * 0.025;
      material.opacity = materialPreview
        ? 0.36
        : (0.22 + alive * 0.1 + ionFlash * 0.04) * effectVisibility;
    }
    const catBreathGlow = logoBreathLevel(elapsed, frame.prefersReducedMotion);
    const catBeatGlow = Math.min(1, p.impact * 1.2 + env.beat * 0.9);
    hullCatGlowMaterial.color.copy(colEnergy).lerp(colStar, 0.36 + catBreathGlow * 0.2);
    hullCatGlowMaterial.opacity =
      logoGlowOpacity(catBreathGlow, catBeatGlow, alive) * effectVisibility;
    const catGlowScale = 1.025 + catBreathGlow * 0.055 + catBeatGlow * 0.025;
    hullCatGlowMesh.scale.setScalar(catGlowScale);

    // ---- travel: one shared vector, speed from state + energy -------------
    const thrust = 0.16 + alive * 0.5 + wCharged * 0.7 + wTranscend * 1.1 + env.sub * 0.5;
    const speed = Math.min(4.2, thrust * atmosphere.travelScale) * motion;
    travel += dt * speed * 46;
    flowClock += dt * (0.78 + mood.arousal * 0.65 + mood.wind * 0.35) * motion;
    engineParticleClock += dt * motion;
    nebulaClock +=
      dt *
      (0.14 + atmosphere.nebula * 0.3 + mood.wind * 0.18 + Math.min(1, p.energy * 2.5) * 0.14) *
      motion;
    const pinnedBackgroundTime = frame.options.backgroundTime ?? -1;
    const backgroundClock = pinnedBackgroundTime >= 0 ? pinnedBackgroundTime : nebulaClock;
    const backgroundTravel = pinnedBackgroundTime >= 0 ? pinnedBackgroundTime * 46 : travel;

    // hull breathing (sub) + bass shock shudder (spring)
    breath = attackRelease(breath, env.sub, dt, 0.09, 0.5);
    shudderVel += (-shudder * 46 - shudderVel * 7.5) * dt;
    shudderVel += env.beat * dt * 34;
    shudder += shudderVel * dt;

    const breathScale = 1 + breath * 0.012 + shudder * 0.01;
    const drift = (0.38 + mood.arousal * 0.72 + mood.wind * 0.42) * motion;
    ship.scale.set(breathScale, breathScale, 1);
    ship.position.y =
      -18 + Math.sin(elapsed * 0.21) * drift + mood.swell * 0.48 * motion + shudder * 0.35;
    ship.position.x = 5 + Math.sin(elapsed * 0.147 + 1.7) * drift * 0.78;
    ship.rotation.z =
      Math.sin(elapsed * 0.117 + 0.6) *
      (0.012 + mood.tension * 0.018 + mood.wind * 0.014) *
      motion;
    ship.rotation.x =
      Math.sin(elapsed * 0.171) * (0.007 + mood.arousal * 0.008) * motion;

    // ---- pulse system: beats launch energy packets at the bow that --------
    // travel aft along the conduits, lighting bays and nodes as they pass.
    {
      pulseCooldown -= dt;
      const rising = env.beat > 0.42 && env.beat > lastBeat + 0.015;
      if (rising && pulseCooldown <= 0) {
        for (let i = 0; i < PULSES; i++) {
          if (pulseE[i] <= 0.02) {
            pulseU[i] = BOW_CLIP - 0.01;
            pulseE[i] = Math.min(1, 0.45 + env.beat * 0.6);
            pulseLane[i] = nextLane;
            nextLane = (nextLane + 1) % conduits.length;
            pulseCooldown = 0.15;
            break;
          }
        }
      }
      lastBeat = env.beat;
      const rate = (0.14 + env.lowmid * 0.3 + wCharged * 0.12) * motion;
      for (let i = 0; i < PULSES; i++) {
        if (pulseE[i] <= 0.02) continue;
        pulseU[i] -= dt * rate * (0.8 + pulseE[i] * 0.5);
        pulseE[i] *= Math.exp(-dt * 0.5);
        if (pulseU[i] < 0) pulseE[i] = 0;
        const b = bayIdxOfU(pulseU[i]);
        if (pulseU[i] > BAY_U0 && pulseU[i] < BAY_U0 + BAY_COUNT * BAY_PITCH) {
          bayFlash[b] = Math.max(bayFlash[b], pulseE[i]);
        }
      }
      // climax: bays link up bow→stern one after another and hold
      const linkN = (wCharged * 0.9 + wTranscend * 1.5) * BAY_COUNT;
      for (let b = 0; b < BAY_COUNT; b++) {
        const orderFromBow = BAY_COUNT - 1 - b;
        const target = Math.max(0, Math.min(1, linkN - orderFromBow));
        bayLink[b] = attackRelease(bayLink[b], target, dt, 0.25 + orderFromBow * 0.1, 1.1);
        bayFlash[b] *= Math.exp(-dt * 2.4);
      }
    }

    // ---- layer 1: soft outline with a continuous bow→stern light sweep ----
    {
      const base = 0.22 + alive * 0.16 + wTranscend * 0.06;
      const beatLift = env.beat * 0.16;
      const sweepHead = bowToSternFlowU(flowClock, 0.18, 0.08) * BOW_CLIP;
      const n = silBase.length;
      for (let i = 0; i < n; i++) {
        const w = silBase[i];
        const distance = silU[i] - sweepHead;
        const sweep = Math.exp(-(distance * distance) / (2 * 0.065 * 0.065));
        const amp = w * (base + beatLift * w + sweep * (0.24 + env.lowmid * 0.18));
        const flowMix = Math.min(0.68, sweep * 0.58 + beatLift * 0.18);
        silColors[i * 3] = (colA.r * (1 - flowMix) + colFlow.r * flowMix) * amp * 1.3;
        silColors[i * 3 + 1] =
          (colA.g * (1 - flowMix) + colFlow.g * flowMix) * amp * 1.3;
        silColors[i * 3 + 2] =
          (colA.b * (1 - flowMix) + colFlow.b * flowMix) * amp * 1.3;
      }
      (silhouette.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
      silhouetteMat.opacity = (0.48 - wTranscend * 0.1) * lineVisibility;
    }

    // ---- structure layer: broad, soft scan follows the same bow→stern flow -
    {
      const reveal = env.mid * (0.55 + wCharged * 0.45) + wTranscend * 0.5;
      const quiet = 0.2 + alive * 0.8; // dormant: structure sleeps, outline holds
      const n = structBand.length;
      const wavePos = bowToSternFlowU(flowClock, 0.16, 0.3) * BOW_CLIP;
      for (let i = 0; i < n; i++) {
        const u = structBand[i];
        const j = structJitter[i];
        // staggered gate: each frame band lights when reveal passes its slot
        const gate = Math.max(0, Math.min(1, (reveal - u * 0.55 - j * 0.18) * 3.2));
        const distance = u - wavePos;
        const wave = Math.exp(-(distance * distance) / (2 * 0.075 * 0.075));
        // bay flash bleeds into the bulkheads of the segment it lights
        const bf = bayFlash[bayIdxOfU(u)] * 0.55 + bayLink[bayIdxOfU(u)] * 0.3;
        const amp =
          (gate * (0.12 + reveal * 0.24) * (0.55 + wCruise * 0.25 + wCharged * 0.45) +
            wave * (0.14 + env.mid * 0.18) +
            bf) *
          quiet;
        const flowMix = Math.min(0.62, wave * 0.56);
        structColors[i * 3] = (colB.r * (1 - flowMix) + colFlow.r * flowMix) * amp * 1.25;
        structColors[i * 3 + 1] =
          (colB.g * (1 - flowMix) + colFlow.g * flowMix) * amp * 1.25;
        structColors[i * 3 + 2] =
          (colB.b * (1 - flowMix) + colFlow.b * flowMix) * amp * 1.25;
      }
      (structure.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
      (structure.material as THREE.LineBasicMaterial).opacity = 0.42 * lineVisibility;
      (superLines.material as THREE.LineBasicMaterial).opacity =
        (0.04 + alive * 0.12 + env.mid * 0.05) * lineVisibility;
      bowBoomMaterial.opacity = 0.4 * lineVisibility;
      mastMaterial.opacity = 0.28 * lineVisibility;
    }

    // ---- energy layer: continuous soft flow plus beat packets bow→stern ---
    {
      const drive = env.lowmid;
      const bright = 0.45 + drive * 1.25 + wCharged * 0.5 + wTranscend * 0.6;
      for (let ci = 0; ci < conduits.length; ci++) {
        const c = conduits[ci];
        const base = 0.014 + alive * 0.028 + wCharged * 0.026;
        const flowU0 = bowToSternFlowU(flowClock, c.rate, c.head + c.lag) * BOW_CLIP;
        const flowU1 = bowToSternFlowU(flowClock, c.rate, c.head + c.lag + 0.5) * BOW_CLIP;
        for (let i = 0; i < ENERGY_PTS; i++) {
          const u = (i / (ENERGY_PTS - 1)) * (BOW_CLIP - 0.01) + 0.005;
          let amp = base;
          let continuous = 0;
          for (let fi = 0; fi < 2; fi++) {
            const flowU = fi === 0 ? flowU0 : flowU1;
            const d = u - flowU;
            const head = Math.exp(-(d * d) / (2 * 0.034 * 0.034));
            const tail = d > 0 && d < 0.16 ? (1 - d / 0.16) ** 2 * 0.28 : 0;
            continuous += head * 0.58 + tail;
          }
          amp += continuous * (0.16 + alive * 0.12 + drive * 0.24);
          for (let pi = 0; pi < PULSES; pi++) {
            if (pulseE[pi] <= 0.02 || pulseLane[pi] !== ci) continue;
            const d = u - pulseU[pi];
            // The packet moves aft, so its soft tail remains bow-ward.
            const sigma = 0.018 + pulseE[pi] * 0.014;
            const head = Math.exp((-d * d) / (2 * sigma * sigma));
            const tail = d > 0 && d < 0.16 ? (1 - d / 0.16) * 0.28 : 0;
            amp += (head + tail) * pulseE[pi] * bright;
          }
          amp *= effectVisibility;
          c.colors[i * 3] = colFlow.r * amp;
          c.colors[i * 3 + 1] = colFlow.g * amp;
          c.colors[i * 3 + 2] = colFlow.b * amp;
        }
        (c.line.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
        (c.line.material as THREE.LineBasicMaterial).opacity = 0.58 * lineVisibility;
        for (let fi = 0; fi < 2; fi++) {
          const flowU = fi === 0 ? flowU0 : flowU1;
          chinePoint(flowU, c.k, vec);
          const profile = daggerProfile(flowU);
          c.markerPositions[fi * 3] = vec.x * 1.01;
          c.markerPositions[fi * 3 + 1] = vec.y + c.lift + profile.halfHeight * 0.02;
          c.markerPositions[fi * 3 + 2] = vec.z;
        }
        (c.markers.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        const markerMaterial = c.markers.material as THREE.PointsMaterial;
        markerMaterial.color.copy(colFlow);
        markerMaterial.opacity =
          (0.16 + alive * 0.12 + drive * 0.16 + wCharged * 0.08) * lineVisibility;
        markerMaterial.size = 1.8 + drive * 0.7 + env.beat * 0.35;
      }
      // spine nodes flare as a packet passes through them
      for (let i = 0; i < NODES; i++) {
        const nodeU = 0.1 + (i / (NODES - 1)) * 0.62;
        let hit = 0;
        for (let pi = 0; pi < PULSES; pi++) {
          if (pulseE[pi] <= 0.02 || pulseLane[pi] !== 0) continue;
          const d = Math.abs(nodeU - pulseU[pi]);
          if (d < 0.05) hit = Math.max(hit, (1 - d / 0.05) * pulseE[pi]);
        }
        const m = nodeSprites[i].material as THREE.SpriteMaterial;
        m.opacity = (0.04 + hit * 0.9) * alive * effectVisibility;
        m.color.copy(colFlow);
        nodeSprites[i].scale.setScalar(1.6 + hit * 2.4);
      }
      // armor bay edges: lit only by passing pulses or the climax link
      const nB = bayEdgeIdx.length;
      for (let i = 0; i < nB; i++) {
        const b = bayEdgeIdx[i];
        const amp = (0.015 + bayFlash[b] * 0.8 + bayLink[b] * 0.42) * effectVisibility;
        bayColors[i * 3] = colFlow.r * amp;
        bayColors[i * 3 + 1] = colFlow.g * amp;
        bayColors[i * 3 + 2] = colFlow.b * amp;
      }
      (bayLines.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
      (bayLines.material as THREE.LineBasicMaterial).opacity = 0.42 * lineVisibility;
    }

    // ---- portholes + windows + lamps: the ship's small life ---------------
    {
      const fieldBase = 0.07 + alive * 0.21;
      for (let i = 0; i < PORT_COUNT; i++) {
        const tw = Math.sin(elapsed * 0.9 + portPhase[i]) * 0.5 + 0.5;
        // treble sparks: only phase-aligned few — high freq must NOT strobe all
        const sparkGate = Math.sin(portPhase[i] * 7.31 + flowClock * 2.1);
        const spark = sparkGate > 0.93 ? env.treble * 1.6 : 0;
        const b = bayIdxOfU(portU[i]);
        const bf = bayFlash[b] * 0.9 + bayLink[b] * 0.55;
        const amp =
          (fieldBase * (0.5 + tw * 0.5) * (0.6 + bf * 1.6) + spark + bf * 0.1) *
          portOn[i] *
          effectVisibility;
        const warmMix = spark > 0.2 ? 0.55 : 0.12;
        portColors[i * 3] = (colB.r * (1 - warmMix) + colBeat.r * warmMix) * amp * 2;
        portColors[i * 3 + 1] = (colB.g * (1 - warmMix) + colBeat.g * warmMix) * amp * 2;
        portColors[i * 3 + 2] = (colB.b * (1 - warmMix) + colBeat.b * warmMix) * amp * 2;
      }
      (ports.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;

      // bridge windows: warm, sparse, alive on high-mids
      const wBase = 0.09 + alive * 0.2;
      const nW = bridgeWinPhase.length;
      for (let i = 0; i < nW; i++) {
        const tw = Math.sin(elapsed * 1.15 + bridgeWinPhase[i]) * 0.5 + 0.5;
        const gate = Math.sin(bridgeWinPhase[i] * 5.13 + flowClock * 1.7);
        const flick = gate > 0.88 ? env.highmid * 1.1 : 0;
        const amp = (wBase * (0.55 + tw * 0.45) + flick) * effectVisibility;
        bridgeWinColors[i * 3] = (colBeat.r * 0.62 + colB.r * 0.38) * amp * 2;
        bridgeWinColors[i * 3 + 1] = (colBeat.g * 0.62 + colB.g * 0.38) * amp * 1.9;
        bridgeWinColors[i * 3 + 2] = (colBeat.b * 0.62 + colB.b * 0.38) * amp * 1.8;
      }
      (bridgeWin.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;

      // bow nav beacon: slow coral pulse — the ship's own heartbeat
      const blink = Math.pow(Math.max(0, Math.sin(elapsed * 1.35)), 8);
      (bowLamp.material as THREE.SpriteMaterial).opacity =
        (0.1 + blink * 0.6) * (0.35 + alive * 0.65) * effectVisibility;
      bowLamp.scale.setScalar(1.1 + blink * 0.9);

      // maintenance pad markers: alternating slow blink + highmid activity
      for (let i = 0; i < padLamps.length; i++) {
        const ph = Math.pow(Math.max(0, Math.sin(elapsed * 1.9 + i * 2.4)), 6);
        (padLamps[i].material as THREE.SpriteMaterial).opacity =
          (0.08 + ph * 0.34 + env.highmid * 0.22) * alive * effectVisibility;
      }

      // Upper-deck pools reveal the citadel silhouette and breathe with the
      // high-mid orchestration; ion impacts briefly overdrive each pool.
      for (let i = 0; i < deckLights.length; i++) {
        const deck = deckLights[i];
        const breathe = 0.78 + Math.sin(flowClock * (0.7 + i * 0.06) + deck.phase) * 0.22;
        const level =
          (0.12 +
            alive * 0.32 +
            env.highmid * 0.48 +
            mood.arousal * 0.18 +
            wCharged * 0.15 +
            ionFlash * 0.65) *
          breathe *
          effectVisibility;
        deck.light.color.copy(colStar).lerp(colEnergy, i % 2 === 0 ? 0.18 : 0.38);
        deck.light.intensity = level * 320;
        deck.light.distance = 50 + env.highmid * 16 + ionFlash * 10;
        const material = deck.beacon.material as THREE.SpriteMaterial;
        material.color.copy(deck.light.color);
        material.opacity = Math.min(0.7, level * 0.7);
        deck.beacon.scale.setScalar(1.45 + level * 1.8);
      }

      // spine crawlers: tiny service lights inching bow-ward
      for (const cr of crawlers) {
        const uu = 0.02 + ((cr.off + elapsed * cr.speed) % 0.84);
        chinePoint(uu, 0, vec);
        cr.sprite.position.set(vec.x, vec.y + 0.45, vec.z);
        (cr.sprite.material as THREE.SpriteMaterial).opacity =
          (0.16 + env.highmid * 0.35) * alive * effectVisibility;
      }
    }

    // ---- engines: fixed radius, disciplined three-channel response ---------
    {
      engineBeatCooldown = Math.max(0, engineBeatCooldown - dt);
      const beatHit =
        p.impact > 0.24 &&
        p.impact > previousEngineImpact + 0.025 &&
        engineBeatCooldown <= 0;
      if (beatHit) engineBeatCooldown = 0.08;
      previousEngineImpact = p.impact;
      engineBeat = engineBeatEnvelope(engineBeat, beatHit, dt);

      const lengthScale = engineJetLengthScale(p.bass);
      const coreBrightness = engineCoreBrightnessScale(p.energy);
      ship.updateWorldMatrix(true, false);
      vecB.copy(camera.position);
      ship.worldToLocal(vecB);
      const beamFacing = Math.atan2(vecB.y, vecB.x) - Math.PI / 2;

      for (const eng of engines) {
        const jetLength =
          eng.radius * 2 * ENGINE_JET_LENGTH_DIAMETERS * lengthScale;
        eng.beamFacing.rotation.z = beamFacing;
        eng.mainJetMat.uniforms.uLength.value = jetLength;
        eng.outerGlowMat.uniforms.uLength.value = jetLength * 1.03;
        eng.mainJetMat.uniforms.uParticleOffset.value =
          engineParticleClock * ENGINE_PARTICLE_FLOW_SPEED;
        eng.mainJetMat.uniforms.uParticleAmount.value =
          ENGINE_PARTICLE_OPACITY *
          (0.72 + mood.arousal * 0.38 + env.treble * 0.2) *
          effectVisibility;
        eng.coreMat.uniforms.uIntensity.value =
          0.78 * coreBrightness * (1 + engineBeat * 0.14) * effectVisibility;
        eng.mainJetMat.uniforms.uIntensity.value =
          0.3 * (1 + engineBeat * 0.18) * effectVisibility;
        eng.outerGlowMat.uniforms.uIntensity.value = 0.06 * effectVisibility;
      }
    }

    // ---- drones: staged program, clock speed from highmid + arousal -------
    {
      const clockRate = (0.55 + env.highmid * 0.9 + mood.arousal * 0.35) * motion;
      for (let d = 0; d < DRONES; d++) {
        const dr = drones[d];
        dr.clock += dt * clockRate;
        stagePhase(dr.clock + dr.offset, DRONE_STAGES, phaseOut);
        const st = phaseOut.index;
        const su = phaseOut.u;
        dr.prev.copy(dr.pos);

        if (st !== dr.lastStage) {
          // stage transitions: flash the trail, pick fresh curve controls
          dr.trailHeat = 1;
          if (st === 3) {
            // flyby: from near the hull, sweep close past the camera
            chinePoint(dr.dockU, dr.inspectK, vec);
            dr.flyby.set([
              vec.x * 1.4,
              vec.y + 4,
              vec.z,
              vec.x * 2.6,
              vec.y + 8,
              vec.z + 40,
              camPos.x * 0.7,
              camPos.y + 6,
              camPos.z - 18,
              camPos.x * 1.7,
              camPos.y - 9,
              camPos.z + 30,
            ]);
          } else if (st === 4) {
            // return: from wherever flyby ended back to dock
            chinePoint(dr.dockU, dr.dockK, vecB);
            dr.ret.set([
              dr.pos.x,
              dr.pos.y,
              dr.pos.z,
              dr.pos.x * 0.5,
              dr.pos.y + 10,
              dr.pos.z - 30,
              vecB.x * 1.9,
              vecB.y + 7,
              vecB.z - 12,
              vecB.x * 1.08,
              vecB.y + 0.8,
              vecB.z,
            ]);
          }
          dr.lastStage = st;
        }

        if (st === 0) {
          // docked: hold near hull, tiny service bobbing, weld sparks on beat
          chinePoint(dr.dockU, dr.dockK, vec);
          dr.pos.set(
            vec.x * 1.06 + Math.sin(dr.clock * 3.1) * 0.3,
            vec.y + 0.7 + Math.sin(dr.clock * 2.3) * 0.25,
            vec.z + Math.sin(dr.clock * 1.7) * 0.6,
          );
          dr.weld = Math.max(dr.weld * Math.exp(-dt * 5), env.beat * 0.9);
        } else if (st === 1) {
          // inspect: run a chine line bow-ward and back
          const sweep = su < 0.5 ? su * 2 : 2 - su * 2;
          const u = dr.dockU + sweep * 0.34;
          chinePoint(u, dr.inspectK, vec);
          dr.pos.set(vec.x * 1.12, vec.y + 1.1, vec.z);
          dr.weld *= Math.exp(-dt * 5);
        } else if (st === 2) {
          // orbit: elliptical pass around the hull
          const ang = dr.orbitPhase + su * Math.PI * 2;
          const u = dr.dockU + Math.sin(su * Math.PI) * 0.1;
          const prof = daggerProfile(u);
          dr.pos.set(
            Math.cos(ang) * (prof.halfWidth + 6),
            prof.mid + Math.sin(ang) * (prof.halfHeight + 5),
            DAGGER_STERN_Z - u * DAGGER_LENGTH + Math.sin(ang * 2) * 4,
          );
          dr.weld *= Math.exp(-dt * 5);
        } else if (st === 3) {
          bezier3(dr.flyby, su, bez);
          dr.pos.set(bez[0], bez[1], bez[2]);
          dr.weld *= Math.exp(-dt * 5);
        } else {
          bezier3(dr.ret, su, bez);
          dr.pos.set(bez[0], bez[1], bez[2]);
          dr.weld *= Math.exp(-dt * 5);
        }

        dr.body.position.copy(dr.pos);
        const bodyM = dr.body.material as THREE.SpriteMaterial;
        bodyM.opacity = (0.5 + env.highmid * 0.4) * effectVisibility;
        dr.body.scale.setScalar(0.7 + env.highmid * 0.35);

        // coral weld lamp — the only warm-orange budget in the frame
        dr.lamp.position.copy(dr.pos);
        const lampM = dr.lamp.material as THREE.SpriteMaterial;
        lampM.opacity = dr.weld * 0.8 * effectVisibility;
        lampM.color.copy(colCoral);
        dr.lamp.scale.setScalar(1 + dr.weld * 1.4);

        // trail: shift buffer, head at current pos; heat decays fast
        dr.trailPos.copyWithin(3, 0, (TRAIL_PTS - 1) * 3);
        dr.trailPos[0] = dr.pos.x;
        dr.trailPos[1] = dr.pos.y;
        dr.trailPos[2] = dr.pos.z;
        dr.trailHeat = Math.max(dr.trailHeat * Math.exp(-dt * 1.8), env.beat * 0.5);
        const heat = dr.trailHeat * (0.25 + env.highmid * 0.6);
        for (let i = 0; i < TRAIL_PTS; i++) {
          const fade = (1 - i / TRAIL_PTS) ** 2 * heat * effectVisibility;
          dr.trailColors[i * 3] = colEnergy.r * fade;
          dr.trailColors[i * 3 + 1] = colEnergy.g * fade;
          dr.trailColors[i * 3 + 2] = colEnergy.b * fade;
        }
        (dr.trail.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        (dr.trail.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
        (dr.trail.material as THREE.LineBasicMaterial).opacity = 0.24 * lineVisibility;
      }
    }

    // ---- background: one flight vector, five honest depth speeds -----------
    {
      // Celestial light still moves: every point advances along +Z, but at a
      // minute fraction of the near dust speed. Perspective supplies the
      // outward screen drift, so this reads as translation rather than a
      // rotating wallpaper.
      for (let i = 0; i < starLayers.length; i++) {
        const sl = starLayers[i];
        const position = sl.points.geometry.getAttribute("position") as THREE.BufferAttribute;
        const positions = position.array as Float32Array;
        for (let j = 0; j < sl.baseZ.length; j++) {
          positions[j * 3 + 2] = parallaxDepth(
            sl.baseZ[j],
            backgroundTravel,
            sl.rate,
            STAR_FAR_Z,
            STAR_NEAR_Z,
          );
        }
        position.needsUpdate = true;
        sl.points.rotation.y = Math.sin(backgroundClock * 0.055 + i * 1.7) * 0.004;
        sl.points.rotation.z = Math.sin(backgroundClock * 0.08 + i) * 0.006;
        const material = sl.points.material as THREE.PointsMaterial;
        const base =
          i === 0
            ? 0.36 + env.treble * 0.035
            : i === 1
              ? 0.56 + env.treble * 0.1
              : 0.82 + env.treble * 0.14;
        material.color.copy(colStar);
        material.size = sl.baseSize * (0.96 + atmosphere.starClarity * 0.4);
        material.opacity =
          Math.min(1, base * (0.34 + atmosphere.starClarity * 0.92)) *
          backgroundVisibility;
      }

      for (let i = 0; i < clusterLayers.length; i++) {
        const cluster = clusterLayers[i];
        const depth = parallaxDepth(
          cluster.base.z,
          backgroundTravel,
          cluster.rate,
          LANDMARK_FAR_Z,
          LANDMARK_NEAR_Z,
        );
        const depthFade = parallaxEdgeFade(
          depth,
          LANDMARK_FAR_Z,
          LANDMARK_NEAR_Z,
          46,
        );
        cluster.points.position.x =
          cluster.base.x +
          Math.sin(backgroundTravel * cluster.rate * 0.001 + cluster.phase) * (6 + i * 3);
        cluster.points.position.y =
          cluster.base.y +
          Math.cos(backgroundTravel * cluster.rate * 0.0007 + cluster.phase) * (2.5 + i);
        cluster.points.position.z = depth;
        cluster.points.rotation.z = Math.sin(backgroundClock * 0.08 + cluster.phase) * 0.025;
        const material = cluster.points.material as THREE.PointsMaterial;
        material.color.copy(colStar);
        material.opacity =
          Math.min(0.9, 0.42 + atmosphere.starClarity * (0.45 + env.treble * 0.08)) *
          backgroundVisibility *
          depthFade;
      }

      // Local nebula cells retain black space between their bounded volumes.
      for (let i = 0; i < nebulaLayers.length; i++) {
        const nebula = nebulaLayers[i];
        const driftPhase =
          backgroundTravel * nebula.rate * 0.006 +
          backgroundClock * (0.7 + i * 0.15) +
          i * 1.9;
        const slowBreath = 0.5 + 0.5 * Math.sin(backgroundClock * 1.15 + i * 2.2);
        const pulseLevel = Math.min(
          1,
          0.18 + slowBreath * 0.35 + Math.min(1, p.energy * 2.5) * 0.34 + Math.max(0, mood.swell) * 0.13,
        );
        nebula.mesh.quaternion.copy(camera.quaternion);
        nebula.mesh.position.x = nebula.base.x + Math.sin(driftPhase) * (3 + i * 1.2);
        nebula.mesh.position.y = nebula.base.y + Math.cos(driftPhase * 0.63 + i) * (2 + i * 0.6);
        nebula.mesh.position.z = parallaxDepth(
          nebula.base.z,
          backgroundTravel,
          nebula.depthRate,
          GAS_FAR_Z,
          GAS_NEAR_Z,
        );
        const depthFade = parallaxEdgeFade(
          nebula.mesh.position.z,
          GAS_FAR_Z,
          GAS_NEAR_Z,
          58,
        );
        nebula.mesh.material.uniforms.uTime.value = backgroundClock * (1 + i * 0.35);
        nebula.mesh.material.uniforms.uPulse.value = pulseLevel;
        (nebula.mesh.material.uniforms.uBlue.value as THREE.Color)
          .copy(NEBULA_BLUE)
          .lerp(colSector, 0.14);
        (nebula.mesh.material.uniforms.uTeal.value as THREE.Color)
          .copy(NEBULA_TEAL)
          .lerp(colSectorAlt, 0.12);
        (nebula.mesh.material.uniforms.uPurple.value as THREE.Color)
          .copy(NEBULA_PURPLE)
          .lerp(colSector, 0.04);
        nebula.mesh.material.uniforms.uOpacity.value =
          nebula.baseOpacity *
          (0.45 + atmosphere.nebula * 0.35) *
          (0.88 + Math.min(1, p.energy * 2.2) * 0.08 + ionFlash * 0.08) *
          localSpaceVisibility *
          depthFade;
      }

      for (let i = 0; i < dustLayers.length; i++) {
        const dust = dustLayers[i];
        const driftPhase =
          backgroundTravel * dust.rate * 0.0065 +
          backgroundClock * (0.45 + i * 0.12) +
          i * 2.1;
        const slowBreath = 0.5 + 0.5 * Math.sin(backgroundClock * 0.92 + i * 2.6 + 0.7);
        dust.mesh.quaternion.copy(camera.quaternion);
        dust.mesh.rotateZ(dust.tilt);
        dust.mesh.position.x = dust.base.x + Math.sin(driftPhase) * (2.5 + i);
        dust.mesh.position.y = dust.base.y + Math.cos(driftPhase * 0.58 + i * 1.3) * (1.5 + i * 0.5);
        dust.mesh.position.z = parallaxDepth(
          dust.base.z,
          backgroundTravel,
          dust.depthRate,
          GAS_FAR_Z,
          GAS_NEAR_Z,
        );
        const depthFade = parallaxEdgeFade(
          dust.mesh.position.z,
          GAS_FAR_Z,
          GAS_NEAR_Z,
          52,
        );
        dust.mesh.material.uniforms.uTime.value = backgroundClock * (1.1 + i * 0.34);
        dust.mesh.material.uniforms.uPulse.value =
          0.24 +
          slowBreath * 0.3 +
          Math.min(1, p.energy * 2.2) * 0.2 +
          atmosphere.ion * env.beat * 0.35;
        (dust.mesh.material.uniforms.uCold.value as THREE.Color)
          .copy(DUST_COLD)
          .lerp(colSectorDeep, 0.06);
        (dust.mesh.material.uniforms.uWarm.value as THREE.Color)
          .copy(DUST_WARM)
          .lerp(colDebris, 0.03);
        dust.mesh.material.uniforms.uOpacity.value =
          dust.baseOpacity *
          (0.48 + atmosphere.dust * 0.25) *
          (0.9 + Math.min(1, p.energy * 1.8) * 0.05) *
          localSpaceVisibility *
          depthFade;
      }

      // The planet is the slow landmark that makes the whole flight vector
      // legible: it grows imperceptibly as we approach, fades, then recycles.
      {
        const depth = parallaxDepth(
          planetBase.z,
          backgroundTravel,
          VOYAGE_PARALLAX_RATES.landmarks * 0.72,
          LANDMARK_FAR_Z,
          LANDMARK_NEAR_Z,
        );
        const depthFade = parallaxEdgeFade(
          depth,
          LANDMARK_FAR_Z,
          LANDMARK_NEAR_Z,
          58,
        );
        planetGroup.position.set(
          planetBase.x + Math.sin(backgroundClock * 0.055) * 3.2,
          planetBase.y + Math.cos(backgroundClock * 0.041) * 1.7,
          depth,
        );
        planetGroup.rotation.y = backgroundClock * 0.0035;
        const material = planetGlow.material as THREE.SpriteMaterial;
        material.color.copy(NEBULA_BLUE).lerp(colSector, 0.08);
        material.opacity =
          (0.035 + atmosphere.nebula * 0.025 + Math.sin(elapsed * 0.05) * 0.01) *
          localSpaceVisibility *
          depthFade;
      }

      // Convoys occupy the mid plane: clearly faster than the planet and gas,
      // still far slower than particles skimming the lens.
      for (const fs of farShips) {
        const depth = parallaxDepth(
          fs.z,
          backgroundTravel,
          fs.rate,
          LANDMARK_FAR_Z,
          LANDMARK_NEAR_Z,
        );
        const depthFade = parallaxEdgeFade(
          depth,
          LANDMARK_FAR_Z,
          LANDMARK_NEAR_Z,
          42,
        );
        fs.sprite.position.x = fs.x + Math.sin(backgroundClock * 0.045 * fs.sp + fs.ph) * 34;
        fs.sprite.position.y = fs.y + Math.cos(backgroundClock * 0.032 * fs.sp + fs.ph) * 5;
        fs.sprite.position.z = depth;
        (fs.sprite.material as THREE.SpriteMaterial).opacity =
          (0.22 + Math.max(0, Math.sin(elapsed * 1.05 + fs.ph * 3)) * 0.26) *
          localSpaceVisibility *
          depthFade;
      }

      // Rain becomes fast debris, storms become ion shear; both remain aligned
      // with the ship's travel so the weather reads as propulsion, not confetti.
      const streakAmp =
        (0.045 + speed * 0.14 + atmosphere.debris * 0.38 + ionFlash * 0.6) *
        backgroundVisibility *
        lineVisibility *
        0.52;
      colWeather
        .copy(colSector)
        .lerp(colDebris, atmosphere.debris)
        .lerp(colStar, ionFlash);
      const streakPos = streaks.geometry.getAttribute("position") as THREE.BufferAttribute;
      const streakArr = streakPos.array as Float32Array;
      for (let i = 0; i < STREAKS; i++) {
        const s = streakSeeds[i];
        const z = parallaxDepth(
          s.z,
          backgroundTravel,
          s.sp * VOYAGE_PARALLAX_RATES.nearDust * 1.9,
          PARTICLE_FAR_Z,
          PARTICLE_NEAR_Z,
        );
        const shear =
          (i % 2 === 0 ? -1 : 1) * mood.wind * atmosphere.debris * s.len * 0.85;
        streakArr[i * 6] = s.x;
        streakArr[i * 6 + 1] = s.y;
        streakArr[i * 6 + 2] = z;
        streakArr[i * 6 + 3] = s.x + shear;
        streakArr[i * 6 + 4] =
          s.y + Math.sin(flowClock * 4.1 + i * 1.7) * atmosphere.ion * 1.8;
        streakArr[i * 6 + 5] =
          z + s.len * (1 + speed * 1.3 + atmosphere.debris * 2.8 + ionFlash * 3.5);
        const nearFade = Math.max(0, 1 - Math.abs(z) / 210);
        safeZoneProbe.set(s.x, s.y, z).project(camera);
        const startUnsafe = isUiSafeZone(safeZoneProbe);
        safeZoneProbe
          .set(streakArr[i * 6 + 3], streakArr[i * 6 + 4], streakArr[i * 6 + 5])
          .project(camera);
        const endUnsafe = isUiSafeZone(safeZoneProbe);
        safeZoneProbe
          .set(
            (streakArr[i * 6] + streakArr[i * 6 + 3]) * 0.5,
            (streakArr[i * 6 + 1] + streakArr[i * 6 + 4]) * 0.5,
            (streakArr[i * 6 + 2] + streakArr[i * 6 + 5]) * 0.5,
          )
          .project(camera);
        const midpointUnsafe = isUiSafeZone(safeZoneProbe);
        const a = startUnsafe || endUnsafe || midpointUnsafe ? 0 : streakAmp * nearFade;
        streakColors[i * 6] = colWeather.r * a;
        streakColors[i * 6 + 1] = colWeather.g * a;
        streakColors[i * 6 + 2] = colWeather.b * a;
        streakColors[i * 6 + 3] = 0;
        streakColors[i * 6 + 4] = 0;
        streakColors[i * 6 + 5] = 0;
      }
      streakPos.needsUpdate = true;
      (streaks.geometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;

      // Snow becomes slow ice crystals; debris and wind stretch their drift.
      {
        const pos = motes.geometry.getAttribute("position") as THREE.BufferAttribute;
        const arr = pos.array as Float32Array;
        const weatherFlow = 1 + atmosphere.debris * 1.4 - atmosphere.ice * 0.32;
        for (let i = 0; i < MOTES; i++) {
          const s = moteSeeds[i];
          const z = parallaxDepth(
            s.z,
            backgroundTravel,
            s.sp * VOYAGE_PARALLAX_RATES.nearDust * 2.1 * weatherFlow,
            PARTICLE_FAR_Z,
            PARTICLE_NEAR_Z,
          );
          const phase = flowClock * (0.55 + s.sp * 0.15) + i * 0.91;
          const x =
            s.x +
            Math.sin(phase) * atmosphere.ice * 7 +
            Math.cos(phase * 0.7) * mood.wind * atmosphere.debris * 5;
          const y =
            s.y +
            Math.cos(phase * 0.82) * atmosphere.ice * 4 +
            Math.sin(phase * 2.3) * atmosphere.ion * 2;
          safeZoneProbe.set(x, y, z).project(camera);
          arr[i * 3] = isUiSafeZone(safeZoneProbe) ? 1000 : x;
          arr[i * 3 + 1] = y;
          arr[i * 3 + 2] = z;
        }
        pos.needsUpdate = true;
        const material = motes.material as THREE.PointsMaterial;
        const iceMix =
          atmosphere.ice /
          Math.max(0.001, atmosphere.ice + atmosphere.debris + atmosphere.ion);
        material.color.copy(colWeather).lerp(colIce, iceMix);
        material.size = 0.45 + atmosphere.ice * 0.72 + atmosphere.debris * 0.12;
        material.opacity =
          Math.min(
            1,
            0.04 +
              speed * 0.065 +
              atmosphere.debris * 0.34 +
              atmosphere.ice * 0.46 +
              ionFlash * 0.2,
          ) *
          backgroundVisibility *
          compositionVisibility;
      }
    }

    // ---- transcend particles: hull de-rez at climax ------------------------
    {
      const pm = tParticles.material as THREE.PointsMaterial;
      pm.opacity = wTranscend * 0.85;
      if (wTranscend > 0.01) {
        const spread = wTranscend * wTranscend;
        for (let i = 0; i < TPARTS; i++) {
          const wob = Math.sin(flowClock * 2 + i * 0.7);
          tPositions[i * 3] = tHome[i * 3] + tDir[i * 3] * spread * (0.6 + wob * 0.15);
          tPositions[i * 3 + 1] = tHome[i * 3 + 1] + tDir[i * 3 + 1] * spread * (0.6 + wob * 0.15);
          tPositions[i * 3 + 2] = tHome[i * 3 + 2] + tDir[i * 3 + 2] * spread * 0.6;
        }
        (tParticles.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      }
    }

    // ---- camera: composition stays legible, emotion changes how it breathes --
    {
      camSway += dt * (0.04 + mood.arousal * 0.07 + mood.wind * 0.035) * motion;
      const tremor = atmosphere.cameraTremor * motion;
      const swayX = 1 + mood.arousal * 1.25 + mood.wind * 0.65;
      const swayY = 0.65 + mood.arousal * 0.7 + mood.wind * 0.45;
      vec.set(
        camPos.x +
          Math.sin(camSway * 0.7) * swayX +
          Math.sin(elapsed * 13.7) * tremor * 1.8,
        camPos.y +
          Math.sin(camSway * 0.53 + 1.2) * swayY +
          mood.swell * 0.75 * motion +
          Math.sin(elapsed * 17.3 + 1.1) * tremor * 1.1,
        camPos.z +
          Math.cos(camSway * 0.61) * (0.8 + mood.arousal * 0.65) -
          p.bass * (1.8 + mood.arousal * 2.2) * motion -
          ionFlash * 0.8,
      );
      camera.position.lerp(vec, 1 - Math.exp(-dt * (2.2 + mood.arousal * 1.6)));
      vecB.set(
        camLook.x +
          Math.sin(camSway * 0.43) * (1.1 + mood.wind * 0.9) +
          Math.sin(elapsed * 15.1 + 2.3) * tremor * 2.2,
        camLook.y +
          Math.sin(camSway * 0.37 + 2) * 0.7 +
          (mood.valence - 0.5) * 3 +
          env.treble * 1.8 * motion,
        camLook.z,
      );
      camera.lookAt(vecB);
      camera.rotation.z +=
        ship.rotation.z * 0.5 + Math.sin(elapsed * 12.1) * tremor * 0.006;
      const targetFov =
        46 +
        mood.arousal * 2.5 +
        mood.buildUp * 3.6 +
        Math.max(0, mood.swell) * 1.4 +
        ionFlash * 3 +
        p.impact * 1.2;
      if (Math.abs(camera.fov - targetFov) > 0.02) {
        camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4.5);
        camera.updateProjectionMatrix();
      }
    }

    const cameraMask = camera.layers.mask;
    camera.layers.set(BLOOM_LAYER);
    bloomComposer.render();
    camera.layers.mask = cameraMask;
    finalComposer.render();
    moodHud.render(
      renderer,
      mood,
      frame.positionFraction,
      themeHue,
      dt,
      (frame.options.moodHud ?? 1) >= 0.5 && !backgroundOnly,
    );
  }

  return {
    render,
    resize: (width, height, dpr) => {
      shell.resize(width, height, dpr);
      bloomComposer.setPixelRatio(Math.min(dpr, 2));
      bloomComposer.setSize(width, height);
      finalComposer.setPixelRatio(Math.min(dpr, 2));
      finalComposer.setSize(width, height);
      moodHud.resize(width, height);
    },
    dispose: () => {
      bloomComposer.dispose();
      finalComposer.dispose();
      moodHud.dispose();
      shell.dispose();
      glow.dispose();
      hullCatMark.dispose();
      hullIdMark.dispose();
    },
  };
}
