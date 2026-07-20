# 情绪 · Mood — showcase demo

A self-contained tour of the mood spectrum scene. A scripted synthetic
spectrum ("the journey") walks through all five worlds — 宇宙 cosmos →
星空 starlight → 大海 ocean → 草原 meadow → 城市 city — and back, exercising
every resonance channel:

- spectrum-carved terrain (each ground column rides its frequency band)
- bass-impact ripple rings expanding across the ground
- the instanced skyline as a squared-response equalizer
- meteors answering bass hits under open skies
- nebula surges, star flares, and the breathing first-person camera
- theme-hue driven palettes (press `T` to cycle hues)

No audio files, no microphone permission: the spectrum is synthesized per
frame, so the whole demo is deterministic and runs in any browser.

## Run

```sh
npm run demo:mood
# open http://127.0.0.1:5175/
```

## Keys

| Key     | Action                        |
| ------- | ----------------------------- |
| `1`-`6` | Jump to a scene               |
| `Space` | Pause / resume                |
| `T`     | Cycle theme hue               |
| `R`     | Restart the journey           |

The HUD shows the live world weights from a parallel `MoodEngine` fed the
same synthetic spectrum, plus the smoothed energy / bass / impact signals.
`main.js` is an esbuild artifact served from memory — it is not committed.
