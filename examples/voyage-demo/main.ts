/**
 * 航线 · Voyage — showcase demo.
 *
 * A scripted synthetic "flight log" drives the voyage scene through its
 * whole register: the hull-as-equalizer window strips, the five-nozzle
 * burn, cruise-speed streaks, the asteroid belt's near-misses, helical
 * light trails, maintenance drones and the vacuum-transliterated weather
 * (micro-debris rain, ice dust, fog walls, ion flashes). Legs carry real
 * chord spectra so the emotion axes respond exactly as they would to
 * rendered music. No audio files and no permissions.
 *
 * Run: `npm run demo:voyage`, then open http://127.0.0.1:5176/
 * Keys: 1-6 jump to a leg · Space pause · T cycle theme hue ·
 *       I cycle declared intent (none/major/minor) · R restart.
 */
import { MoodEngine } from "../../src/lib/spectrum/mood";
import { AudioPulse } from "../../src/lib/spectrum/dynamics";
import { cruiseSpeed, CRUISE_MAX } from "../../src/lib/spectrum/voyage";
import { create } from "../../src/lib/spectrum/three/voyage";
import type { ThreeFrame } from "../../src/lib/spectrum/three/types";

/** Mirrors the app's analyser: fftSize 2048 at 48 kHz → 1024 bins. */
const N = 1024;
const SAMPLE_RATE = 48000;
const BIN_HZ = SAMPLE_RATE / (N * 2);
const FADE = 2.5;
const HUES = [210, 171, 285, 330, 30, 120];

/** Percussive hit: instant attack at each period start, exponential decay. */
function beat(at: number, period: number, decay: number): number {
  const p = ((at % period) + period) % period;
  return Math.exp(-p / decay);
}

function bump(t: number, center: number, sharp: number): number {
  const d = t - center;
  return Math.exp(-d * d * sharp);
}

/** Add a chord as decaying harmonic series, placed at true bin frequencies. */
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

/** Voicings for the flight log. */
const C_MAJOR = [130.81, 164.81, 196.0, 261.63, 329.63, 392.0];
const A_MINOR = [220, 261.63, 329.63, 440];
const D_MAJOR_DRIVE = [146.83, 220, 293.66, 440, 587.33];
/** Semitone-cluster voicing — the ion storm's dark strain. */
const A_CLUSTER = [220, 233.08, 246.94, 466.16, 493.88];

interface Leg {
  name: string;
  note: string;
  dur: number;
  fill(f: Float32Array, at: number): void;
}

const legs: Leg[] = [
  {
    name: "静航 · Silent Running",
    note: "引擎压至余烬 — 舷窗微光，尘埃慢流，雾墙贴近舰艏",
    dur: 13,
    fill(f, at) {
      for (let i = 0; i < N; i++) {
        const t = i / N;
        f[i] = 0.05 * Math.exp(-t * 8) * (0.75 + 0.25 * Math.sin(at * 0.5));
      }
    },
  },
  {
    name: "加速 · Throttle Up",
    note: "大调推进 — 稳定鼓点点燃引擎，星光拉成尾迹",
    dur: 15,
    fill(f, at) {
      const throttle = Math.min(1, at / 5);
      const kick = beat(at, 0.6, 0.08) * throttle;
      for (let i = 0; i < N; i++) {
        const t = i / N;
        let v = 0.1 * Math.exp(-t * 4) * (0.5 + 0.5 * throttle);
        v += kick * 0.45 * Math.exp(-t * 7);
        v += throttle * 0.07 * bump(t, 0.8, 80) * (0.5 + 0.5 * Math.sin(at * 2.8 + i * 0.3));
        f[i] = v;
      }
      chordInto(f, D_MAJOR_DRIVE, 0.35 + 0.3 * throttle, 11);
    },
  },
  {
    name: "陨石带 · The Belt",
    note: "小调紧张 — 岩块逼近航线，切分重击换来擦身而过",
    dur: 18,
    fill(f, at) {
      const strain = 0.7 + 0.3 * Math.sin(at * 0.9);
      const hit = beat(at, 1.13, 0.1) + 0.6 * beat(at + 0.41, 2.26, 0.07);
      for (let i = 0; i < N; i++) {
        const t = i / N;
        let v = 0.16 * Math.exp(-t * 3) * strain;
        v += hit * 0.5 * Math.exp(-t * 9);
        f[i] = v;
      }
      chordInto(f, A_MINOR, 0.45 * strain, 12);
      chordInto(f, [311.13, 466.16], 0.18 * strain, 6);
    },
  },
  {
    name: "蓄力 · Ignition",
    note: "十秒渐强 — 引擎充能逼近白热，视野拉宽，然后释放",
    dur: 16,
    fill(f, at) {
      const charge = Math.min(1, at / 10);
      const release = at > 10.5 ? 1 : 0;
      const kick = release ? beat(at - 10.5, 0.469, 0.075) : 0;
      for (let i = 0; i < N; i++) {
        const t = i / N;
        let v = (0.08 + charge * 0.4) * Math.exp(-t * 2.4);
        v += kick * 0.6 * Math.exp(-t * 7);
        v += charge * 0.1 * bump(t, 0.5 + charge * 0.3, 50);
        f[i] = v;
      }
      chordInto(f, D_MAJOR_DRIVE, 0.2 + charge * 0.5 + release * 0.15, 12);
    },
  },
  {
    name: "离子风暴 · Ion Storm",
    note: "半音簇之墙 — 星云深处电光应和重击，微陨尘横扫舰体",
    dur: 18,
    fill(f, at) {
      const kick = beat(at, 0.55, 0.09);
      const surge = 0.8 + 0.2 * Math.sin(at * 0.8);
      for (let i = 0; i < N; i++) {
        const t = i / N;
        let v = 0.22 * Math.exp(-t * 2.2) * surge;
        v += kick * 0.5 * Math.exp(-t * 8);
        f[i] = v;
      }
      chordInto(f, A_CLUSTER, 0.75 * surge, 10);
    },
  },
  {
    name: "归航 · Home Stretch",
    note: "暖色退潮 — 大调余韵化作冰晶尘，航速缓缓收油",
    dur: 14,
    fill(f, at) {
      const decay = Math.max(0, 1 - at / 10);
      for (let i = 0; i < N; i++) {
        const t = i / N;
        f[i] =
          0.05 * Math.exp(-t * 8) +
          decay * 0.12 * Math.exp(-t * 3.4) * (0.7 + 0.3 * Math.sin(at * 0.9));
      }
      chordInto(f, C_MAJOR, 0.15 + decay * 0.25, 8);
    },
  },
];

const TOTAL = legs.reduce((sum, leg) => sum + leg.dur, 0);

// --- Scene + shared perception engine (the demo plays the view's role) ------
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const instance = create(canvas);
const engine = new MoodEngine();
const hudPulse = new AudioPulse();

function resize() {
  instance.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio, 2));
}
window.addEventListener("resize", resize);
resize();

// --- HUD ---------------------------------------------------------------------
const el = (id: string) => document.getElementById(id) as HTMLElement;
const actName = el("act-name");
const actNote = el("act-note");
const actIndex = el("act-index");
const hueLabel = el("hue-label");
const pausedLabel = el("paused");
const helmSpeed = el("helm-speed");
const helmWeather = el("helm-weather");
const helmBar = (() => {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<span class="label">throttle</span><span class="bar"><span class="fill"></span></span>`;
  el("helm-bars").appendChild(row);
  return row.querySelector(".fill") as HTMLElement;
})();
const signalBars = (["energy", "bass", "impact", "valence", "tension", "build"] as const).map(
  (key) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="label">${key}</span><span class="bar"><span class="fill"></span></span>`;
    el("signals").appendChild(row);
    return row.querySelector(".fill") as HTMLElement;
  },
);

// --- Journey clock -----------------------------------------------------------
const f01 = new Float32Array(N);
const fMix = new Float32Array(N);
const freq = new Uint8Array(N);
let clock = 0;
let elapsed = 0;
let paused = false;
let hueIndex = 0;
/** Declared-intent cycle: no prior → major → minor (key I). */
let intentMode: number | undefined = undefined;
let last = performance.now();

function legAt(t: number): { index: number; at: number } {
  let acc = 0;
  for (let i = 0; i < legs.length; i++) {
    if (t < acc + legs[i].dur) return { index: i, at: t - acc };
    acc += legs[i].dur;
  }
  return { index: 0, at: 0 };
}

function jumpTo(index: number) {
  let acc = 0;
  for (let i = 0; i < index; i++) acc += legs[i].dur;
  clock = acc;
}

window.addEventListener("keydown", (event) => {
  if (event.key === " ") {
    paused = !paused;
    pausedLabel.style.display = paused ? "block" : "none";
    event.preventDefault();
  } else if (event.key >= "1" && event.key <= String(legs.length)) {
    jumpTo(Number(event.key) - 1);
  } else if (event.key === "t" || event.key === "T") {
    hueIndex = (hueIndex + 1) % HUES.length;
  } else if (event.key === "i" || event.key === "I") {
    intentMode = intentMode === undefined ? 1 : intentMode === 1 ? 0 : undefined;
  } else if (event.key === "r" || event.key === "R") {
    clock = 0;
    hueIndex = 0;
  }
});

// Deep link: ?scene=1..6 starts the journey at that leg. ?hold=1 pins the
// spectrum; ?at=0..1 chooses the point inside the leg; ?freeze=1 fixes visual
// time as well, so acceptance captures share the exact same camera. ?time=N
// selects that fixed time for motion-phase comparisons such as logo breathing.
const query = new URLSearchParams(location.search);
const sceneParam = Number(query.get("scene"));
if (sceneParam >= 1 && sceneParam <= legs.length) jumpTo(sceneParam - 1);
const holdLeg = query.get("hold") === "1";
const holdFraction = Math.max(0.05, Math.min(0.95, Number(query.get("at") ?? 0.62)));
const freezeVisual = query.get("freeze") === "1";
const requestedVisualTime = Number(query.get("time"));
const frozenVisualTime =
  query.has("time") && Number.isFinite(requestedVisualTime)
    ? Math.max(0, requestedVisualTime)
    : 18.5;
const wireframe = query.get("wire") === "0" ? 0 : 1;
const bloom = query.get("bloom") === "0" ? 0 : 1;
const materialPreview = query.get("material") === "1" ? 1 : 0;
const backgroundPass =
  query.get("pass") === "stars" ? 1 : query.get("pass") === "space" ? 2 : 0;
const cleanCapture = query.get("clean") === "1";
if (cleanCapture) document.body.classList.add("capture-clean");
const requestedBackgroundTime = Number(query.get("bg"));
const backgroundTime =
  query.has("bg") && Number.isFinite(requestedBackgroundTime)
    ? Math.max(0, requestedBackgroundTime)
    : -1;
const holdClock = (() => {
  if (!holdLeg || !(sceneParam >= 1)) return -1;
  let acc = 0;
  for (let i = 0; i < sceneParam - 1; i++) acc += legs[i].dur;
  return acc + legs[sceneParam - 1].dur * holdFraction;
})();

// Dev-only composition guide: ?safe=1 overlays the UI no-go zones —
// top-left title block (x 0–42%, y 0–20%) and the bottom strip (y 90–100%).
if (query.get("safe") === "1") {
  for (const zone of [
    { left: "0", top: "0", width: "42%", height: "20%" },
    { left: "0", top: "90%", width: "100%", height: "10%" },
    { left: "86%", top: "0", width: "14%", height: "15%" },
  ]) {
    const div = document.createElement("div");
    Object.assign(div.style, {
      position: "fixed",
      left: zone.left,
      top: zone.top,
      width: zone.width,
      height: zone.height,
      background: "rgba(255,60,60,0.14)",
      outline: "1px dashed rgba(255,90,90,0.7)",
      pointerEvents: "none",
      zIndex: "40",
    });
    document.body.appendChild(div);
  }
}

function frameLoop(now: number) {
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  if (!paused) {
    clock = holdClock >= 0 ? holdClock : (clock + dt) % TOTAL;
    elapsed = freezeVisual ? frozenVisualTime : elapsed + dt;

    const { index, at } = legAt(clock);
    const leg = legs[index];
    leg.fill(f01, at);
    // Crossfade into the next leg near the boundary so moods dissolve.
    const untilEnd = leg.dur - at;
    if (untilEnd < FADE) {
      const next = legs[(index + 1) % legs.length];
      next.fill(fMix, FADE - untilEnd);
      const s = 1 - untilEnd / FADE;
      const smooth = s * s * (3 - 2 * s);
      for (let i = 0; i < N; i++) f01[i] += (fMix[i] - f01[i]) * smooth;
    }
    for (let i = 0; i < N; i++) {
      freq[i] = Math.max(0, Math.min(255, Math.round(f01[i] * 255)));
    }

    // Perception is computed once and delivered to the scene through the
    // frame contract — exactly how SpectrumView feeds mood-aware styles.
    const mood = engine.update(freq, dt, {
      binHz: BIN_HZ,
      intent: intentMode === undefined ? undefined : { modeMajor: intentMode },
    });

    const frame: ThreeFrame = {
      freq,
      time: new Uint8Array(0),
      positionFraction: clock / TOTAL,
      dt,
      elapsed,
      prefersReducedMotion: false,
      options: {
        themeHue: HUES[hueIndex],
        wireframe,
        bloom,
        materialPreview,
        backgroundTime,
        backgroundPass,
        moodHud: cleanCapture ? 0 : 1,
      },
      mood,
    };
    instance.render(frame);

    // HUD reads the same pure model the scene consumes.
    let rawEnergy = 0;
    let rawBass = 0;
    for (let i = 0; i < N; i++) rawEnergy += f01[i];
    for (let i = 0; i < 10; i++) rawBass += f01[i];
    const pulse = hudPulse.update(rawEnergy / N, rawBass / 10, dt);
    const speed = cruiseSpeed(mood, pulse.impact);

    actName.textContent = leg.name;
    actNote.textContent = leg.note;
    actIndex.textContent = `LEG ${index + 1}/${legs.length}`;
    const intentLabel =
      intentMode === undefined ? "" : ` · intent ${intentMode === 1 ? "major" : "minor"}`;
    hueLabel.textContent = `hue ${HUES[hueIndex]}°${intentLabel}`;
    helmSpeed.innerHTML = `${speed.toFixed(2)} <small>CRUISE</small>`;
    helmWeather.textContent = `${mood.weatherMode} · wind ${mood.wind.toFixed(2)}`;
    helmBar.style.width = `${Math.round((speed / CRUISE_MAX) * 100)}%`;
    signalBars[0].style.width = `${Math.round(Math.min(1, pulse.energy * 1.6) * 100)}%`;
    signalBars[1].style.width = `${Math.round(Math.min(1, pulse.bass * 1.4) * 100)}%`;
    signalBars[2].style.width = `${Math.round(Math.min(1, pulse.impact) * 100)}%`;
    signalBars[3].style.width = `${Math.round(mood.valence * 100)}%`;
    signalBars[4].style.width = `${Math.round(mood.tension * 100)}%`;
    signalBars[5].style.width = `${Math.round(mood.buildUp * 100)}%`;
  }
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);
