/**
 * 情绪 · Mood — showcase demo.
 *
 * A scripted synthetic "journey" drives the mood scene through all five
 * worlds and every resonance channel: spectrum-carved terrain, bass-impact
 * ripples, the equalizer skyline, meteors, nebula surges and the breathing
 * camera. Acts carry real chord spectra (harmonic series at analyser
 * resolution), so the emotion axes — valence from mode, tension from
 * dissonance, build-up from crescendi — respond exactly as they would to
 * rendered music. No audio files and no permissions.
 *
 * Run: `npm run demo:mood`, then open http://127.0.0.1:5175/
 * Keys: 1-7 jump to a scene · Space pause · T cycle theme hue ·
 *       I cycle declared intent (none/major/minor) · R restart.
 */
import { MOOD_WORLDS, MoodEngine } from "../../src/lib/spectrum/mood";
import { AudioPulse } from "../../src/lib/spectrum/dynamics";
import { create } from "../../src/lib/spectrum/three/mood";
import type { ThreeFrame } from "../../src/lib/spectrum/three/types";

/** Mirrors the app's analyser: fftSize 2048 at 48 kHz → 1024 bins. */
const N = 1024;
const SAMPLE_RATE = 48000;
const BIN_HZ = SAMPLE_RATE / (N * 2);
const FADE = 2.5;
const HUES = [171, 210, 285, 330, 30, 120];

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

/** C-major pad (warm) and A-minor voicing (grief) reused across acts. */
const C_MAJOR = [130.81, 164.81, 196.0, 261.63, 329.63, 392.0];
const A_MINOR = [220, 261.63, 329.63, 440];
const A_MAJOR_HIGH = [440, 554.37, 659.25];
/** Semitone-cluster voicing — the storm act's dark strain. */
const A_CLUSTER = [220, 233.08, 246.94, 466.16, 493.88];

interface Act {
  name: string;
  note: string;
  dur: number;
  fill(f: Float32Array, at: number): void;
}

const acts: Act[] = [
  {
    name: "宇宙 · Cosmos",
    note: "深空寂静 — 星云随微弱的低频呼吸，大地静止",
    dur: 13,
    fill(f, at) {
      for (let i = 0; i < N; i++) {
        const t = i / N;
        f[i] = 0.05 * Math.exp(-t * 8) * (0.75 + 0.25 * Math.sin(at * 0.5));
      }
    },
  },
  {
    name: "星空 · Starlight",
    note: "高频细语 — 明亮的大调泛音，星与光尘随高音闪烁",
    dur: 13,
    fill(f, at) {
      for (let i = 0; i < N; i++) {
        const t = i / N;
        let v = 0.04 * Math.exp(-t * 3) + 0.03 * bump(t, 0.5, 40);
        v += 0.08 * bump(t, 0.82, 90) * (0.55 + 0.45 * Math.sin(at * 2.6 + i * 0.35));
        f[i] = v;
      }
      chordInto(f, A_MAJOR_HIGH, 0.5 + 0.08 * Math.sin(at * 0.9), 8);
    },
  },
  {
    name: "大海 · Ocean",
    note: "小调涌浪 — 每次浪击炸开涟漪环，镜头随潮呼吸",
    dur: 18,
    fill(f, at) {
      const swell = 0.5 + 0.3 * Math.sin(at * 0.5);
      const crash = beat(at, 2.4, 0.34);
      for (let i = 0; i < N; i++) {
        const t = i / N;
        let v = swell * 0.08 * Math.exp(-t * 9);
        v += crash * 0.75 * Math.exp(-t * 13);
        v += 0.2 * bump(t, 0.75, 50) * (swell + crash * 0.7);
        f[i] = v;
      }
      chordInto(f, A_MINOR, 0.5 * swell + 0.3, 12);
    },
  },
  {
    name: "草原 · Meadow",
    note: "温暖大调 — 绿丘随和声起伏，萤火虫随高音飞舞",
    dur: 15,
    fill(f, at) {
      const sway = 0.85 + 0.15 * Math.sin(at * 1.2);
      const step = beat(at, 0.8, 0.09) * 0.3;
      for (let i = 0; i < N; i++) {
        const t = i / N;
        let v = 0.1 * Math.exp(-t * 4) * sway + step * Math.exp(-t * 5);
        v += 0.06 * bump(t, 0.85, 80) * (0.5 + 0.5 * Math.sin(at * 3.1 + i));
        f[i] = v;
      }
      chordInto(f, C_MAJOR, 0.55 * sway, 12);
    },
  },
  {
    name: "城市 · City",
    note: "128 BPM — 天际线即均衡器，鼓点冲击镜头与大地",
    dur: 22,
    fill(f, at) {
      const kick = beat(at, 0.469, 0.075);
      const hat = beat(at + 0.234, 0.469, 0.03);
      const sweep = 0.12 + 0.5 * (0.5 + 0.5 * Math.sin(at * 0.7));
      for (let i = 0; i < N; i++) {
        const t = i / N;
        let v = 0.5 * Math.exp(-t * 1.6) * (0.85 + 0.15 * Math.sin(at * 1.7 + t * 9));
        v += kick * 0.55 * Math.exp(-t * 7);
        v += 0.3 * bump(t, sweep, 60);
        v += hat * 0.24 * bump(t, 0.88, 130);
        f[i] = v;
      }
    },
  },
  {
    name: "风暴 · Storm",
    note: "半音簇之墙 — 阴云蔽月，雨幕横斜，雷光应和重击",
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
    name: "归返 · Outro",
    note: "能量退潮 — 小调余韵化雪，回到深空",
    dur: 13,
    fill(f, at) {
      const decay = Math.max(0, 1 - at / 9);
      for (let i = 0; i < N; i++) {
        const t = i / N;
        f[i] =
          0.05 * Math.exp(-t * 8) +
          decay * 0.1 * Math.exp(-t * 3.4) * (0.7 + 0.3 * Math.sin(at * 0.9));
      }
      chordInto(f, A_MINOR, decay * 0.2, 6);
    },
  },
];

const TOTAL = acts.reduce((sum, act) => sum + act.dur, 0);

// --- Scene + parallel HUD models (same deterministic inputs) ----------------
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const instance = create(canvas);
const hudEngine = new MoodEngine();
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
const worldBars = MOOD_WORLDS.map((world) => {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<span class="label">${world}</span><span class="bar"><span class="fill"></span></span>`;
  el("worlds").appendChild(row);
  return row.querySelector(".fill") as HTMLElement;
});
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

function actAt(t: number): { index: number; at: number } {
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
  } else if (event.key === "i" || event.key === "I") {
    intentMode = intentMode === undefined ? 1 : intentMode === 1 ? 0 : undefined;
  } else if (event.key === "r" || event.key === "R") {
    clock = 0;
    hueIndex = 0;
  }
});

// Deep link: ?scene=1..7 starts the journey at that act.
const sceneParam = Number(new URLSearchParams(location.search).get("scene"));
if (sceneParam >= 1 && sceneParam <= acts.length) jumpTo(sceneParam - 1);

function frameLoop(now: number) {
  const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
  last = now;
  if (!paused) {
    clock = (clock + dt) % TOTAL;
    elapsed += dt;

    const { index, at } = actAt(clock);
    const act = acts[index];
    act.fill(f01, at);
    // Crossfade into the next act near the boundary so worlds dissolve.
    const untilEnd = act.dur - at;
    if (untilEnd < FADE) {
      const next = acts[(index + 1) % acts.length];
      next.fill(fMix, FADE - untilEnd);
      const s = 1 - untilEnd / FADE;
      const smooth = s * s * (3 - 2 * s);
      for (let i = 0; i < N; i++) f01[i] += (fMix[i] - f01[i]) * smooth;
    }
    for (let i = 0; i < N; i++) {
      freq[i] = Math.max(0, Math.min(255, Math.round(f01[i] * 255)));
    }

    const frame: ThreeFrame = {
      freq,
      time: new Uint8Array(0),
      positionFraction: clock / TOTAL,
      dt,
      elapsed,
      prefersReducedMotion: false,
      options:
        intentMode === undefined
          ? { themeHue: HUES[hueIndex], sampleRate: SAMPLE_RATE }
          : { themeHue: HUES[hueIndex], sampleRate: SAMPLE_RATE, intentMode },
    };
    instance.render(frame);

    // HUD mirrors the scene's internal models with the same inputs.
    const mood = hudEngine.update(freq, dt, {
      binHz: BIN_HZ,
      intent: intentMode === undefined ? undefined : { modeMajor: intentMode },
    });
    let rawEnergy = 0;
    let rawBass = 0;
    for (let i = 0; i < N; i++) rawEnergy += f01[i];
    for (let i = 0; i < 10; i++) rawBass += f01[i];
    const pulse = hudPulse.update(rawEnergy / N, rawBass / 10, dt);

    actName.textContent = act.name;
    actNote.textContent = act.note;
    actIndex.textContent = `SCENE ${index + 1}/${acts.length}`;
    const intentLabel =
      intentMode === undefined ? "" : ` · intent ${intentMode === 1 ? "major" : "minor"}`;
    hueLabel.textContent = `hue ${HUES[hueIndex]}°${intentLabel}`;
    for (let i = 0; i < MOOD_WORLDS.length; i++) {
      worldBars[i].style.width = `${Math.round(mood.weights[MOOD_WORLDS[i]] * 100)}%`;
    }
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
