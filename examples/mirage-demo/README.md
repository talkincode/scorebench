# 蜃景 · Mirage — showcase demo

A deterministic listening session for one cinematic particle world:

- an opaque, softly textured rotating planet with a restrained cool rim
- a near-edge-on copper-gold particle volume with no line primitives
- continuously travelling blue-violet streams and independently twinkling stars
- a dense gold particle landscape deformed by the live spectrum
- a foreground mesh interceptor with reactive engines and particle trails

Six scripted acts walk the emotion axes across their range (still water →
crossing → dry strain → city → high air → storm). The world remains
recognizable throughout; music changes its energy, relief, light and camera
rather than swapping literal pictograms:

- analyser bands drive local terrain relief and brightness
- bass breathes through the landscape and engine volume
- impacts launch a forward ridge and a 420ms pulse along the fixed ring
- strong impacts release a soft 1.2s shockwave from the planet rim
- the planet surface and particle skin turn at distinct slow rates
- blue orbital particles travel continuously instead of reading as a static arc
- stars twinkle on seeded, asynchronous 2.5–11 second cycles
- the interceptor nudges forward on a hit; its engine flare follows 75ms later
- tail length follows bass and total energy while width stays fixed
- 36 near-camera dust motes add restrained parallax and ring-local lighting
- V-A-T and build-up shape a 1–3° section angle and luminance, while the
  full-track camera push remains under one world unit
- the shared in-canvas mood HUD stays recording-safe and read-only

The palette is intentionally bounded to two families: copper/gold for the
planetary surface and ring, blue/violet for sky, orbital energy and engines.
No audio files or microphone permission are needed; the demo synthesizes its
spectrum per frame, so it is deterministic in any browser.

## Run

```sh
npm run demo:mirage
# open http://127.0.0.1:5178/
```

Deep link an act with `?act=1..6`.

## Keys

| Key     | Action          |
| ------- | --------------- |
| `1`-`6` | Jump to an act  |
| `Space` | Pause / resume  |
| `T`     | Cycle theme hue |
| `R`     | Restart         |

`main.js` is an ignored esbuild artifact; it is not committed.
