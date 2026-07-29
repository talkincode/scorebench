/**
 * 蜃景 · Mirage — showcase demo.
 *
 * A scripted synthetic score drives one cinematic particle world through its
 * whole register: quiet space, a driving crossing, dry tension, a percussive
 * section, still high air and a storm. No audio files and no permissions.
 *
 * Run: `npm run demo:mirage`, then open http://127.0.0.1:5178/
 * Keys: 1-6 jump to an act · Space pause · T cycle theme hue · R restart.
 */
import { MoodEngine, MOOD_WORLDS } from "../../src/lib/spectrum/mood";
import { create } from "../../src/lib/spectrum/three/mirage";
import type { ThreeFrame } from "../../src/lib/spectrum/three/types";

/** Mirrors the app's analyser: fftSize 2048 at 48 kHz → 1024 bins. */
const N = 1024;
const SAMPLE_RATE = 48000;
const BIN_HZ = SAMPLE_RATE / (N * 2);
const HUES = [171, 210, 285, 330, 30, 120];

function beat(at: number, period: number, decay: number): number {
  const p = ((at % period) + period) % period;
  return Math.exp(-p / decay);
}

/** Add a chord as a decaying harmonic series at true bin frequencies. */
function chordInto(f: Float32Array, fundamentals: number[], level: number, harmonics = 10): void {
  for (const f0 of fundamentals) {
    for (let h = 1; h <= harmonics; h++) {
      const exact = (f0 * h) / BIN_HZ - 0.5;
      const lo = Math.floor(exact);
      const frac = exact - lo;
      const amp = level * Math.exp(-(h - 1) * 0.55);
      if (lo >= 0 && lo < N) f[lo] += amp * (1 - frac);
      if (lo + 1 >= 0 && lo + 1 < N) f[lo + 1] += amp * frac;
    }
  }
}

/** Broadband noise floor — drums, air, and the treble shimmer. */
function noiseInto(f: Float32Array, level: number, tilt: number): void {
  for (let i = 0; i < N; i++) {
    const t = i / N;
    f[i] += level * Math.exp(-t * tilt) * (0.55 + 0.45 * Math.sin(i * 12.9898));
  }
}

const D_MAJOR = [146.83, 220, 293.66, 440, 587.33];
const A_MINOR = [220, 261.63, 329.63, 440];
const E_MINOR_DRIVE = [82.41, 164.81, 246.94, 329.63, 493.88];
const A_CLUSTER = [220, 233.08, 246.94, 466.16, 493.88];
const HIGH_AIR = [523.25, 659.25, 783.99, 1046.5];

interface Act {
  name: string;
  note: string;
  dur: number;
  fill: (f: Float32Array, at: number) => void;
}

const acts: Act[] = [
  {
    name: "静水 · Still water",
    note: "low arousal, consonant — the sea and the star dome",
    dur: 26,
    fill: (f, at) => {
      chordInto(f, D_MAJOR, 0.5 + 0.1 * Math.sin(at * 0.4));
      noiseInto(f, 0.05, 7);
    },
  },
  {
    name: "远航 · Crossing",
    note: "arousal climbs, pulse arrives",
    dur: 26,
    fill: (f, at) => {
      chordInto(f, D_MAJOR, 0.7);
      noiseInto(f, 0.12 + beat(at, 0.5, 0.08) * 0.5, 4);
      chordInto(f, [73.42], beat(at, 0.5, 0.06) * 1.4, 4);
    },
  },
  {
    name: "干渴 · Dry strain",
    note: "minor and rough — tension without loudness",
    dur: 24,
    fill: (f, at) => {
      chordInto(f, A_MINOR, 0.55);
      chordInto(f, A_CLUSTER, 0.28 + 0.14 * Math.sin(at * 0.6));
      noiseInto(f, 0.07, 6);
    },
  },
  {
    name: "城市 · City",
    note: "percussive, bright, dense",
    dur: 26,
    fill: (f, at) => {
      chordInto(f, E_MINOR_DRIVE, 0.75);
      chordInto(f, [55], beat(at, 0.42, 0.05) * 1.8, 3);
      noiseInto(f, 0.2 + beat(at, 0.21, 0.04) * 0.6, 2.2);
    },
  },
  {
    name: "极光 · High air",
    note: "sparse, bright, still — the quiet end of the register",
    dur: 24,
    fill: (f, at) => {
      chordInto(f, HIGH_AIR, 0.4 + 0.12 * Math.sin(at * 0.5), 5);
      noiseInto(f, 0.05, 1.6);
    },
  },
  {
    name: "风暴 · Storm",
    note: "dark strain with a long build-up and a release",
    dur: 30,
    fill: (f, at) => {
      const swell = Math.min(1, at / 20);
      chordInto(f, A_CLUSTER, 0.5 + swell * 0.7);
      chordInto(f, [41.2], beat(at, 0.33, 0.05) * (1 + swell * 1.6), 3);
      noiseInto(f, 0.15 + swell * 0.5, 2.6);
      if (at > 22) noiseInto(f, Math.max(0, 0.8 - (at - 22) * 0.35), 5);
    },
  },
];

const TOTAL = acts.reduce((sum, act) => sum + act.dur, 0);

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const actName = document.getElementById("act-name")!;
const actNote = document.getElementById("act-note")!;
const actIndex = document.getElementById("act-index")!;
const hueLabel = document.getElementById("hue-label")!;
const worldsHost = document.getElementById("worlds")!;
const pausedLabel = document.getElementById("paused")!;

const worldBars = MOOD_WORLDS.map((world) => {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<span class="label">${world}</span><span class="bar"><i class="fill"></i></span>`;
  worldsHost.appendChild(row);
  return row.querySelector("i") as HTMLElement;
});

// ?probe=1 turns the page into a deterministic density probe: fixed act,
// N synchronous frames at a query-set buffer size, then lit-pixel
// coverage published through document.title for a headless runner to read.
const query = new URLSearchParams(location.search);
const probing = query.get("probe") === "1";

const instance = create(canvas);
const engine = new MoodEngine();
const freq = new Uint8Array(N);
const f01 = new Float32Array(N);
const time = new Uint8Array(0);
let clock = 0;
let elapsed = 0;
let last = performance.now();
let paused = false;
let hueIndex = 0;
let pinnedAct = -1;

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  instance.resize(width, height, devicePixelRatio);
}
if (!probing) {
  window.addEventListener("resize", resize);
  resize();
}

function actAt(t: number): { index: number; at: number } {
  if (pinnedAct >= 0) return { index: pinnedAct, at: t % acts[pinnedAct].dur };
  let acc = 0;
  for (let i = 0; i < acts.length; i++) {
    if (t < acc + acts[i].dur) return { index: i, at: t - acc };
    acc += acts[i].dur;
  }
  return { index: 0, at: 0 };
}

function jumpTo(index: number) {
  let acc = 0;
  for (let i = 0; i < index; i++) acc += acts[i].dur;
  clock = acc;
}

window.addEventListener("keydown", (event) => {
  if (event.key === " ") {
    paused = !paused;
    pausedLabel.style.display = paused ? "block" : "none";
    event.preventDefault();
  } else if (event.key >= "1" && event.key <= String(acts.length)) {
    jumpTo(Number(event.key) - 1);
  } else if (event.key === "t" || event.key === "T") {
    hueIndex = (hueIndex + 1) % HUES.length;
  } else if (event.key === "r" || event.key === "R") {
    clock = 0;
    hueIndex = 0;
  }
});

const actParam = Number(query.get("act"));
if (actParam >= 1 && actParam <= acts.length) {
  jumpTo(actParam - 1);
  // ?pin=1 keeps the score inside that act so acceptance captures are repeatable.
  if (query.get("pin") === "1") pinnedAct = actParam - 1;
}
function frameLoop(now: number) {
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  if (!paused) {
    clock = (clock + dt) % TOTAL;
    elapsed += dt;

    const { index, at } = actAt(clock);
    const act = acts[index];
    f01.fill(0);
    act.fill(f01, at);
    for (let i = 0; i < N; i++) freq[i] = Math.max(0, Math.min(255, Math.round(f01[i] * 255)));

    const mood = engine.update(freq, dt, { binHz: BIN_HZ });
    const frame: ThreeFrame = {
      freq,
      time,
      positionFraction: clock / TOTAL,
      dt,
      elapsed,
      prefersReducedMotion: false,
      options: {
        themeHue: HUES[hueIndex],
      },
      mood,
    };
    instance.render(frame);

    actName.textContent = act.name;
    actNote.textContent = act.note;
    actIndex.textContent = `ACT ${index + 1}/${acts.length}`;
    hueLabel.textContent = `hue ${HUES[hueIndex]}°`;
    for (let i = 0; i < MOOD_WORLDS.length; i++) {
      worldBars[i].style.width = `${Math.round(mood.weights[MOOD_WORLDS[i]] * 100)}%`;
    }
  }
  requestAnimationFrame(frameLoop);
}

/**
 * Deterministic probe: pin an act, hold the form, run a fixed number of
 * synchronous frames at an exact buffer size, then publish lit-pixel coverage
 * through document.title. Doubles as a stable screenshot fixture, because the
 * canvas keeps its last presented frame after the loop ends.
 */
function runProbe(): void {
  const width = Math.max(64, Number(query.get("w")) || 1280);
  const height = Math.max(64, Number(query.get("h")) || 720);
  const dpr = Math.min(3, Math.max(1, Number(query.get("dpr")) || 1));
  const frames = Math.min(600, Math.max(1, Number(query.get("frames")) || 180));
  pinnedAct = Math.min(acts.length, Math.max(1, Number(query.get("act")) || 1)) - 1;
  for (const element of [actName, actNote, actIndex, hueLabel, worldsHost, pausedLabel]) {
    (element as HTMLElement).style.display = "none";
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  instance.resize(width, height, dpr);
  const dt = 1 / 60;
  for (let i = 0; i < frames; i++) {
    clock += dt;
    elapsed += dt;
    const { index, at } = actAt(clock);
    f01.fill(0);
    acts[index].fill(f01, at);
    for (let bin = 0; bin < N; bin++) {
      freq[bin] = Math.max(0, Math.min(255, Math.round(f01[bin] * 255)));
    }
    const mood = engine.update(freq, dt, { binHz: BIN_HZ });
    const frame: ThreeFrame = {
      freq,
      time,
      positionFraction: clock / TOTAL,
      dt,
      elapsed,
      prefersReducedMotion: false,
      options: { themeHue: HUES[0], moodHud: 0 },
      mood,
    };
    instance.render(frame);
  }
  // Same-task readback: the drawing buffer is still intact because this loop
  // never yields to the compositor, so no preserveDrawingBuffer is needed.
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as
    | WebGL2RenderingContext
    | WebGLRenderingContext
    | null;
  let lit = 0;
  let luma = 0;
  let pixels = 0;
  if (gl) {
    const bufferWidth = gl.drawingBufferWidth;
    const bufferHeight = gl.drawingBufferHeight;
    const data = new Uint8Array(bufferWidth * bufferHeight * 4);
    gl.readPixels(0, 0, bufferWidth, bufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
    pixels = bufferWidth * bufferHeight;
    for (let i = 0; i < data.length; i += 4) {
      const peak = Math.max(data[i], data[i + 1], data[i + 2]);
      luma += peak;
      if (peak > 24) lit++;
    }
  }
  document.title = JSON.stringify({
    probe: "mirage-density",
    width,
    height,
    dpr,
    lit: pixels ? Number((lit / pixels).toFixed(4)) : 0,
    luma: pixels ? Number((luma / (pixels * 255)).toFixed(4)) : 0,
  });
}

if (probing) runProbe();
else requestAnimationFrame(frameLoop);
