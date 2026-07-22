/**
 * UV-free armor material laboratory.
 *
 * One close plate, one camera, no bloom, no outline. The seven output modes
 * expose the exact channels consumed by the final Cook-Torrance composite.
 * Every surface feature is evaluated in object space with triplanar noise,
 * so the experiment remains usable on the Voyage hull even without UVs.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

interface ViewMode {
  id: string;
  name: string;
  kind: string;
  note: string;
  legend: string;
}

const MODES: ViewMode[] = [
  {
    id: "base-color",
    name: "Base Color",
    kind: "ALBEDO",
    note: "旧深蓝灰涂层、裸露钢边、暗褐锈、锈水、油污和烧蚀色均在无灯光通道中可见。",
    legend: "颜色中不含直射光；结构性风化必须单独成立。",
  },
  {
    id: "roughness",
    name: "Roughness",
    kind: "SCALAR",
    note: "白色更粗糙：锈和积灰最粗，旧漆次之；油污与裸钢边保留较暗的光滑区域。",
    legend: "黑 = 光滑 · 白 = 粗糙",
  },
  {
    id: "metalness",
    name: "Metalness",
    kind: "SCALAR",
    note: "只有掉漆后裸露的钢边和缺口接近金属；涂层、锈层、油污与积灰都不是金属。",
    legend: "黑 = 非金属覆盖物 · 白 = 裸露金属",
  },
  {
    id: "normal",
    name: "Normal",
    kind: "VECTOR",
    note: "接缝下陷、边缘破损、锈层隆起与双频微凹凸共同扰动法线，不依赖几何轮廓线。",
    legend: "世界空间法线 RGB 可视化",
  },
  {
    id: "ao",
    name: "AO",
    kind: "SCALAR",
    note: "凹槽、接缝和内缘遮蔽最深，并叠加低处积灰；大平面保持开放，不做全局脏化。",
    legend: "黑 = 遮蔽/积灰槽 · 白 = 开放表面",
  },
  {
    id: "weathering",
    name: "Weathering Mask",
    kind: "RGB MASK",
    note: "锈蚀与锈水依附结构源，掉漆集中在边缘和接缝唇，油污/烧蚀占独立通道。",
    legend:
      '<span class="swatch rust"></span>红 锈蚀/流痕 <span class="swatch metal"></span>绿 掉漆/裸钢 <span class="swatch oil"></span>蓝 油污/烧蚀',
  },
  {
    id: "final",
    name: "Final PBR",
    kind: "COMPOSITE",
    note: "固定中性灯位下的 Cook-Torrance GGX 合成；曝光固定，无 Bloom、无轮廓线、无环境贴图。",
    legend: "三盏克制灯光，仅用于验证材质响应，不掩盖通道缺陷。",
  },
];

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vObjectPosition;
  varying vec3 vObjectNormal;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec3 vWorldTangent;
  varying vec3 vWorldBitangent;

  void main() {
    vec3 objectNormal = normalize(normal);
    vec3 helper = abs(objectNormal.z) < 0.92 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 objectTangent = normalize(cross(helper, objectNormal));
    vec3 objectBitangent = normalize(cross(objectNormal, objectTangent));
    vec4 world = modelMatrix * vec4(position, 1.0);
    vObjectPosition = position;
    vObjectNormal = objectNormal;
    vWorldPosition = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vWorldTangent = normalize(mat3(modelMatrix) * objectTangent);
    vWorldBitangent = normalize(mat3(modelMatrix) * objectBitangent);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform int uMode;
  varying vec3 vObjectPosition;
  varying vec3 vObjectNormal;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec3 vWorldTangent;
  varying vec3 vWorldBitangent;

  const float PI = 3.141592653589793;
  const vec2 PLATE_HALF = vec2(3.65, 2.2);

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
  }

  float fbm2(vec2 p) {
    float sum = 0.0;
    float amp = 0.52;
    for (int i = 0; i < 5; i++) {
      sum += noise2(p) * amp;
      p = mat2(1.71, -1.13, 1.13, 1.71) * p + vec2(7.1, 3.7);
      amp *= 0.48;
    }
    return sum;
  }

  float triplanarNoise(vec3 p, vec3 n, float scale) {
    vec3 w = pow(abs(n), vec3(4.0));
    w /= max(0.0001, w.x + w.y + w.z);
    return fbm2(p.yz * scale) * w.x + fbm2(p.xz * scale) * w.y + fbm2(p.xy * scale) * w.z;
  }

  float roundedBoxSdf(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  float seamDistance(vec2 p) {
    float d = 10.0;
    d = min(d, abs(p.x + 1.72));
    d = min(d, abs(p.x - 1.48));
    d = min(d, abs(p.y + 0.94));
    d = min(d, abs(p.y - (0.14 * p.x + 0.82)));
    d = min(d, abs(roundedBoxSdf(p - vec2(0.05, -0.08), vec2(0.72, 0.43), 0.11)));
    return d;
  }

  float verticalStreak(vec2 p, vec2 origin, float width, float length, float seed) {
    float travel = origin.y - p.y;
    float streakLife = smoothstep(0.0, 0.08, travel) * (1.0 - smoothstep(length * 0.72, length, travel));
    float wobble = (fbm2(vec2(p.y * 3.1 + seed, seed * 7.3)) - 0.5) * width * 1.5;
    float line = 1.0 - smoothstep(width, width * 2.3, abs(p.x - origin.x - wobble));
    float breakup = 0.28 + 0.72 * smoothstep(0.34, 0.76, fbm2(vec2(p.x * 14.0 + seed, p.y * 5.5)));
    return line * streakLife * breakup;
  }

  void surfaceMasks(
    vec3 objectPosition,
    vec3 objectNormal,
    out float seam,
    out float seamLip,
    out float bareMetal,
    out float rust,
    out float rustStreak,
    out float oil,
    out float scorch,
    out float dust,
    out float grain
  ) {
    vec2 p = objectPosition.xy;
    float front = smoothstep(0.56, 0.94, abs(objectNormal.z));
    float seamD = seamDistance(p);
    seam = (1.0 - smoothstep(0.018, 0.056, seamD)) * front;
    seamLip = (1.0 - smoothstep(0.06, 0.14, seamD)) * (1.0 - seam) * front;

    float edgeDistance = min(PLATE_HALF.x - abs(p.x), PLATE_HALF.y - abs(p.y));
    float geometricEdge = 1.0 - smoothstep(0.03, 0.3, max(edgeDistance, 0.0));
    geometricEdge = max(geometricEdge, 1.0 - front);
    float chipField = triplanarNoise(objectPosition + vec3(2.7, 1.1, 0.4), objectNormal, 5.4);
    float fineChip = triplanarNoise(objectPosition + vec3(9.2, 4.3, 1.6), objectNormal, 14.0);
    float broken = smoothstep(0.48, 0.76, chipField * 0.72 + fineChip * 0.34);
    float seamChip = seamLip * smoothstep(0.42, 0.69, fineChip);
    bareMetal = clamp(geometricEdge * (0.36 + broken * 0.82) + seamChip * 0.92, 0.0, 1.0);

    float rustTexture = triplanarNoise(objectPosition + vec3(4.2, 8.7, 2.1), objectNormal, 3.8);
    float rustFine = triplanarNoise(objectPosition + vec3(1.3, 5.5, 7.2), objectNormal, 10.5);
    float structureSource = max(seam * 0.92, seamLip * 0.58);
    structureSource = max(structureSource, geometricEdge * 0.5);
    rust = structureSource * smoothstep(0.34, 0.72, rustTexture * 0.75 + rustFine * 0.35);

    rustStreak = 0.0;
    rustStreak += verticalStreak(p, vec2(-1.72, 0.88), 0.045, 1.45, 1.7);
    rustStreak += verticalStreak(p, vec2(1.48, 1.02), 0.055, 1.85, 4.3);
    rustStreak += verticalStreak(p, vec2(0.78, 0.92), 0.035, 1.28, 8.2);
    rustStreak += verticalStreak(p, vec2(3.42, 1.68), 0.07, 2.35, 12.4);
    rustStreak *= front * (0.58 + rustTexture * 0.42);
    rust = clamp(rust + rustStreak * 0.76, 0.0, 1.0);

    vec2 oilP = (p - vec2(-0.42, -0.54)) / vec2(1.36, 0.68);
    float oilPool = exp(-dot(oilP, oilP) * 1.5);
    float oilBreakup = smoothstep(0.33, 0.72, fbm2(p * vec2(1.7, 3.8) + vec2(2.4, 7.1)));
    float oilDrip = verticalStreak(p, vec2(-0.62, 0.15), 0.15, 1.62, 20.1);
    oil = clamp(oilPool * oilBreakup * 0.86 + oilDrip * 0.46, 0.0, 1.0) * front;

    vec2 heatP = (p - vec2(3.08, -0.22)) / vec2(2.25, 0.86);
    float heatShape = exp(-dot(heatP, heatP) * 1.32);
    float heatBreakup = 0.55 + 0.45 * fbm2(vec2(p.x * 1.8 - p.y * 0.6, p.y * 4.1 + 2.0));
    scorch = smoothstep(0.12, 0.84, heatShape * heatBreakup) * front;

    grain = triplanarNoise(objectPosition, objectNormal, 7.5);
    dust = seam * (0.52 + 0.48 * grain);
    dust += seamLip * smoothstep(0.52, 0.78, grain) * 0.3;
    dust += smoothstep(-2.1, -1.35, -p.y) * smoothstep(0.5, 0.78, grain) * 0.16 * front;
    dust = clamp(dust, 0.0, 1.0);
  }

  float surfaceHeight(vec3 p, vec3 n) {
    float seamD = seamDistance(p.xy);
    float seam = (1.0 - smoothstep(0.018, 0.06, seamD)) * smoothstep(0.56, 0.94, abs(n.z));
    float coarse = triplanarNoise(p + vec3(1.2, 3.4, 5.6), n, 8.0) - 0.5;
    float fine = triplanarNoise(p + vec3(8.1, 2.2, 4.7), n, 23.0) - 0.5;
    float corrosion = smoothstep(0.57, 0.78, triplanarNoise(p + 4.0, n, 5.5));
    return coarse * 0.009 + fine * 0.0035 + corrosion * 0.014 - seam * 0.072;
  }

  vec3 mappedNormal(vec3 p, vec3 objectNormal) {
    vec3 helper = abs(objectNormal.z) < 0.92 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 objectTangent = normalize(cross(helper, objectNormal));
    vec3 objectBitangent = normalize(cross(objectNormal, objectTangent));
    float epsilon = 0.018;
    float center = surfaceHeight(p, objectNormal);
    float alongTangent = surfaceHeight(p + objectTangent * epsilon, objectNormal);
    float alongBitangent = surfaceHeight(p + objectBitangent * epsilon, objectNormal);
    float dhT = (alongTangent - center) / epsilon;
    float dhB = (alongBitangent - center) / epsilon;
    return normalize(vWorldNormal - vWorldTangent * dhT * 0.52 - vWorldBitangent * dhB * 0.52);
  }

  float distributionGGX(vec3 n, vec3 h, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float nDotH = max(dot(n, h), 0.0);
    float nDotH2 = nDotH * nDotH;
    float denominator = nDotH2 * (a2 - 1.0) + 1.0;
    return a2 / max(PI * denominator * denominator, 0.0001);
  }

  float geometrySchlickGGX(float nDotV, float roughness) {
    float r = roughness + 1.0;
    float k = (r * r) / 8.0;
    return nDotV / max(nDotV * (1.0 - k) + k, 0.0001);
  }

  float geometrySmith(vec3 n, vec3 v, vec3 l, float roughness) {
    return geometrySchlickGGX(max(dot(n, v), 0.0), roughness) *
           geometrySchlickGGX(max(dot(n, l), 0.0), roughness);
  }

  vec3 fresnelSchlick(float cosTheta, vec3 f0) {
    return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  }

  vec3 pbrLight(
    vec3 n,
    vec3 v,
    vec3 l,
    vec3 radiance,
    vec3 baseColor,
    float roughness,
    float metalness,
    vec3 f0
  ) {
    vec3 h = normalize(v + l);
    float ndf = distributionGGX(n, h, roughness);
    float geometry = geometrySmith(n, v, l, roughness);
    vec3 fresnel = fresnelSchlick(max(dot(h, v), 0.0), f0);
    vec3 numerator = ndf * geometry * fresnel;
    float denominator = 4.0 * max(dot(n, v), 0.0) * max(dot(n, l), 0.0) + 0.0001;
    vec3 specular = numerator / denominator;
    vec3 kd = (1.0 - fresnel) * (1.0 - metalness);
    float nDotL = max(dot(n, l), 0.0);
    return (kd * baseColor / PI + specular) * radiance * nDotL;
  }

  void main() {
    float seam;
    float seamLip;
    float bareMetal;
    float rust;
    float rustStreak;
    float oil;
    float scorch;
    float dust;
    float grain;
    surfaceMasks(vObjectPosition, normalize(vObjectNormal), seam, seamLip, bareMetal, rust, rustStreak, oil, scorch, dust, grain);

    vec3 oldPaint = mix(vec3(0.035, 0.055, 0.078), vec3(0.08, 0.125, 0.165), grain);
    float fadedZone = smoothstep(0.42, 0.74, fbm2(vObjectPosition.xy * 0.62 + vec2(4.2, 1.8)));
    oldPaint *= 0.78 + fadedZone * 0.28;
    vec3 exposedSteel = mix(vec3(0.17, 0.2, 0.215), vec3(0.34, 0.38, 0.4), grain);
    vec3 darkRust = mix(vec3(0.115, 0.047, 0.026), vec3(0.31, 0.105, 0.04), smoothstep(0.34, 0.78, grain));
    vec3 baseColor = mix(oldPaint, exposedSteel, bareMetal);
    baseColor = mix(baseColor, darkRust, rust * 0.92);
    baseColor = mix(baseColor, vec3(0.055, 0.041, 0.032), rustStreak * 0.42);
    baseColor = mix(baseColor, vec3(0.018, 0.024, 0.027), oil * 0.84);
    vec3 heatTint = mix(vec3(0.095, 0.045, 0.031), vec3(0.018, 0.021, 0.023), scorch);
    baseColor = mix(baseColor, heatTint, scorch * 0.92);
    baseColor = mix(baseColor, vec3(0.19, 0.17, 0.135), dust * 0.24);
    baseColor *= 1.0 - seam * 0.52;

    float roughness = mix(0.68, 0.82, grain);
    roughness = mix(roughness, 0.29 + grain * 0.12, bareMetal);
    roughness = mix(roughness, 0.94, rust);
    roughness = mix(roughness, 0.24, oil * 0.78);
    roughness = mix(roughness, 0.88, scorch);
    roughness = mix(roughness, 0.98, dust);
    roughness = clamp(roughness, 0.08, 0.98);

    float metalness = mix(0.035, 0.93, bareMetal);
    metalness *= 1.0 - rust * 0.96;
    metalness *= 1.0 - oil * 0.72;
    metalness *= 1.0 - dust * 0.86;
    metalness = clamp(metalness, 0.0, 1.0);

    float ao = 1.0 - seam * 0.68 - seamLip * 0.13 - dust * 0.25;
    ao *= 1.0 - rust * seam * 0.16;
    ao = clamp(ao, 0.12, 1.0);
    vec3 n = mappedNormal(vObjectPosition, normalize(vObjectNormal));
    vec3 weathering = vec3(clamp(max(rust, rustStreak), 0.0, 1.0), bareMetal, clamp(max(oil, scorch), 0.0, 1.0));

    vec3 color;
    if (uMode == 0) {
      color = baseColor;
    } else if (uMode == 1) {
      color = vec3(roughness);
    } else if (uMode == 2) {
      color = vec3(metalness);
    } else if (uMode == 3) {
      color = n * 0.5 + 0.5;
    } else if (uMode == 4) {
      color = vec3(ao);
    } else if (uMode == 5) {
      color = weathering;
    } else {
      vec3 v = normalize(cameraPosition - vWorldPosition);
      vec3 f0 = mix(vec3(0.04), baseColor, metalness);
      vec3 key = pbrLight(n, v, normalize(vec3(-0.48, 0.72, 0.82)), vec3(1.4, 1.55, 1.68), baseColor, roughness, metalness, f0);
      vec3 fill = pbrLight(n, v, normalize(vec3(0.78, -0.18, 0.58)), vec3(0.28, 0.4, 0.48), baseColor, roughness, metalness, f0);
      vec3 warm = pbrLight(n, v, normalize(vec3(-0.66, -0.52, 0.42)), vec3(0.26, 0.12, 0.055), baseColor, roughness, metalness, f0);
      vec3 ambient = baseColor * (0.055 + 0.075 * ao) * (1.0 - metalness * 0.56);
      vec3 grazing = fresnelSchlick(max(dot(n, v), 0.0), f0) * vec3(0.035, 0.05, 0.06) * ao;
      color = (key + fill + warm + ambient + grazing) * ao;
    }

    gl_FragColor = vec4(color, 1.0);
    if (uMode == 0) {
      #include <colorspace_fragment>
    } else if (uMode == 6) {
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  }
`;

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x05070a, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(31, 16 / 9, 0.1, 100);
camera.position.set(0.15, 0.08, 10.0);
camera.lookAt(0, 0, 0);

const uniforms = { uMode: { value: 6 } };
const material = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: VERTEX_SHADER,
  fragmentShader: FRAGMENT_SHADER,
  toneMapped: true,
});
const plate = new THREE.Mesh(new RoundedBoxGeometry(7.3, 4.4, 0.42, 8, 0.16), material);
plate.rotation.set(-0.035, -0.105, -0.012);
plate.position.y = -0.12;
scene.add(plate);

const query = new URLSearchParams(location.search);
const initialId = query.get("view") ?? "final";
const requestedIndex = MODES.findIndex((mode) => mode.id === initialId);
let activeIndex = requestedIndex >= 0 ? requestedIndex : MODES.length - 1;

const nav = document.getElementById("modes") as HTMLElement;
const modeName = document.getElementById("mode-name") as HTMLElement;
const modeNote = document.getElementById("mode-note") as HTMLElement;
const legend = document.getElementById("legend") as HTMLElement;
const buttons = MODES.map((mode, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = `<span class="key">${index + 1}</span><span>${mode.name}</span><span class="kind">${mode.kind}</span>`;
  button.addEventListener("click", () => setMode(index));
  nav.appendChild(button);
  return button;
});

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  render();
}

function render(): void {
  renderer.render(scene, camera);
}

function setMode(index: number): void {
  activeIndex = Math.max(0, Math.min(MODES.length - 1, index));
  uniforms.uMode.value = activeIndex;
  const mode = MODES[activeIndex];
  buttons.forEach((button, i) => button.classList.toggle("active", i === activeIndex));
  modeName.textContent = `${activeIndex + 1} / 7 · ${mode.name.toUpperCase()}`;
  modeNote.textContent = mode.note;
  legend.innerHTML = `<strong>${mode.name}</strong><br>${mode.legend}`;
  document.documentElement.dataset.view = mode.id;
  window.__ARMOR_LAB_MODE__ = mode.id;
  render();
}

window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  const index = Number(event.key) - 1;
  if (index >= 0 && index < MODES.length) setMode(index);
});

resize();
setMode(activeIndex);

declare global {
  interface Window {
    __ARMOR_LAB_READY__?: boolean;
    __ARMOR_LAB_MODE__?: string;
  }
}
window.__ARMOR_LAB_READY__ = true;
window.__ARMOR_LAB_MODE__ = MODES[activeIndex].id;
