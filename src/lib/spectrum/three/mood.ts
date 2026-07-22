import * as THREE from "three";
import { AudioPulse, BandSmoother } from "../dynamics";
import {
  MOOD_WORLDS,
  neutralMoodState,
  seededRandom,
  type MoodState,
  type MoodWorld,
  type WeatherMode,
} from "../mood";
import { bandLevels, bassLevel, createShell, energyLevel, glowTexture } from "./common";
import type { ThreeFrame, ThreeInstance } from "./types";

/**
 * 情绪 (Mood) — an abstract random digital world that resonates with the
 * music. The shared MoodEngine (run by the view, delivered as `frame.mood`)
 * folds the spectrum into slow world weights
 * (宇宙 cosmos / 星空 starlight / 大海 ocean / 草原 meadow / 城市 city) and every
 * element cross-fades along those weights: nebulae and meteors own the void,
 * a wire ground rolls as sea or breathes as grassland, an instanced skyline
 * pulses like an equalizer, and the camera drifts between first-person
 * anchors so each world is *felt* rather than depicted. A weather layer
 * (晴/雾/雨/雪/雷) reads the same emotion axes as atmosphere: rain streaks and
 * snow drift through the air, mist draws the fog wall in, storms strike
 * lightning, and overcast dims the whole sky — wind shears everything.
 */

const SEED = 0x20260720;
const GROUND_W = 240;
const GROUND_D = 170;
const COLS = 84;
const ROWS = 60;
const TOWERS = 120;
const MOTES = 220;
const METEORS = 5;
const BANDS = 16;
const RIPPLES = 4;
const RIPPLE_LIFE = 2.2;
const RAIN_DROPS = 480;
const SNOW_FLAKES = 320;

/** Per-world palette as offsets from the theme hue: [hueShift, sat, light]. */
const PALETTE: Record<MoodWorld, readonly [number, number, number]> = {
  cosmos: [90, 0.65, 0.5],
  starlight: [4, 0.45, 0.62],
  ocean: [20, 0.85, 0.52],
  meadow: [-60, 0.7, 0.55],
  city: [45, 0.9, 0.56],
};

/** First-person camera anchors per world: position and look target. */
const CAMERA: Record<MoodWorld, { pos: readonly [number, number, number]; look: readonly [number, number, number] }> = {
  cosmos: { pos: [0, 15, 26], look: [0, 30, -90] },
  starlight: { pos: [0, 9, 23], look: [0, 16, -90] },
  ocean: { pos: [0, 6.5, 21], look: [0, 4, -90] },
  meadow: { pos: [0, 4.5, 19], look: [0, 5.5, -90] },
  city: { pos: [0, 7.5, 27], look: [0, 10, -75] },
};

/** HUD glyph per weather mode — the atmosphere the engine is hearing. */
const WEATHER_GLYPH: Record<WeatherMode, string> = {
  clear: "晴",
  mist: "雾",
  rain: "雨",
  snow: "雪",
  storm: "雷",
};

function setWorldColors(colors: Record<MoodWorld, THREE.Color>, hue: number, lightBoost = 0) {
  for (const world of MOOD_WORLDS) {
    const [shift, sat, light] = PALETTE[world];
    colors[world].setHSL(
      (((hue + shift) % 360) + 360) % 360 / 360,
      sat,
      Math.min(0.9, light + lightBoost),
    );
  }
}

function blendByWeights(
  target: THREE.Color,
  colors: Record<MoodWorld, THREE.Color>,
  weights: Record<MoodWorld, number>,
): THREE.Color {
  target.setRGB(0, 0, 0);
  for (const world of MOOD_WORLDS) {
    const w = weights[world];
    target.r += colors[world].r * w;
    target.g += colors[world].g * w;
    target.b += colors[world].b * w;
  }
  return target;
}

interface StarLayer {
  points: THREE.Points;
  material: THREE.PointsMaterial;
  phase: number;
  speed: number;
  baseSize: number;
}

/**
 * Sharp point-light texture for stars: a hot core with a fast falloff, so
 * scaled-up points read as light, not as soft balloons.
 */
function starTexture(size = 64): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.12, "rgba(255,255,255,.85)");
  gradient.addColorStop(0.3, "rgba(255,255,255,.18)");
  gradient.addColorStop(0.6, "rgba(255,255,255,.03)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Equirect lunar surface maps (albedo + relief), drawn wrap-around so the
 * seam is invisible while the sphere slowly rotates. The relief canvas feeds
 * a bump map: craters get lit rims and shadowed floors from the moon's own
 * directional light, which reads far more detailed than flat speckle.
 */
function moonSurfaceMaps(
  rng: () => number,
  width = 1024,
  height = 512,
): { map: THREE.Texture; bump: THREE.Texture } {
  const albedoCanvas = document.createElement("canvas");
  albedoCanvas.width = width;
  albedoCanvas.height = height;
  const albedo = albedoCanvas.getContext("2d")!;
  const reliefCanvas = document.createElement("canvas");
  reliefCanvas.width = width;
  reliefCanvas.height = height;
  const relief = reliefCanvas.getContext("2d")!;

  albedo.fillStyle = "#eceaf0";
  albedo.fillRect(0, 0, width, height);
  relief.fillStyle = "#808080";
  relief.fillRect(0, 0, width, height);

  /** Elliptical radial-gradient splat, drawn at both wrapped copies of x. */
  const splat = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    rx: number,
    ry: number,
    stops: Array<[number, string]>,
  ) => {
    for (const ox of [-width, 0, width]) {
      ctx.save();
      ctx.translate(x + ox, y);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (const [p, c] of stops) g.addColorStop(p, c);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };

  // Broad tonal mottling: overlapping bright/dark patches of old highlands.
  for (let i = 0; i < 30; i++) {
    const x = rng() * width;
    const y = rng() * height;
    const r = 50 + rng() * 130;
    const dark = rng() < 0.5;
    const a = 0.03 + rng() * 0.05;
    const tone = dark ? `rgba(70,72,88,${a})` : `rgba(255,255,255,${a})`;
    splat(albedo, x, y, r, r * (0.6 + rng() * 0.5), [
      [0, tone],
      [1, dark ? "rgba(70,72,88,0)" : "rgba(255,255,255,0)"],
    ]);
  }

  // Maria: clusters of overlapping basalt blots for irregular coastlines.
  for (let i = 0; i < 7; i++) {
    const cx = rng() * width;
    const cy = height * (0.24 + rng() * 0.5);
    const blots = 4 + Math.floor(rng() * 5);
    for (let j = 0; j < blots; j++) {
      const x = cx + (rng() - 0.5) * 130;
      const y = cy + (rng() - 0.5) * 60;
      const r = 26 + rng() * 62;
      const a = 0.07 + rng() * 0.07;
      splat(albedo, x, y, r, r * (0.55 + rng() * 0.45), [
        [0, `rgba(55,57,72,${a})`],
        [0.75, `rgba(55,57,72,${a * 0.8})`],
        [1, "rgba(55,57,72,0)"],
      ]);
      splat(relief, x, y, r, r * (0.55 + rng() * 0.45), [
        [0, "rgba(96,96,96,0.35)"],
        [1, "rgba(96,96,96,0)"],
      ]);
    }
  }

  // Craters, power-law sized: a handful of giants, a swarm of small pits.
  const craters: Array<{ x: number; y: number; r: number }> = [];
  for (let i = 0; i < 150; i++) {
    craters.push({
      x: rng() * width,
      y: height * (0.05 + rng() * 0.9),
      r: 1.6 + Math.pow(rng(), 2.6) * 38,
    });
  }
  for (const { x, y, r } of craters) {
    const squash = 0.72 + rng() * 0.28;
    // Relief: raised rim annulus, sunken bowl, tiny central peak on big ones.
    splat(relief, x, y, r * 1.18, r * 1.18 * squash, [
      [0, "rgba(255,255,255,0)"],
      [0.72, "rgba(255,255,255,0.5)"],
      [0.9, "rgba(255,255,255,0.28)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    splat(relief, x, y, r * 0.86, r * 0.86 * squash, [
      [0, "rgba(0,0,0,0.52)"],
      [0.8, "rgba(0,0,0,0.4)"],
      [1, "rgba(0,0,0,0)"],
    ]);
    if (r > 14) {
      splat(relief, x, y, r * 0.18, r * 0.18 * squash, [
        [0, "rgba(255,255,255,0.5)"],
        [1, "rgba(255,255,255,0)"],
      ]);
    }
    // Albedo: subtle dark floor and a faint bright rim.
    splat(albedo, x, y, r * 0.85, r * 0.85 * squash, [
      [0, `rgba(60,62,76,${0.1 + rng() * 0.08})`],
      [1, "rgba(60,62,76,0)"],
    ]);
    splat(albedo, x, y, r * 1.16, r * 1.16 * squash, [
      [0, "rgba(255,255,255,0)"],
      [0.74, `rgba(255,255,255,${0.1 + rng() * 0.08})`],
      [1, "rgba(255,255,255,0)"],
    ]);
  }

  // Ray systems: a few young craters throw bright ejecta streaks.
  const young = craters.filter((c) => c.r > 9).slice(0, 3);
  for (const { x, y, r } of young) {
    const rays = 9 + Math.floor(rng() * 6);
    for (let i = 0; i < rays; i++) {
      const angle = rng() * Math.PI * 2;
      const len = r * (2.2 + rng() * 4.5);
      const w = 1 + rng() * 2.6;
      for (const ox of [-width, 0, width]) {
        const g = albedo.createLinearGradient(
          x + ox + Math.cos(angle) * r,
          y + Math.sin(angle) * r * 0.8,
          x + ox + Math.cos(angle) * (r + len),
          y + Math.sin(angle) * (r + len) * 0.8,
        );
        g.addColorStop(0, `rgba(255,255,255,${0.1 + rng() * 0.08})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
        albedo.strokeStyle = g;
        albedo.lineWidth = w;
        albedo.beginPath();
        albedo.moveTo(x + ox + Math.cos(angle) * r, y + Math.sin(angle) * r * 0.8);
        albedo.lineTo(x + ox + Math.cos(angle) * (r + len), y + Math.sin(angle) * (r + len) * 0.8);
        albedo.stroke();
      }
    }
  }

  // Fine regolith grain: dense micro-speckle on both maps.
  for (let i = 0; i < 1100; i++) {
    const x = rng() * width;
    const y = rng() * height;
    const r = 0.5 + rng() * 1.8;
    const dark = rng() < 0.55;
    const a = 0.05 + rng() * 0.08;
    albedo.fillStyle = dark ? `rgba(62,64,80,${a})` : `rgba(255,255,255,${a})`;
    for (const ox of [-width, 0, width]) {
      albedo.beginPath();
      albedo.arc(x + ox, y, r, 0, Math.PI * 2);
      albedo.fill();
    }
    if (i % 3 === 0) {
      relief.fillStyle = dark ? `rgba(0,0,0,${a * 0.9})` : `rgba(255,255,255,${a * 0.9})`;
      for (const ox of [-width, 0, width]) {
        relief.beginPath();
        relief.arc(x + ox, y, r, 0, Math.PI * 2);
        relief.fill();
      }
    }
  }

  const map = new THREE.CanvasTexture(albedoCanvas);
  map.wrapS = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bump = new THREE.CanvasTexture(reliefCanvas);
  bump.wrapS = THREE.RepeatWrapping;
  bump.anisotropy = 4;
  return { map, bump };
}

/**
 * Wispy horizontal cloud streak: layered soft ellipses in the alpha channel,
 * tinted per-sprite. Used for the veils drifting across the moon.
 */
function wispTexture(rng: () => number, width = 256, height = 128): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  for (let i = 0; i < 16; i++) {
    const x = width * (0.14 + rng() * 0.72);
    const y = height * (0.3 + rng() * 0.4);
    const rx = width * (0.1 + rng() * 0.2);
    const ry = rx * (0.16 + rng() * 0.16);
    const a = 0.05 + rng() * 0.09;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.6, `rgba(255,255,255,${a * 0.55})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function makeStars(rng: () => number, count: number, size: number, texture: THREE.Texture, phase: number, speed: number): StarLayer {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Upper hemisphere shell so stars live above the horizon.
    const azimuth = rng() * Math.PI * 2;
    const elevation = Math.asin(rng() * 0.94 + 0.04);
    const radius = 150 + rng() * 40;
    positions[i * 3] = Math.cos(azimuth) * Math.cos(elevation) * radius;
    positions[i * 3 + 1] = Math.sin(elevation) * radius;
    positions[i * 3 + 2] = Math.sin(azimuth) * Math.cos(elevation) * radius;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    size,
    map: texture,
    fog: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: false,
  });
  return { points: new THREE.Points(geometry, material), material, phase, speed, baseSize: size };
}

/**
 * Thin vertical streak for rain drops: a bright core line fading at both
 * ends, so attenuated points read as falling strokes rather than dots.
 */
function rainTexture(width = 16, height = 64): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.25, "rgba(255,255,255,.55)");
  gradient.addColorStop(0.75, "rgba(255,255,255,.9)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(width / 2 - 1.5, 0, 3, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

interface Meteor {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  velocity: THREE.Vector3;
  life: number;
}

/** Expanding damped ground wave spawned by a bass impact. */
interface Ripple {
  x: number;
  z: number;
  age: number;
  strength: number;
}

export function create(canvas: HTMLCanvasElement): ThreeInstance {
  const rng = seededRandom(SEED);
  const shell = createShell(canvas, 58);
  const fog = new THREE.Fog(0x000000, 40, 190);
  shell.scene.fog = fog;

  const texture = glowTexture();
  const pointTexture = starTexture();

  // --- Sky: two twinkling star layers + nebula sprites ---------------------
  // Celestial bodies ride in a camera-locked group: translating the camera
  // (bass push, phrase swell, world-anchor drift) produces zero parallax, so
  // stars read as infinitely far instead of being dragged by the sea; only
  // camera rotation pans them, like a real sky.
  const celestial = new THREE.Group();
  shell.scene.add(celestial);
  const starLayers = [
    makeStars(rng, 620, 3.4, pointTexture, 0.0, 0.7),
    makeStars(rng, 420, 5.2, pointTexture, 2.1, 1.1),
  ];
  for (const layer of starLayers) celestial.add(layer.points);

  // Nebulae: flat drifting haze bands, not round balls — squashed wide and
  // dim so they read as background atmosphere.
  const nebulae: THREE.Sprite[] = [];
  const nebulaSpin: number[] = [];
  const nebulaHueShift = [-20, 16, 34];
  for (const [x, y, z, width, height] of [
    [-70, 46, -130, 200, 52],
    [78, 58, -150, 240, 64],
    [4, 78, -115, 150, 40],
  ] as const) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      fog: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(x, y, z);
    sprite.scale.set(width, height, 1);
    sprite.userData.baseX = x;
    sprite.userData.baseW = width;
    sprite.userData.baseH = height;
    nebulae.push(sprite);
    nebulaSpin.push((rng() - 0.5) * 0.05);
    celestial.add(sprite);
  }

  // --- Moon: slowly rotating sphere, brightness breathing with the music ---
  // Rendered in its own orthographic pass *behind* the main scene: a
  // perspective camera stretches off-axis spheres into eggs (worse with the
  // FOV punch), while an orthographic projection keeps the disc perfectly
  // round in the top-right corner at any aspect or beat.
  const moonScene = new THREE.Scene();
  const moonCamera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 100);
  moonCamera.position.z = 40;
  const moonMaps = moonSurfaceMaps(rng);
  const moonMaterial = new THREE.MeshStandardMaterial({
    map: moonMaps.map,
    bumpMap: moonMaps.bump,
    bumpScale: 0.5,
    roughness: 1,
    metalness: 0,
    fog: false,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(6.5, 64, 40), moonMaterial);
  moon.rotation.z = 0.22;
  // Soft raking light: enough to model the craters, flat enough to feel far.
  const moonSun = new THREE.DirectionalLight(0xffffff, 1.7);
  moonSun.position.set(-1.5, 1.0, 1.6);
  const moonFill = new THREE.AmbientLight(0xffffff, 0.8);
  const moonGlowMaterial = new THREE.SpriteMaterial({
    map: texture,
    fog: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const moonGlow = new THREE.Sprite(moonGlowMaterial);
  moonGlow.position.z = -2;
  const moonTint = new THREE.Color();
  // Haze veil: a pale film over the disc that thickens when the music rests,
  // so the moon withdraws into the distance instead of staying crisp.
  const moonHazeMaterial = new THREE.SpriteMaterial({
    map: texture,
    fog: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const moonHaze = new THREE.Sprite(moonHazeMaterial);
  moonHaze.position.z = 2;
  moonHaze.scale.setScalar(17);
  // Cloud wisps drifting across the face — the moon is glimpsed, not shown.
  const wispMap = wispTexture(rng);
  const wispDark = new THREE.Color();
  const wispPale = new THREE.Color();
  type Wisp = {
    sprite: THREE.Sprite;
    material: THREE.SpriteMaterial;
    x: number;
    y: number;
    z: number;
    speed: number;
    range: number;
    baseOpacity: number;
    phase: number;
    dark: boolean;
  };
  const wisps: Wisp[] = [];
  const moonGroup = new THREE.Group();
  moonGroup.add(moonGlow, moon, moonHaze);
  for (let i = 0; i < 5; i++) {
    const material = new THREE.SpriteMaterial({
      map: wispMap,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const dark = i < 3;
    sprite.scale.set(26 + rng() * 22, 6.5 + rng() * 6, 1);
    const wisp: Wisp = {
      sprite,
      material,
      x: (rng() - 0.5) * 72,
      y: (rng() - 0.5) * 16,
      z: 3 + i * 0.7,
      speed: 0.9 + rng() * 1.3,
      range: 38,
      baseOpacity: dark ? 0.3 + rng() * 0.14 : 0.16 + rng() * 0.1,
      phase: rng() * Math.PI * 2,
      dark,
    };
    sprite.position.set(wisp.x, wisp.y, wisp.z);
    wisps.push(wisp);
    moonGroup.add(sprite);
  }
  moonScene.add(moonGroup, moonSun, moonFill);

  // Keep the moon anchored near the top-right corner across aspect ratios.
  const placeMoon = (aspect: number) => {
    moonCamera.left = -50 * aspect;
    moonCamera.right = 50 * aspect;
    moonCamera.updateProjectionMatrix();
    moonGroup.position.set(Math.max(0, 50 * aspect - 18), 33, 0);
  };
  placeMoon(1);

  // --- Mood HUD: read-only acceptance instrument ---------------------------
  // A small ortho overlay (bottom-left) charting the emotion axes the engine
  // is *hearing* — valence / arousal / tension, the build-up charge, the
  // dominant world, the declared-intent marker when the score's key is
  // known, and a hue-tinted playback progress line. This is the visual
  // verification half of the mood spectrum: observation only, redrawn at
  // most ~7×/s, toggled by the moodHud option.
  const hudCanvas = document.createElement("canvas");
  hudCanvas.width = 256;
  hudCanvas.height = 128;
  const hudCtx = hudCanvas.getContext("2d");
  const hudTexture = new THREE.CanvasTexture(hudCanvas);
  const hudMaterial = new THREE.SpriteMaterial({
    map: hudTexture,
    fog: false,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const hudSprite = new THREE.Sprite(hudMaterial);
  hudSprite.scale.set(30, 15, 1);
  const hudScene = new THREE.Scene();
  hudScene.add(hudSprite);
  let hudClock = Number.POSITIVE_INFINITY; // draw on the very first frame
  const placeHud = (aspect: number) => {
    // Sit above the fullscreen transport row (bottom ~9 ortho units) so the
    // acceptance HUD never occludes play/time/REC controls.
    hudSprite.position.set(-50 * aspect + 17.5, -50 + 16, 0);
  };
  placeHud(1);
  const HUD_TRACK_X = 30;
  const HUD_TRACK_W = 214;
  const drawHud = (
    mood: MoodState,
    intentMode: number | undefined,
    progress: number,
    hue: number,
  ) => {
    const g = hudCtx;
    if (!g) return;
    g.clearRect(0, 0, 256, 128);
    g.fillStyle = "rgba(8, 12, 20, 0.6)";
    g.beginPath();
    g.roundRect(0.5, 0.5, 255, 127, 10);
    g.fill();
    const bars: ReadonlyArray<readonly [string, number, string]> = [
      ["V", mood.valence, `hsl(${Math.round(220 - mood.valence * 180)} 72% 62%)`],
      ["A", mood.arousal, "hsl(48 82% 62%)"],
      ["T", mood.tension, "hsl(6 78% 58%)"],
    ];
    g.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.textBaseline = "middle";
    for (let i = 0; i < bars.length; i++) {
      const [label, value, color] = bars[i];
      const y = 15 + i * 24;
      g.fillStyle = "rgba(235, 240, 250, 0.75)";
      g.fillText(label, 11, y);
      g.fillStyle = "rgba(255, 255, 255, 0.13)";
      g.fillRect(HUD_TRACK_X, y - 4, HUD_TRACK_W, 8);
      g.fillStyle = color;
      g.fillRect(HUD_TRACK_X, y - 4, HUD_TRACK_W * value, 8);
    }
    // Neutral-valence midline.
    g.fillStyle = "rgba(255, 255, 255, 0.38)";
    g.fillRect(HUD_TRACK_X + HUD_TRACK_W / 2, 15 - 7, 1, 14);
    // Declared intent: a hollow diamond on the valence track marking where
    // the score *says* the mood should lean. Agreement = fill meets diamond.
    if (intentMode !== undefined) {
      const x = HUD_TRACK_X + HUD_TRACK_W * (0.5 + (intentMode - 0.5) * 0.8);
      g.strokeStyle = "rgba(255, 255, 255, 0.92)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x, 15 - 7);
      g.lineTo(x + 5, 15);
      g.lineTo(x, 15 + 7);
      g.lineTo(x - 5, 15);
      g.closePath();
      g.stroke();
    }
    // Build-up charge line.
    const buildY = 15 + 3 * 24;
    g.fillStyle = "rgba(235, 240, 250, 0.55)";
    g.fillText("↗", 11, buildY);
    g.fillStyle = "rgba(255, 255, 255, 0.1)";
    g.fillRect(HUD_TRACK_X, buildY - 2, HUD_TRACK_W, 4);
    g.fillStyle = `rgba(255, 214, 130, ${(0.45 + mood.buildUp * 0.55).toFixed(3)})`;
    g.fillRect(HUD_TRACK_X, buildY - 2, HUD_TRACK_W * mood.buildUp, 4);
    // Dominant world, weather glyph, and the dominant weight.
    g.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = "rgba(235, 240, 250, 0.92)";
    const pct = Math.round(mood.weights[mood.dominant] * 100);
    const intentTag = intentMode !== undefined ? "  ◆ intent" : "";
    const wxPct = Math.round(mood.weather[mood.weatherMode] * 100);
    g.fillText(
      `${mood.dominant} ${pct}% · ${WEATHER_GLYPH[mood.weatherMode]} ${wxPct}%${intentTag}`,
      11,
      110,
    );
    // Playback progress: a spectrum-hue scrub line along the bottom edge.
    const scrub = Math.max(0, Math.min(1, progress));
    g.fillStyle = "rgba(255, 255, 255, 0.14)";
    g.fillRect(11, 120, HUD_TRACK_X + HUD_TRACK_W - 11, 3);
    g.fillStyle = `hsl(${Math.round(hue)} 75% 62%)`;
    g.fillRect(11, 120, (HUD_TRACK_X + HUD_TRACK_W - 11) * scrub, 3);
    hudTexture.needsUpdate = true;
  };

  // --- Ground: one wave field that morphs between sea and grassland --------
  const geometry = new THREE.PlaneGeometry(GROUND_W, GROUND_D, COLS - 1, ROWS - 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, -GROUND_D / 2 + 34);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const baseX = new Float32Array(position.count);
  const baseZ = new Float32Array(position.count);
  const bandOf = new Uint8Array(position.count);
  for (let i = 0; i < position.count; i++) {
    baseX[i] = position.getX(i);
    baseZ[i] = position.getZ(i);
    bandOf[i] = Math.min(BANDS - 1, Math.floor(((baseX[i] + GROUND_W / 2) / GROUND_W) * BANDS));
  }
  const groundSolid = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: 0x010403,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    }),
  );
  const groundWireMaterial = new THREE.MeshBasicMaterial({
    wireframe: true,
    transparent: true,
    opacity: 0.7,
  });
  const groundWire = new THREE.Mesh(geometry, groundWireMaterial);
  shell.scene.add(groundSolid, groundWire);

  // --- City: instanced skyline, heights follow the band spectrum -----------
  const towerGeometry = new THREE.BoxGeometry(1, 1, 1);
  towerGeometry.translate(0, 0.5, 0);
  const towerMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const city = new THREE.InstancedMesh(towerGeometry, towerMaterial, TOWERS);
  const towerBase = new Float32Array(TOWERS * 4); // x, z, width, height
  const towerBand = new Uint8Array(TOWERS);
  const shade = new THREE.Color();
  for (let i = 0; i < TOWERS; i++) {
    const x = (rng() - 0.5) * 156;
    const z = -38 - rng() * 74;
    towerBase[i * 4] = x;
    towerBase[i * 4 + 1] = z;
    towerBase[i * 4 + 2] = 1.6 + rng() * 2.6;
    towerBase[i * 4 + 3] = 3 + rng() * 12;
    towerBand[i] = Math.min(BANDS - 1, Math.floor(((x + 78) / 156) * BANDS));
    shade.setScalar(0.55 + rng() * 0.45);
    city.setColorAt(i, shade);
  }
  if (city.instanceColor) city.instanceColor.needsUpdate = true;
  shell.scene.add(city);

  // --- Motes: fireflies over the meadow, spray over the sea ----------------
  // Kept away from the camera (z <= -18) so attenuated points stay small
  // sparks instead of ballooning across the lens.
  const motePositions = new Float32Array(MOTES * 3);
  const moteSeed = new Float32Array(MOTES * 3); // baseY, phase, speed
  for (let i = 0; i < MOTES; i++) {
    motePositions[i * 3] = (rng() - 0.5) * 130;
    motePositions[i * 3 + 2] = -18 - rng() * 66;
    moteSeed[i * 3] = 0.6 + rng() * 4.4;
    moteSeed[i * 3 + 1] = rng() * Math.PI * 2;
    moteSeed[i * 3 + 2] = 0.4 + rng() * 1.1;
  }
  const moteGeometry = new THREE.BufferGeometry();
  moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
  const moteMaterial = new THREE.PointsMaterial({
    size: 0.55,
    map: pointTexture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  shell.scene.add(new THREE.Points(moteGeometry, moteMaterial));
  const moteAttr = moteGeometry.getAttribute("position") as THREE.BufferAttribute;

  // --- Meteors: pooled streaks answering bass impacts under open skies -----
  const meteors: Meteor[] = [];
  for (let i = 0; i < METEORS; i++) {
    const material = new THREE.SpriteMaterial({
      map: texture,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(7, 0.6, 1);
    sprite.visible = false;
    celestial.add(sprite);
    meteors.push({ sprite, material, velocity: new THREE.Vector3(), life: 0 });
  }
  let meteorCooldown = 0;

  // --- Horizon glow ---------------------------------------------------------
  const horizonMaterial = new THREE.SpriteMaterial({
    map: texture,
    fog: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const horizon = new THREE.Sprite(horizonMaterial);
  horizon.position.set(0, 5, -118);
  horizon.scale.set(180, 34, 1);
  shell.scene.add(horizon);

  // --- Weather: rain streaks, snow flakes, lightning flash ------------------
  // One particle box ahead of the camera per precipitation kind; drops wrap
  // vertically and re-scatter, so the pools are allocated once and reused.
  const rainPositions = new Float32Array(RAIN_DROPS * 3);
  const rainSeed = new Float32Array(RAIN_DROPS * 2); // fall-speed jitter, x-drift phase
  for (let i = 0; i < RAIN_DROPS; i++) {
    rainPositions[i * 3] = (rng() - 0.5) * 150;
    rainPositions[i * 3 + 1] = rng() * 46;
    rainPositions[i * 3 + 2] = -10 - rng() * 80;
    rainSeed[i * 2] = 0.75 + rng() * 0.5;
    rainSeed[i * 2 + 1] = rng() * Math.PI * 2;
  }
  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute("position", new THREE.BufferAttribute(rainPositions, 3));
  const rainMap = rainTexture();
  const rainMaterial = new THREE.PointsMaterial({
    size: 3.1,
    map: rainMap,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const rain = new THREE.Points(rainGeometry, rainMaterial);
  rain.visible = false;
  shell.scene.add(rain);
  const rainAttr = rainGeometry.getAttribute("position") as THREE.BufferAttribute;

  const snowPositions = new Float32Array(SNOW_FLAKES * 3);
  const snowSeed = new Float32Array(SNOW_FLAKES * 2); // sway phase, fall-speed jitter
  for (let i = 0; i < SNOW_FLAKES; i++) {
    snowPositions[i * 3] = (rng() - 0.5) * 150;
    snowPositions[i * 3 + 1] = rng() * 42;
    snowPositions[i * 3 + 2] = -10 - rng() * 80;
    snowSeed[i * 2] = rng() * Math.PI * 2;
    snowSeed[i * 2 + 1] = 0.7 + rng() * 0.6;
  }
  const snowGeometry = new THREE.BufferGeometry();
  snowGeometry.setAttribute("position", new THREE.BufferAttribute(snowPositions, 3));
  const snowMaterial = new THREE.PointsMaterial({
    size: 0.85,
    map: pointTexture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const snow = new THREE.Points(snowGeometry, snowMaterial);
  snow.visible = false;
  shell.scene.add(snow);
  const snowAttr = snowGeometry.getAttribute("position") as THREE.BufferAttribute;

  // Lightning: a sky-wide flash sprite plus scene-level boosts, double-strike
  // flicker shaped in the render loop. Never triggered under reduced motion.
  const flashMaterial = new THREE.SpriteMaterial({
    map: texture,
    fog: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const flash = new THREE.Sprite(flashMaterial);
  flash.position.set(0, 60, -125);
  flash.scale.set(340, 150, 1);
  flash.visible = false;
  celestial.add(flash);
  let lightning = 0;
  let strikeCooldown = 0;

  // --- Shared per-frame state ----------------------------------------------
  const fallbackMood = neutralMoodState();
  const pulse = new AudioPulse();
  const smoother = new BandSmoother(BANDS, 30, 10);
  const ripples: Ripple[] = [];
  for (let i = 0; i < RIPPLES; i++) ripples.push({ x: 0, z: 0, age: RIPPLE_LIFE, strength: 0 });
  let rippleCursor = 0;
  const worldGround: Record<MoodWorld, THREE.Color> = {
    cosmos: new THREE.Color(), starlight: new THREE.Color(), ocean: new THREE.Color(),
    meadow: new THREE.Color(), city: new THREE.Color(),
  };
  const worldGlow: Record<MoodWorld, THREE.Color> = {
    cosmos: new THREE.Color(), starlight: new THREE.Color(), ocean: new THREE.Color(),
    meadow: new THREE.Color(), city: new THREE.Color(),
  };
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const translate = new THREE.Vector3();
  let waveTime = 0;
  let wispTime = 0;
  let snowTime = 0;
  let moteTime = 0;
  let lastHue = Number.NaN;
  let cityVisible = true;
  // Valence tempers the palette: warm amber when bright, cold blue when dark.
  // Tracked with its own slow envelope so color never flickers frame-to-frame.
  let tempValence = 0.5;
  let lastTempValence = Number.NaN;

  return {
    render(frame: ThreeFrame) {
      // Perception arrives through the frame contract; the scene only renders.
      const mood = frame.mood ?? fallbackMood;
      const intentMode = mood.intent?.modeMajor;
      const w = mood.weights;
      tempValence += (mood.valence - tempValence) * Math.min(1, frame.dt * 0.35);

      const hue = frame.options.themeHue ?? 171;
      if (hue !== lastHue || Math.abs(tempValence - lastTempValence) > 0.015) {
        lastHue = hue;
        lastTempValence = tempValence;
        // Color temperature: valence pulls the whole palette toward warm
        // amber (40°) or cold blue (220°) around the theme hue.
        const lean = tempValence - 0.5;
        const target = lean >= 0 ? 40 : 220;
        const arc = ((target - hue) % 360 + 540) % 360 - 180;
        const warmHue = hue + arc * Math.abs(lean) * 0.55;
        const lightBoost = lean * 0.12;
        setWorldColors(worldGround, warmHue, -0.12 + lightBoost);
        setWorldColors(worldGlow, warmHue, 0.08 + lightBoost);
        for (const layer of starLayers) {
          layer.material.color.setHSL((((warmHue + 8) % 360) + 360) % 360 / 360, 0.2, 0.88);
        }
        for (let i = 0; i < nebulae.length; i++) {
          nebulae[i].material.color.setHSL(
            (((warmHue + PALETTE.cosmos[0] + nebulaHueShift[i]) % 360) + 360) % 360 / 360,
            0.7,
            0.42,
          );
        }
        moonTint.setHSL((((warmHue + 24) % 360) + 360) % 360 / 360, 0.16, 0.92);
        moonGlowMaterial.color.copy(moonTint);
        moonHazeMaterial.color.setHSL((((warmHue + 200) % 360) + 360) % 360 / 360, 0.3, 0.13);
        wispDark.setHSL((((warmHue + 210) % 360) + 360) % 360 / 360, 0.32, 0.11);
        wispPale.setHSL((((warmHue + 30) % 360) + 360) % 360 / 360, 0.14, 0.62);
        for (const wisp of wisps) wisp.material.color.copy(wisp.dark ? wispDark : wispPale);
      }

      const { energy, bass, impact } = pulse.update(
        energyLevel(frame.freq),
        bassLevel(frame.freq),
        frame.dt,
      );
      const bands = smoother.step(bandLevels(frame.freq, BANDS), frame.dt);
      let treble = 0;
      for (let i = BANDS - 4; i < BANDS; i++) treble += bands[i];
      treble /= 4;
      const motion = frame.prefersReducedMotion ? 0.15 : 1;
      const skyW = w.cosmos + w.starlight;
      const punch = impact * motion;
      const tension = mood.tension;
      const buildUp = mood.buildUp;
      // A bass impact landing while build-up is armed = the release. It hits
      // visibly harder than an ordinary beat.
      const releaseKick = punch * buildUp;

      // --- Weather state ----------------------------------------------------
      // Storm implies rain; mist and snow both thicken the air. Overcast is
      // how much cloud stands between the camera and the sky — it dims every
      // celestial element so precipitation always falls from a closed sky.
      const wx = mood.weather;
      const wind = mood.wind;
      const rainW = Math.min(1, wx.rain + wx.storm * 0.85);
      const snowW = wx.snow;
      const stormW = wx.storm;
      const mistW = wx.mist;
      const overcast = Math.min(1, rainW * 0.9 + snowW * 0.55 + mistW * 0.75 + stormW * 0.4);
      const skyClarity = 1 - overcast * 0.82;

      // Lightning: storm-gated strikes on bass impacts or a seeded poisson
      // trickle; a fast-decay envelope with an incommensurate flicker gives
      // the double-strike feel. Disabled entirely under reduced motion.
      strikeCooldown = Math.max(0, strikeCooldown - frame.dt);
      if (
        !frame.prefersReducedMotion &&
        stormW > 0.32 &&
        strikeCooldown <= 0 &&
        (impact > 0.45 || rng() < frame.dt * stormW * 0.45)
      ) {
        lightning = 0.7 + rng() * 0.3;
        strikeCooldown = 1.1 + rng() * 2.6;
      }
      lightning *= Math.exp(-frame.dt * 7);
      const flashLevel =
        lightning > 0.02 ? lightning * (0.72 + 0.28 * Math.sin(frame.elapsed * 43)) : 0;
      flash.visible = flashLevel > 0.02;
      if (flash.visible) {
        flashMaterial.opacity = Math.min(0.85, flashLevel * (0.5 + stormW * 0.5));
        flashMaterial.color.copy(worldGlow.starlight).lerp(moonTint, 0.6);
      }

      // Rain: fast fall, wind shears the streaks sideways; storm drives both
      // the density and the pace. Points wrap inside the box ahead of camera.
      const rainVis = rainW * (0.35 + mood.arousal * 0.5 + stormW * 0.3);
      rainMaterial.opacity = Math.min(0.7, rainVis);
      rain.visible = rainVis > 0.02;
      if (rain.visible) {
        const fall = (24 + mood.arousal * 16 + stormW * 14) * motion;
        const shear = wind * (7 + stormW * 8) * motion;
        for (let i = 0; i < RAIN_DROPS; i++) {
          let y = rainAttr.getY(i) - fall * rainSeed[i * 2] * frame.dt;
          let x = rainAttr.getX(i) + shear * frame.dt;
          if (y < 0) {
            y += 46;
            x = (rng() - 0.5) * 150;
          }
          if (x > 78) x -= 156;
          rainAttr.setXYZ(i, x, y, rainAttr.getZ(i));
        }
        rainAttr.needsUpdate = true;
        rainMaterial.size = 2.6 + stormW * 1.2 + mood.arousal * 0.7;
        rainMaterial.color.copy(worldGlow.ocean).lerp(moonTint, 0.45);
      }

      // Snow: slow fall with a per-flake sinusoidal sway that widens with wind.
      const snowVis = snowW * (0.5 + treble * 0.4);
      snowMaterial.opacity = Math.min(0.85, snowVis);
      snow.visible = snowVis > 0.02;
      snowTime += frame.dt * (0.5 + wind);
      if (snow.visible) {
        const drift = (2 + wind * 2.6) * motion;
        for (let i = 0; i < SNOW_FLAKES; i++) {
          const sway = snowSeed[i * 2];
          let y = snowAttr.getY(i) - drift * snowSeed[i * 2 + 1] * frame.dt;
          let x =
            snowAttr.getX(i) +
            (Math.sin(snowTime + sway) * (0.55 + wind * 1.3) + wind * 1.6) * frame.dt;
          if (y < 0) {
            y += 42;
            x = (rng() - 0.5) * 150;
          }
          if (x > 78) x -= 156;
          snowAttr.setXYZ(i, x, y, snowAttr.getZ(i));
        }
        snowAttr.needsUpdate = true;
        snowMaterial.size = 0.7 + wind * 0.25 + impact * 0.15;
        snowMaterial.color.copy(moonTint);
      }

      // Bass impacts kick an expanding ground ripple from just ahead of camera.
      if (punch > 0.4) {
        const slot = ripples[rippleCursor];
        if (slot.age >= RIPPLE_LIFE * 0.35) {
          slot.x = (rng() - 0.5) * 60;
          slot.z = -30 - rng() * 50;
          slot.age = 0;
          slot.strength = (2.2 + impact * 4.2) * (1 + buildUp * 1.6);
          rippleCursor = (rippleCursor + 1) % RIPPLES;
        }
      }
      for (const ripple of ripples) ripple.age += frame.dt;

      // Sky: stars flare with treble; nebula haze bands breathe on the bass.
      // Overcast slides a cloud deck over everything celestial.
      for (let i = 0; i < starLayers.length; i++) {
        const layer = starLayers[i];
        const twinkle = Math.sin(frame.elapsed * layer.speed * motion + layer.phase);
        layer.material.opacity = Math.min(
          1,
          Math.max(0, (0.3 + skyW * 0.7) * (0.55 + 0.3 * twinkle) + treble * 0.9 + punch * 0.35) *
            skyClarity +
            flashLevel * 0.3,
        );
        layer.material.size = layer.baseSize * (1 + treble * 0.35 + punch * 0.2);
      }
      for (let i = 0; i < nebulae.length; i++) {
        const sprite = nebulae[i];
        const material = sprite.material;
        material.opacity =
          (w.cosmos * (0.26 + bass * 0.5 + impact * 0.15) + w.starlight * 0.1) *
          (1 - overcast * 0.6);
        // Bounded horizontal sway instead of rotation keeps the haze cloud-like.
        sprite.position.x =
          (sprite.userData.baseX as number) +
          Math.sin(frame.elapsed * (0.05 + Math.abs(nebulaSpin[i])) * motion + i * 2.1) *
            (10 + bass * 14) *
            (1 + wind * 0.5);
        sprite.scale.set(
          (sprite.userData.baseW as number) * (1 + bass * 0.18),
          (sprite.userData.baseH as number) * (1 + bass * 0.3 + impact * 0.12),
          1,
        );
      }

      // Moon: a distant presence, not a poster. It hangs half-veiled — the
      // disc fades toward translucence in silence, haze thickens over it,
      // and cloud wisps drift across the face so it is glimpsed, not shown.
      const moonLum =
        Math.min(1, 0.34 + energy * 0.6 + impact * 0.22 + skyW * 0.08) *
        (1 - overcast * 0.45) +
        flashLevel * 0.25;
      moonMaterial.color.copy(moonTint).multiplyScalar(Math.min(1, moonLum));
      moonMaterial.opacity =
        Math.min(0.82, 0.42 + energy * 0.34 + impact * 0.12) * (1 - overcast * 0.55);
      moon.rotation.y += frame.dt * (0.05 + energy * 0.12) * motion;
      moon.rotation.x = Math.sin(frame.elapsed * 0.03 * motion) * 0.1;
      moonGlowMaterial.opacity =
        Math.min(0.4, 0.04 + bass * 0.26 + impact * 0.14) * (1 - w.city * 0.4) * skyClarity;
      moonGlow.scale.setScalar(20 * (1 + bass * 0.25 + impact * 0.1));
      const quiet = 1 - Math.min(1, energy * 1.4);
      moonHazeMaterial.opacity = 0.1 + quiet * 0.2 + mistW * 0.22 + overcast * 0.1;
      // Wind advances wisp drift incrementally — never scale total elapsed by
      // a time-varying factor, or positions jump when the wind shifts.
      wispTime += frame.dt * (0.8 + wind * 0.9) * motion;
      for (const wisp of wisps) {
        const t = wispTime * wisp.speed + wisp.phase * 20;
        // Steady right-to-left drift, wrapped inside a band around the disc.
        const span = wisp.range * 2;
        wisp.sprite.position.x = wisp.range - ((t * 1.6 + wisp.x + wisp.range) % span + span) % span;
        wisp.sprite.position.y = wisp.y + Math.sin(frame.elapsed * 0.11 * motion + wisp.phase) * 2.2;
        const near = 1 - Math.min(1, Math.abs(wisp.sprite.position.x) / wisp.range);
        const breathe = 0.75 + 0.25 * Math.sin(frame.elapsed * 0.09 * motion + wisp.phase * 3);
        wisp.material.opacity = wisp.baseOpacity * breathe * (0.45 + near * 0.55) * (0.72 + quiet * 0.45);
      }

      // Ground morph: the spectrum is carved directly into the wave field.
      // Each column follows its own frequency band, so the terrain *is* the
      // signal; sea swell / grass ripple / starlight drift shape it per world.
      // Tension roughens the field with short-wavelength chop; wind hurries it.
      waveTime += frame.dt * (0.5 + energy * 2.2 + w.ocean * 0.7 + tension * 0.8 + wind * 0.35) * motion;
      const oceanAmp = (1.2 + bass * 6.5 + impact * 2.4) * w.ocean;
      const meadowAmp = (0.45 + energy * 2.4 + impact * 0.8) * w.meadow;
      const starAmp = 0.25 * w.starlight;
      const bandAmp = (0.8 + energy * 1.6) * (1 - skyW * 0.55) * motion;
      const chopAmp = tension * (0.5 + energy * 1.4) * motion;
      const cityFloor = w.city;
      if (oceanAmp + meadowAmp + starAmp + bandAmp + chopAmp > 0.01 || cityVisible) {
        for (let i = 0; i < position.count; i++) {
          const x = baseX[i];
          const z = baseZ[i];
          const sea =
            oceanAmp *
            (Math.sin(x * 0.13 + waveTime * 1.9) * 0.62 +
              Math.sin((x * 0.55 + z) * 0.11 - waveTime * 1.25) * 0.38);
          const grass =
            meadowAmp * Math.sin(x * 0.33 + waveTime * 0.8) * Math.sin(z * 0.27 - waveTime * 0.6);
          const drift = starAmp * Math.sin((x + z) * 0.05 + waveTime * 0.4);
          // Dissonance chop: tight, non-repeating interference agitates the field.
          const chop =
            chopAmp *
            Math.sin(x * 0.71 + waveTime * 3.1) *
            Math.sin(z * 0.83 - waveTime * 2.6);
          // Spectrum carving: column height rides its band, fading with distance.
          const carve =
            bandAmp * bands[bandOf[i]] * (2.6 * Math.exp(-(z + 20) * (z + 20) * 0.00035)) *
            (1 - cityFloor * 0.85);
          // Impact ripples: damped rings expanding from bass hits.
          let ring = 0;
          for (const ripple of ripples) {
            if (ripple.age >= RIPPLE_LIFE) continue;
            const dx = x - ripple.x;
            const dz = z - ripple.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            const radius = ripple.age * 34;
            const width = 7 + ripple.age * 6;
            const band = (dist - radius) / width;
            if (band > -1.6 && band < 1.6) {
              ring +=
                ripple.strength *
                Math.exp(-band * band * 2.2) *
                (1 - ripple.age / RIPPLE_LIFE) *
                Math.sin(band * Math.PI);
            }
          }
          position.setY(i, sea + grass + drift + chop + carve + ring * motion * (1 - cityFloor * 0.6));
        }
        position.needsUpdate = true;
      }
      blendByWeights(groundWireMaterial.color, worldGround, w);
      groundWireMaterial.opacity = Math.min(
        0.95,
        0.3 + energy * 0.55 + impact * 0.35 - skyW * 0.14 + flashLevel * 0.3,
      );

      // City skyline as a slow equalizer.
      const cityW = w.city;
      towerMaterial.opacity = Math.min(0.85, cityW * 1.25);
      towerMaterial.color.copy(worldGlow.city);
      if (cityW > 0.012) {
        cityVisible = true;
        for (let i = 0; i < TOWERS; i++) {
          const width = towerBase[i * 4 + 2];
          const level = bands[towerBand[i]];
          // Squared band response: quiet towers duck low, loud bands leap.
          const height =
            towerBase[i * 4 + 3] *
            cityW *
            (0.12 + level * level * 3.6 + level * 0.5 + impact * 0.9);
          translate.set(towerBase[i * 4], 0, towerBase[i * 4 + 1]);
          scale.set(width, Math.max(0.01, height), width);
          matrix.compose(translate, quaternion, scale);
          city.setMatrixAt(i, matrix);
        }
        city.instanceMatrix.needsUpdate = true;
        city.visible = true;
      } else if (cityVisible) {
        cityVisible = false;
        city.visible = false;
      }

      // Motes: fireflies (meadow), spray (ocean), faint drift under starlight.
      // Tension and wind quicken their flicker; build-up gathers them upward.
      // Flicker phase advances incrementally so the varying rate never jumps.
      moteTime += frame.dt * (motion + energy * 1.6 + tension * 1.4 + wind * 0.8);
      const moteVis = Math.min(1, w.meadow + w.ocean * 0.8 + w.starlight * 0.3);
      moteMaterial.opacity = Math.min(1, moteVis * (0.3 + treble * 0.9 + impact * 0.45 + buildUp * 0.25));
      moteMaterial.size = 0.45 + w.meadow * 0.25 + treble * 0.3 + impact * 0.2;
      blendByWeights(moteMaterial.color, worldGlow, w);
      if (moteVis > 0.02) {
        for (let i = 0; i < MOTES; i++) {
          const baseY = moteSeed[i * 3];
          const phase = moteSeed[i * 3 + 1];
          const speed = moteSeed[i * 3 + 2];
          moteAttr.setY(
            i,
            baseY * (0.4 + w.meadow * 0.9 + w.starlight * 0.6 + buildUp * 0.5) +
              Math.sin(moteTime * speed + phase) *
                (0.5 + w.ocean * 0.9 + impact * 1.4),
          );
        }
        moteAttr.needsUpdate = true;
      }

      // Meteors: under open, clear skies, answering bass impacts.
      meteorCooldown = Math.max(0, meteorCooldown - frame.dt);
      if (
        !frame.prefersReducedMotion &&
        impact > 0.42 &&
        skyW > 0.3 &&
        overcast < 0.45 &&
        meteorCooldown <= 0
      ) {
        const meteor = meteors.find((entry) => entry.life <= 0);
        if (meteor) {
          meteor.sprite.position.set((rng() - 0.5) * 170, 55 + rng() * 45, -95 - rng() * 45);
          meteor.velocity.set(-(14 + rng() * 16), -(20 + rng() * 12), 0);
          meteor.life = 1.15;
          meteor.material.rotation = Math.atan2(meteor.velocity.y, meteor.velocity.x);
          meteor.material.color.copy(worldGlow.starlight);
          meteor.sprite.visible = true;
          meteorCooldown = 0.5;
        }
      }
      for (const meteor of meteors) {
        if (meteor.life <= 0) continue;
        meteor.life -= frame.dt;
        meteor.sprite.position.addScaledVector(meteor.velocity, frame.dt);
        meteor.material.opacity = Math.max(0, meteor.life * 0.8) * skyW;
        if (meteor.life <= 0) meteor.sprite.visible = false;
      }

      // Horizon and fog follow the blended world, breathing with the energy.
      // Build-up charges the horizon glow; the release and lightning flash it
      // wide. Mist and rain draw the fog wall in; a flash momentarily pales it.
      blendByWeights(horizonMaterial.color, worldGlow, w);
      horizonMaterial.opacity = Math.min(
        0.9,
        0.1 + energy * 0.6 + cityW * 0.28 + impact * 0.35 + buildUp * 0.3 + releaseKick * 0.4 +
          flashLevel * 0.35,
      );
      horizon.scale.set(
        180 + energy * 40 + impact * 30 + buildUp * 26,
        34 + cityW * 14 + energy * 16 + impact * 12 + buildUp * 10 + releaseKick * 18,
        1,
      );
      fog.near = 34 + skyW * 32 - cityW * 10 - mistW * 17 - rainW * 6;
      fog.far = 130 + skyW * 80 - cityW * 26 - mistW * 64 - rainW * 20 - stormW * 12;
      blendByWeights(fog.color, worldGround, w).multiplyScalar(
        0.07 + mistW * 0.09 + snowW * 0.05 + flashLevel * 0.3,
      );

      // 身临 camera: drift between world anchors, breathe with the music —
      // bass pushes the eye forward, impacts snap it, treble lifts the gaze.
      camPos.set(0, 0, 0);
      camLook.set(0, 0, 0);
      for (const world of MOOD_WORLDS) {
        const anchor = CAMERA[world];
        const weight = w[world];
        camPos.x += anchor.pos[0] * weight;
        camPos.y += anchor.pos[1] * weight;
        camPos.z += anchor.pos[2] * weight;
        camLook.x += anchor.look[0] * weight;
        camLook.y += anchor.look[1] * weight;
        camLook.z += anchor.look[2] * weight;
      }
      camPos.x += Math.sin(frame.elapsed * 0.05 * motion) * 2.4;
      camPos.y += Math.sin(frame.elapsed * 0.073 * motion) * 0.5 + punch * 1.6;
      camPos.z += (-bass * 5 - punch * 2.5) * motion;
      // Phrase swell breathes the whole viewpoint; positive valence lifts the
      // gaze toward the sky, negative drops it toward the ground.
      camPos.y += mood.swell * 0.9 * motion;
      camLook.y += (mood.valence - 0.5) * 4.5;
      // Tension: incommensurate-frequency micro-tremor — never a readable
      // rhythm, just unease. Scales with tension so rest is truly still.
      const tremor = tension * tension * 0.42 * motion;
      if (tremor > 0.001) {
        camPos.x += Math.sin(frame.elapsed * 13.7) * tremor;
        camPos.y += Math.sin(frame.elapsed * 17.3 + 1.1) * tremor * 0.7;
        camLook.x += Math.sin(frame.elapsed * 15.1 + 2.3) * tremor * 2.2;
      }
      camLook.y += treble * 6 * motion + Math.sin(frame.elapsed * 0.11 * motion) * 1.5;
      shell.camera.position.copy(camPos);
      shell.camera.lookAt(camLook);
      // Pin the sky to the camera's translation (rotation still pans it).
      celestial.position.copy(camPos);
      const targetFov = 58 + punch * 7 + energy * 4 * motion + releaseKick * 9;
      if (Math.abs(shell.camera.fov - targetFov) > 0.05) {
        shell.camera.fov += (targetFov - shell.camera.fov) * Math.min(1, frame.dt * 10);
        shell.camera.updateProjectionMatrix();
      }

      shell.renderer.render(moonScene, moonCamera);
      shell.renderer.clearDepth();
      shell.renderer.autoClear = false;
      shell.renderer.render(shell.scene, shell.camera);
      // HUD pass: reuses the ortho moon camera so bars stay pixel-true.
      const hudOn = (frame.options.moodHud ?? 1) >= 0.5;
      hudSprite.visible = hudOn;
      if (hudOn) {
        hudClock += frame.dt;
        if (hudClock >= 0.15) {
          hudClock = 0;
          drawHud(mood, intentMode, frame.positionFraction, hue);
        }
        shell.renderer.clearDepth();
        shell.renderer.render(hudScene, moonCamera);
      }
      shell.renderer.autoClear = true;
    },
    resize(width, height, dpr) {
      shell.resize(width, height, dpr);
      const aspect = width / Math.max(1, height);
      placeMoon(aspect);
      placeHud(aspect);
    },
    dispose() {
      city.dispose();
      texture.dispose();
      pointTexture.dispose();
      rainGeometry.dispose();
      rainMap.dispose();
      rainMaterial.dispose();
      snowGeometry.dispose();
      snowMaterial.dispose();
      flashMaterial.dispose();
      moon.geometry.dispose();
      moonMaterial.dispose();
      moonGlowMaterial.dispose();
      moonMaps.map.dispose();
      moonMaps.bump.dispose();
      moonHazeMaterial.dispose();
      wispMap.dispose();
      for (const wisp of wisps) wisp.material.dispose();
      hudTexture.dispose();
      hudMaterial.dispose();
      shell.dispose();
    },
  };
}
