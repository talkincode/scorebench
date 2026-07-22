# Imagery Plugin Protocol (IPP) v1 — draft

**Status: draft proposal — not yet implemented by the host.** This document is the
normative specification for third-party spectrum imagery plugins. It extends the
M9 imagery chassis (see [roadmap.md](roadmap.md), §M9) beyond in-tree styles: a
plugin is a WebAssembly module that receives one read-only observation block per
frame and paints one canvas. Nothing more.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described
in RFC 2119.

---

## 1. Design invariants

These are inherited from the host's iron rules and are non-negotiable for every
tier and every ABI version:

1. **Observation-only.** A plugin renders analyser data. It MUST NOT be able to
   control playback, audio nodes, project state, or the host UI. The protocol
   enforces this structurally: the host exposes no imports and no messages that
   mutate anything.
2. **No network.** Plugins MUST NOT perform network I/O. Tier B plugins are
   loaded under a CSP that denies all network access; a plugin that attempts it
   is non-conformant.
3. **Host owns the clock.** There is no plugin-side main loop. The host drives
   every frame from its own `requestAnimationFrame`. Emscripten builds MUST NOT
   call `emscripten_set_main_loop` (§7.3).
4. **Failure never stops the music.** A trapped, throwing, or unresponsive
   plugin is disposed and the view falls back to the built-in `bars` style —
   the same contract three.js styles have today. Playback continues.
5. **Deterministic per frame.** All motion MUST derive from the frame data
   (`dt`, `elapsed`, analyser arrays, mood) and the `seed` passed at init.
   Two runs with identical inputs SHOULD produce identical output. Plugins
   MUST NOT read wall-clock time as a motion source.
6. **Reduced motion is honored.** When the `reducedMotion` flag is set, the
   plugin MUST reduce temporal movement (slower/no camera motion, no flashes).

## 2. Terminology and tiers

| Term | Meaning |
| --- | --- |
| **Imagery** (意象) | One visual style; what a plugin implements. |
| **Host** | The scorebench spectrum view (owner of registry, RAF loop, fallback). |
| **FrameBlock** | The versioned binary observation record the host writes each frame (§5). |
| **Tier A — `wasm-fb`** | A pure `.wasm` module with **no JavaScript**. It renders RGBA pixels into its own linear memory; the host blits them. Structurally sandboxed, machine-verifiable via golden frames. |
| **Tier B — `wasm-gl`** | An Emscripten-style bundle (`.wasm` + glue JS) that owns a real `<canvas>` with a WebGL context inside a sandboxed same-origin iframe. This is the raylib tier. |

Choose Tier A when your renderer is CPU-side (software rasterizer, generative
pixels). Choose Tier B when you need the GPU (raylib, wgpu-on-WebGL, custom GL).

## 3. Distribution layout and manifest

A plugin is a directory:

```
<plugins-dir>/<plugin-id>/
├── imagery.json          # manifest (required)
├── plugin.wasm           # required
├── plugin.js             # Tier B only: Emscripten glue / shim entry
└── assets/…              # optional static assets, same-directory only
```

`<plugins-dir>` is the app-level plugin root (per-user application data
directory). Plugins are never stored inside project directories. The Rust core
only enumerates manifests, containment-checks paths, and serves bytes to the
webview; the entire runtime lives in the frontend.

### 3.1 `imagery.json` schema

```json
{
  "abi": "ipp/1",
  "id": "starfield-rl",
  "label": "星野 · Starfield",
  "tier": "wasm-gl",
  "entry": { "wasm": "plugin.wasm", "glue": "plugin.js" },
  "moodAware": true,
  "moodSignature": { "valence": [0.2, 0.8], "arousal": [0.4, 1.0], "tension": [0.0, 0.5] },
  "options": [
    { "key": "density", "label": "Density", "min": 0, "max": 1, "step": 0.05, "defaultValue": 0.6 }
  ]
}
```

| Field | Type | Req. | Semantics |
| --- | --- | --- | --- |
| `abi` | `"ipp/1"` | ✔ | Protocol version. The host refuses to load unknown majors. |
| `id` | string | ✔ | `[a-z0-9-]{1,32}`, unique per install; also the registry style id. |
| `label` | string | ✔ | Picker display name. May contain CJK. |
| `tier` | `"wasm-fb" \| "wasm-gl"` | ✔ | Selects the ABI in §6 or §7. |
| `entry.wasm` | relative path | ✔ | The module. Paths MUST stay inside the plugin directory. |
| `entry.glue` | relative path | Tier B | ES module whose default export is the shim entry (§7.2). |
| `moodAware` | boolean | — | Mirrors `VisualStyleEntry.moodAware`: the host runs the shared `MoodEngine` only while a mood-aware style is active. When `false`/absent the mood section of the FrameBlock is zeroed and `flags.moodValid` is 0. |
| `moodSignature` | axis ranges | — | The V-A-T region this imagery expresses best; consumed by `auto` emotion-affinity selection (roadmap M9). Each axis is `[min, max]` in `0..1`; omitted axes mean "don't care". |
| `options` | array | — | Same shape as the in-tree `SpectrumOptionDefinition`; the player renders the sliders generically. **Order is normative**: it fixes the option slot order in the FrameBlock (§5). Max 16 options. |

A manifest that fails schema validation is rejected before any code loads.

## 4. Lifecycle

Identical in shape to the in-tree `ThreeInstance`, so the host gains no new
concepts:

```
load → init(width, height, dpr, seed) → frame(FrameBlock) … per RAF …
     → resize(width, height, dpr)     (on element/DPR change)
     → dispose()                      (style switch, view unmount, or failure)
```

- `width`/`height` are CSS pixels; `dpr` is the device pixel ratio. Tier A
  renders at CSS resolution (host upscales); Tier B SHOULD size its
  backing store to `width*dpr × height*dpr` like in-tree scenes do.
- `seed` is a `u32` chosen by the host per instance. All layout randomness
  MUST derive from it (cf. the in-tree `seededRandom` convention).
- After `dispose()` the instance is dead; a style re-select creates a fresh
  instance. Tier B receives a fresh iframe (and thus a fresh canvas) every
  time — a canvas that ever held a WebGL context is never reused.

## 5. FrameBlock binary layout

One little-endian, self-describing record per frame. The host writes it; the
plugin only reads. All offsets in bytes. `K` = manifest option count.

| Offset | Size | Type | Field |
| --- | --- | --- | --- |
| 0 | 4 | u32 | Magic `0x31505049` (`"IPP1"`). |
| 4 | 4 | u32 | Flags: bit0 `reducedMotion`, bit1 `moodValid`. Other bits reserved, MUST be ignored. |
| 8 | 4 | f32 | `positionFraction` — playback position `0..1` (0 when idle). |
| 12 | 4 | f32 | `dt` — seconds since previous frame, host-clamped to ≤ 0.1. |
| 16 | 4 | f32 | `elapsed` — seconds since `init`. |
| 20 | 4 | f32 | `arousal` `0..1` |
| 24 | 4 | f32 | `valence` `0..1` (0.5 = neutral) |
| 28 | 4 | f32 | `tension` `0..1` |
| 32 | 4 | f32 | `pulse` `0..1` |
| 36 | 4 | f32 | `buildUp` `0..1` |
| 40 | 4 | f32 | `swell` `-1..1` |
| 44 | 4 | f32 | `wind` `0..1` |
| 48 | 4 | f32 | `intentModeMajor` — declared mode `0..1`, or `-1` when no intent was declared. |
| 52 | 20 | f32[5] | World weights, order: cosmos, starlight, ocean, meadow, city. Sum ≈ 1. |
| 72 | 4 | u32 | Dominant world index `0..4` (same order). |
| 76 | 20 | f32[5] | Weather weights, order: clear, mist, rain, snow, storm. Sum ≈ 1. |
| 96 | 4 | u32 | Dominant weather index `0..4` (same order). |
| 100 | 4 | u32 | `K` — option count (echoes the manifest). |
| 104 | 4·K | f32[K] | Option values, in manifest declaration order. |
| 104+4K | 4 | u32 | `freqLen` |
| 108+4K | freqLen | u8[] | Frequency bins (WebAudio `getByteFrequencyData`). |
| 108+4K+freqLen | 4 | u32 | `timeLen` |
| 112+4K+freqLen | timeLen | u8[] | Time-domain samples (`getByteTimeDomainData`, 128 = silence). |

Rules:

- When `moodValid` is 0, bytes 20–99 encode the documented neutral state
  (valence = 0.5, cosmos weight = 1, clear weight = 1, `intentModeMajor` = -1,
  everything else 0). Mood-blind plugins simply never read the section.
- `freqLen`/`timeLen` are stable for long stretches but MAY change between
  frames (analyser reconfiguration); plugins MUST re-read them each frame or
  tolerate change.
- Reserved/unknown trailing bytes (future minor versions append fields after
  the time array) MUST be ignored. Minor additions never move existing offsets;
  anything that would is `ipp/2`.

A reference decoder is provided as `ipp.h` (C, §Appendix A) and a matching
Rust struct in the host test crate; both are golden-fixture round-trip tested
against the TypeScript encoder.

## 6. Tier A — `wasm-fb` ABI

A single `.wasm` module. **No JavaScript ships with the plugin.**

### 6.1 Required exports

| Export | Signature | Semantics |
| --- | --- | --- |
| `memory` | `WebAssembly.Memory` | Standard exported linear memory. |
| `ipp_abi` | `() -> u32` | MUST return `1`. Checked before anything else. |
| `ipp_init` | `(w: u32, h: u32, dpr: f32, seed: u32) -> i32` | Allocate state. `0` = ok, nonzero = fatal (host falls back). |
| `ipp_block_ptr` | `() -> u32` | Pointer to a plugin-owned buffer the host writes the FrameBlock into. |
| `ipp_block_cap` | `() -> u32` | Capacity of that buffer. If a frame would not fit, the host calls `ipp_block_grow`. |
| `ipp_block_grow` | `(need: u32) -> u32` | Reallocate; return new pointer, or `0` for fatal. |
| `ipp_frame` | `() -> i32` | Render one frame from the current block. `0` = ok, nonzero = fatal. |
| `ipp_pixels` | `() -> u32` | Pointer to the RGBA8 framebuffer, row-major, `w*h*4` bytes, sRGB, straight (non-premultiplied) alpha. Valid until the next `ipp_frame`/`ipp_resize`. |
| `ipp_resize` | `(w: u32, h: u32, dpr: f32) -> i32` | Reallocate the framebuffer. `0` = ok. |
| `ipp_dispose` | `() -> void` | Release state. The instance is dead afterwards. |

### 6.2 Imports

None are required — a Tier A plugin MUST instantiate with an empty import
object. The host additionally offers one OPTIONAL import:

| Import | Signature | Semantics |
| --- | --- | --- |
| `ipp.log` | `(ptr: u32, len: u32) -> void` | UTF-8 debug line. Host rate-limits and truncates. |

Any other import requirement is a load-time failure. This is the tier's
sandbox: no WASI, no clock, no randomness beyond `seed` — determinism is
structural.

### 6.3 Frame loop

Per RAF tick the host: writes the FrameBlock at `ipp_block_ptr()`, calls
`ipp_frame()`, then blits `ipp_pixels()` to the canvas (`putImageData` or
texture upload — host's choice). A WASM trap anywhere is a fatal failure.

## 7. Tier B — `wasm-gl` (Emscripten / raylib)

Tier B plugins ship glue JavaScript and therefore run **inside a sandboxed,
same-origin iframe** that the host creates per instance. Same-origin is
required so the export recorder can reach the plugin's canvas (§9); isolation
comes from the iframe `sandbox` attribute plus a CSP of `default-src 'none'`
with only the plugin's own files allowlisted — network access is denied at the
platform level. The host asks the user for one-time consent before first
loading any Tier B plugin ("this imagery runs third-party code").

### 7.1 The plugin document

The host builds the iframe document; the plugin does not ship HTML. The
document contains exactly one full-viewport `<canvas id="canvas">` and loads
`entry.glue` as an ES module.

### 7.2 Shim entry contract

`entry.glue`'s default export is a function the host-injected bootstrap calls:

```ts
export default function start(env: {
  canvas: HTMLCanvasElement;   // the plugin's render target
  wasmURL: string;             // resolved URL of entry.wasm
  post: (msg: PluginMessage) => void;      // plugin → host
  onMessage: (fn: (msg: HostMessage) => void) => void; // host → plugin
}): void;
```

### 7.3 Message protocol (host ⇄ iframe)

JSON messages over `postMessage`; the FrameBlock rides as a transferable
`ArrayBuffer` in a two-buffer ping-pong (zero steady-state allocation).

| Direction | Message | Payload | Semantics |
| --- | --- | --- | --- |
| host → plugin | `ipp/init` | `{ abi: 1, width, height, dpr, seed }` | Sent once after the document loads. |
| plugin → host | `ipp/ready` | `{}` | MUST arrive within **5000 ms** of `ipp/init`, else load failure. |
| host → plugin | `ipp/frame` | `{ block: ArrayBuffer }` (transferred) | One FrameBlock (§5). At most **one frame in flight**: the host skips RAF ticks while unacknowledged. |
| plugin → host | `ipp/frame-done` | `{ block: ArrayBuffer }` (transferred back) | Acknowledge + return the buffer. |
| host → plugin | `ipp/resize` | `{ width, height, dpr }` | Resize backing store. |
| host → plugin | `ipp/dispose` | `{}` | Tear down; the iframe is removed shortly after. |
| plugin → host | `ipp/fatal` | `{ message: string }` | Self-reported unrecoverable error; host disposes and falls back. |

### 7.4 Emscripten / raylib build convention

The C side implements the same four entry points as Tier A conceptually, but
draws with GL instead of exposing pixels:

```c
#include "ipp.h"          // reference FrameBlock decoder (Appendix A)
#include "raylib.h"

int  ipp_init(int width, int height, float dpr, unsigned seed);
void ipp_frame(const unsigned char *block, int len);  // BeginDrawing…EndDrawing once
void ipp_resize(int width, int height, float dpr);
void ipp_dispose(void);
```

Build flags (raylib `PLATFORM_WEB`):

```sh
emcc main.c libraylib.a -o plugin.js \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createImagery \
  -sEXPORTED_FUNCTIONS=_ipp_init,_ipp_frame,_ipp_resize,_ipp_dispose,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
  -sUSE_GLFW=3 -DPLATFORM_WEB
```

Rules:

- **No main loop.** MUST NOT call `emscripten_set_main_loop` /
  `SetTargetFPS`-driven looping. `ipp_frame` performs exactly one
  `BeginDrawing()`…`EndDrawing()` pass.
- The standard shim (template provided with the host) adapts the Emscripten
  `Module` to §7.3: it copies each incoming block into a `_malloc`'d region of
  `HEAPU8` and calls `_ipp_frame`.
- **No input.** v1 forwards no keyboard/mouse events (observation-only
  corollary). raylib input queries return zeros; plugins MUST NOT depend on
  them.
- `InitWindow(width, height, "")` binds raylib's GLFW backend to the
  `#canvas` element the shim assigns to `Module.canvas`.

## 8. Failure, budget, and watchdog contract

All failure paths end identically: `dispose`, mark the style id failed for the
session, fall back to `bars`, keep playing — byte-for-byte the semantics of the
in-tree `threeFailed` set.

| Condition | Detection | Outcome |
| --- | --- | --- |
| Manifest invalid / unknown ABI major | schema check at scan | never listed |
| Instantiation error / missing export / disallowed import | load | load failure |
| `ipp_init` nonzero, `ipp/ready` timeout (5 s) | load | load failure |
| WASM trap, glue exception, `ipp/fatal` | per frame | fatal |
| Tier B: no `ipp/frame-done` within **500 ms** | watchdog | fatal |
| Sustained overrun: frame cost > **8 ms** average over 120 consecutive frames | budget meter | host MAY fail the plugin; conformant plugins stay well under |

Plugins SHOULD degrade gracefully under load (draw less) rather than skip the
acknowledge.

## 9. Recording and export

The visualizer video export captures the **active canvas element** with
`captureStream`/`drawImage` plus the playback audio tap. Consequences:

- Tier A renders into a host-owned canvas — captured automatically.
- Tier B's canvas lives in a same-origin iframe; the host reaches in and
  captures it directly. This is why Tier B MUST be same-origin (§7) — an
  opaque-origin iframe would make exports black.
- Everything the plugin wants in the recording must be painted on its canvas;
  DOM overlays are not captured (and Tier B documents contain no DOM beyond
  the canvas anyway).

## 10. Versioning

- `ipp/1` is this document. The FrameBlock magic, manifest `abi` field, and
  `ipp_abi()` export MUST agree.
- Minor (backward-compatible) evolution: new manifest fields (ignorable), new
  FrameBlock fields appended after the time array, new OPTIONAL imports or
  messages. Plugins MUST ignore what they don't know.
- Anything that moves an offset, changes a signature, or adds a required
  callback is `ipp/2`. The host MAY support multiple majors side by side.

## 11. Conformance

A plugin is conformant when:

1. Its manifest validates against the published JSON schema.
2. It loads and runs against the host conformance harness (planned:
   `npm run ipp:conformance -- <plugin-dir>`), which replays recorded
   FrameBlock fixtures — silence, steady groove, crescendo, mood sweeps — and
   asserts: no traps, all frames acknowledged inside budget, no disallowed
   imports (Tier A), no network attempts (Tier B), deterministic output for a
   fixed seed (Tier A: pixel-identical golden frames).
3. It survives the lifecycle torture sequence: init → 300 frames → resize ×3 →
   300 frames → dispose → re-init with a different seed.
4. Reduced-motion frames produce measurably less inter-frame pixel delta
   (Tier A, machine-checked) or visibly calmer motion (Tier B, human-checked).

Host-side, the protocol itself is pinned by: encoder/decoder round-trip tests
(TS ↔ C/Rust reference), a `conformance.wasm` fixture that checksums received
frames, a trap-on-frame-N fixture asserting bars fallback with playback alive,
and fake-timer watchdog tests — recorded fixtures only, no live audio, per the
project verification doctrine.

---

## Appendix A — reference C header (`ipp.h`, informative)

```c
/* IPP v1 FrameBlock reader — little-endian hosts. */
#include <stdint.h>
#include <string.h>

typedef struct {
  uint32_t flags;              /* bit0 reducedMotion, bit1 moodValid */
  float    position_fraction;  /* 0..1 */
  float    dt, elapsed;        /* seconds */
  float    arousal, valence, tension, pulse;
  float    build_up, swell, wind;
  float    intent_mode_major;  /* 0..1, or -1 = undeclared */
  float    worlds[5];          /* cosmos, starlight, ocean, meadow, city */
  uint32_t dominant_world;
  float    weather[5];         /* clear, mist, rain, snow, storm */
  uint32_t weather_mode;
  uint32_t option_count;
  const float   *options;      /* option_count values, manifest order */
  uint32_t freq_len;
  const uint8_t *freq;
  uint32_t time_len;
  const uint8_t *time;
} ipp_frame_view;

#define IPP_MAGIC 0x31505049u /* "IPP1" */

static inline int ipp_parse(const uint8_t *p, uint32_t len, ipp_frame_view *v) {
  if (len < 108 || ((const uint32_t *)p)[0] != IPP_MAGIC) return -1;
  memcpy(&v->flags, p + 4, 4);
  memcpy(&v->position_fraction, p + 8, 11 * 4); /* through intent_mode_major */
  memcpy(v->worlds, p + 52, 20);
  memcpy(&v->dominant_world, p + 72, 4);
  memcpy(v->weather, p + 76, 20);
  memcpy(&v->weather_mode, p + 96, 4);
  memcpy(&v->option_count, p + 100, 4);
  v->options = (const float *)(p + 104);
  uint32_t off = 104 + v->option_count * 4;
  if (off + 4 > len) return -1;
  memcpy(&v->freq_len, p + off, 4);
  v->freq = p + off + 4;
  off += 4 + v->freq_len;
  if (off + 4 > len) return -1;
  memcpy(&v->time_len, p + off, 4);
  v->time = p + off + 4;
  return (off + 4 + v->time_len <= len) ? 0 : -1;
}
```
