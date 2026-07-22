# 航线 · Voyage — showcase demo

A self-contained flight log for the voyage spectrum scene. A scripted
synthetic spectrum walks a digital dreadnought through six legs —
静航 silent running → 加速 throttle up → 陨石带 the belt → 蓄力 ignition →
离子风暴 ion storm → 归航 home stretch — exercising every channel:

- an opaque neutral weathered gun-gray hull (`#4B5153`, shadow structure
  `#252B2E`, repair plates `#62676A`) with object-space triplanar coating,
  exposed steel chips, seam-bound dark-brown/iron-red rust, cavity dust and
  micro-normal breakup; cyan comes only from environment, engine bounce and
  energy lines, while line layers and Bloom can both be disabled to prove
  that the armor remains readable on its own
- a broken superstructure: four staggered citadel blocks with sparse
  bridge windows, 8 armor bays per flank (two plates missing — a wound),
  ventral pods on pylons, a maintenance platform, comms masts and
  antenna arrays
- a five-engine cluster — deep double-ring gunmetal nozzles with backlit
  twelve-vane louver grilles around a machined hub, compact cyan-white cores,
  parallel analytical jets with
  axial gradients and radial falloff, and a restrained 1.7× deep-blue envelope
  carrying bright deterministic edge sparks; there is no point-cloud fog,
  colored nozzle noise, shock ring or animated radius change
- an energy pulse system: beats launch packets at the stern that travel
  the conduits toward the bow, flashing each armor bay they pass; at
  climax the bays chain-link one after another instead of the whole
  ship brightening at once
- scale dressing: uneven porthole rows (22% dark), grille runs, spine
  crawler lights, maintenance pads with coral lamps, a distant dark
  planet and two far traffic lights
- three maintenance drones on a staged program (docked → inspect →
  orbit → flyby → return) with transition-flash trails
- four depth cues sharing one travel vector: three far-star populations plus
  localized clusters, two slow FBM nebula depths cut by normal-blended dark
  molecular lanes, a rim-lit dark planet, and sparse near dust with strong
  parallax
- layer-masked bloom limited to engine cores, energy conduits, windows,
  selected stars and drone trails; armor, seams and ordinary stars remain
  outside the bloom pass
- four continuous ship states (dormant / cruise / charged / transcend)
  cross-faded from smoothed energy trends and a loudness gate — silence
  strips the ship to outline, engine embers and a few window lights;
  transcend de-rezzes the hull into particles
- every band owns one duty: bass → jet length (±20%), overall energy → core
  brightness (±15%), beat → a 100 ms brightness pulse, low-mid → conduit pulses,
  mid → structure reveal, high-mid → drones + bridge glass, treble →
  porthole sparks, beat → silhouette lift + pulse launch

No audio files, no microphone permission: the spectrum is synthesized per
frame, so the whole demo is deterministic and runs in any browser.

## Run

```sh
npm run demo:voyage
# open http://127.0.0.1:5176/
```

Deterministic acceptance captures can use `?scene=1..6&hold=1&at=0..1&freeze=1`.
Append `&wire=0` to disable all ship line layers, or `&safe=1` to display the
top-left, bottom and close-button exclusion zones. Append `&bloom=0` to verify
the armor and background without post-process glow. Append `&material=1` for
the neutral-white-light gunmetal material plate (effects and most background
layers suppressed). `&bg=<seconds>` pins the procedural background clock for
deterministic motion comparisons. The safe-area overlay is off by default.

## Keys

| Key     | Action                          |
| ------- | ------------------------------- |
| `1`-`6` | Jump to a leg                   |
| `Space` | Pause / resume                  |
| `T`     | Cycle theme hue                 |
| `I`     | Cycle declared intent           |
| `R`     | Restart the journey             |

The helm readout computes `cruiseSpeed(mood, impact)` from the same pure
model the scene consumes, next to the live weather mode and the smoothed
energy / bass / impact signals. `main.js` is an esbuild artifact served
from memory — it is not committed.
