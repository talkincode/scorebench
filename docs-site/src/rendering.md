# Rendering Pipeline and Backends

scorebench does not generate or process audio in its own process. It passes build parameters to ScoreKit, which invokes external renderers and FFmpeg:

```text
scene.yaml
   │ validate + deterministic compile
   ▼
MIDI
   │
   ├── FluidSynth + SF2
   ├── TiMidity++  + SF2
   └── sfizz_render + SFZ profile
            │
            ▼
         raw audio
            │ loop seal / tail / export
            ▼
 OGG or WAV + meta.json + optional stems
```

ScoreKit launches the tools, checks their results, and writes artifacts atomically. scorebench reads the finished files and uses WebAudio only for playback, spectrum analysis, and visualization.

## Three rendering backends

| Backend | Sound-source input | Best for | Important limitation |
| --- | --- | --- | --- |
| `fluidsynth` | One GM-compatible SF2 | Default sketches, fast iteration, easy setup | Every instrument comes from one SoundFont; `articulation` has no effect |
| `timidity` | One GM-compatible SF2 | An alternate SF2 path or cross-check | Mixing and controller response can differ; `articulation` has no effect |
| `sfizz` | SFZ files plus a renderer profile | Detailed sample libraries and multiple articulations | Requires a profile and a mapping for every scene instrument |

FluidSynth is the default. Switch to sfizz only when the musical structure is stable and you are ready to manage sample libraries, file paths, compatibility, and licensing.

## Render-panel controls

| Control | Meaning | Guidance |
| --- | --- | --- |
| Renderer | The MIDI-to-PCM synthesis backend | Start with FluidSynth; sfizz requires a profile |
| Sample rate | 44,100 or 48,000 samples per second | 44.1 kHz is common for music; 48 kHz is common in video and some game pipelines |
| Format | `OGG` or `WAV` | OGG is compact; WAV is lossless and better for later production |
| Gain | Overall renderer amplitude, from 0 to 2 in the UI | Start at 0.8; reduce clipping here, but do not use gain to fix arrangement balance |
| Quality | Vorbis quality from 0 to 10 | Primarily affects OGG size and encoding quality; default 5 |
| Stems | Render every track as aligned audio | Enable for adaptive playback or downstream mixing |
| SFZ profile | Maps instruments and articulations to `.sfz` files | Used only by sfizz; missing mappings fail the build |

The renderer and SFZ profile are stored in the project's `bench.json`, allowing the Agent to check instrument compatibility while writing a scene. The other controls are immediate Render-panel choices.

## Output files

A single `forest.yaml` scene typically produces:

```text
out/
├── forest.ogg
├── forest.meta.json
└── forest.stems/
    ├── 01-flute.ogg
    ├── 02-slow_strings.ogg
    └── ...
```

`meta.json` is the machine-readable build result. It records the sample rate, total samples, loop range, audio asset, stems, and related metadata. scorebench uses this file to determine build success rather than parsing human-oriented ScoreKit stdout.

A suite with `sections` emits separate audio assets per section. Every stem is sample-aligned with the corresponding full mix so a game can add or remove layers at runtime. Stems are not independently mastered songs.

## Determinism boundary

- The same scene, ScoreKit version, and humanize seed produce the same MIDI.
- Audio also depends on the renderer, SoundFont or SFZ files, FFmpeg, sample rate, and external tool versions. Pin the complete toolchain and file checksums when byte-level audio identity matters.
- Changing the sound source preserves note structure but can change envelope, loudness, spectrum, space, and articulation dramatically. Listen again after every source change.
- scorebench does not add limiting, EQ, loudness normalization, or mastering after ScoreKit renders the file.

## A simple backend decision

1. Still changing melody, harmony, or form? Use FluidSynth.
2. Want to compare a second SF2 renderer? Try TiMidity++.
3. Need detailed samples or multiple articulations? Prepare and certify an SFZ profile, then use sfizz.
4. Need commercial plugins, a DAW effect chain, or mastering? Export WAV or stems and continue in an external production workflow.
