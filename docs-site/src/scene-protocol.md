# The ScoreKit Scene Protocol

A scene file is the protocol between the Agent and the ScoreKit compiler. It is strict UTF-8 YAML: unknown fields are errors, ranges and cross-field rules are validated, and misspelled fields are never ignored silently.

The machine-readable source of truth is always the schema exported by the installed ScoreKit binary:

```bash
scorekit schema
scorekit --json validate scene.yaml
```

If this guide or an example disagrees with your local binary, `scorekit schema` wins.

## A minimal but complete scene

```yaml
title: Forest at Dusk
story: Nighttime forest exploration: safe, restrained, with a hint of mystery.
tempo: 92
key: D_minor
time_signature: "4/4"
bars: 8
loop: true

harmony: [i, iv, VI, v]

performance:
  humanize: { timing_ms: 12, velocity: 8, seed: 7 }
  legato: true
  dynamics: { start: p, peak: mf }

motifs:
  forest_call:
    - { degree: 5, beats: 1 }
    - { degree: 8, beats: 1 }
    - { degree: 7, beats: 2 }
    - { degree: 0, beats: 4 }

tracks:
  - id: lead
    instrument: flute
    pattern: melody
    motif: forest_call
    intensity: 0.45
  - id: harmony
    instrument: slow_strings
    pattern: sustain
    intensity: 0.35
  - id: motion
    instrument: harp
    pattern: arpeggio
    intensity: 0.3
  - id: foundation
    instrument: bass
    pattern: bass
    intensity: 0.3
```

`story` preserves narrative intent for people and review agents and is copied into `meta.json`. It never changes the notes or the rendered audio.

## Top-level fields

| Field | Musical meaning | Important constraints |
| --- | --- | --- |
| `title` | Human-readable title | Optional; does not affect output |
| `story` | Theme, mood, and dramatic intent | Optional; informational only |
| `tempo` | Beats per minute | Required; 20–300 |
| `key` | Tonic and major/minor scale | For example `C_major` or `F#_minor`; default `C_major` |
| `time_signature` | Meter | For example `4/4`, `3/4`, or `6/8`; default `4/4` |
| `bars` | Scene length in bars | Required; 1–256 |
| `loop` | Whether the output is a seamless loop | Default `false` |
| `harmony` | One Roman-numeral chord per bar | Cycles until the scene ends |
| `motifs` | Named melodic material | Referenced by `melody` tracks |
| `clips` | Stable-ID exact pitched/percussion events and automation | Referenced by `clip` tracks; map order is inert |
| `performance` | Swing, legato, dynamics, and deterministic humanization | Optional |
| `tracks` | Instrument tracks | 1–16; at most 15 melodic tracks, while percussion tracks share channel 10 |
| `textures` | Scheduled ambience, field recordings, and sound effects | Optional; portable source names are resolved by a separate texture profile |
| `sections` | Named cues that share the scene's material | Optional; build emits one output per section |

ScoreKit currently builds diatonic triads from the scene scale. Roman-numeral case is conventional: `VI` and `vi` select the same scale degree in the current protocol. This field is not a complete classical-harmony notation system.

## Tracks and the seven patterns

Every track selects an `instrument` and a `pattern`, and carries a stable scene-local `id`:

| Pattern | Generated material | Typical role |
| --- | --- | --- |
| `melody` | Repeats or truncates a named `motif` | Theme, counterline, phrase, or timed entrance with rests |
| `sustain` | Holds the full chord for each bar | Pads, string beds, and harmonic background |
| `arpeggio` | Eighth notes in root–third–fifth–third order | Motion, piano or harp figures |
| `bass` | Low roots derived from the current chord | Low-frequency foundation |
| `drums` | A fixed kick, snare, and hi-hat groove | Basic pulse; must use `instrument: drums` |
| `clip` | Plays a named exact event sequence | Authored syncopation, fills, auxiliary percussion, and controller motion |
| `tabla` | A deterministic tabla groove | World-percussion pulse; must use `instrument: tabla` |

Tracks can also define:

- `id`: a stable identifier matching `[a-z][a-z0-9_-]{0,63}`. Required; referenced by section `mute` lists, stems, and MIDI's `--solo` selector — never a positional index, so reordering tracks never breaks a reference.
- `palette`: an optional logical orchestration palette name. Absent uses the active orchestration's `default_palette`; irrelevant when not building with `--renderer sfizz --orchestration ...`. Routing metadata only — it never changes compiled MIDI.
- `intensity`: velocity scaling from 0.0 to 1.0.
- `articulation`: `sustain`, `staccato`, `spiccato`, `pizzicato`, `tremolo`, or `mute`. It selects SFZ samples only; SF2 backends ignore it.
- `clip`: required only for `pattern: clip`; names a compatible root clip.
- `pan`: 0.0 hard left, 0.5 center, 1.0 hard right, compiled to MIDI CC10.
- `reverb`: a 0.0–1.0 MIDI CC91 send. An SFZ patch responds only if it maps the controller.
- `glide`: on `melody` tracks only, the fraction of each note tail that bends toward the next pitch.

Several `drums` or `tabla` tracks may share channel 10 while keeping independent MIDI tracks and stems. Shared-channel `pan` and `reverb` values must agree. ScoreKit 0.7 also exposes exact General MIDI `clavinet` and `synth_brass` identities.

## Exact event clips and automation

Clip, event, lane, and point keys are stable semantic IDs. Reordering them does not change MIDI or semantic diffs:

```yaml
clips:
  filtered_stab:
    kind: pitched
    length_beats: 4
    mode: loop
    events:
      stab_1: { at: 0.5, duration: 0.25, pitch: C4, velocity: 104 }
      stab_2: { at: 2.5, duration: 0.25, pitch: Eb4, velocity: 98 }
    automation:
      filter:
        target: cc74
        interpolation: linear
        points:
          closed: { at: 0, value: 16 }
          open: { at: 2, value: 112 }
          seal: { at: 3.75, value: 16 }
tracks:
  - { id: stab, instrument: synth_brass, pattern: clip, clip: filtered_stab }
```

Clips are `pitched` or `percussion`, and play `once` or `loop`. Pitched events use scientific pitch plus duration; percussion events use ScoreKit's frozen General MIDI voice enum. Automation targets are `cc1`, `cc11`, `cc74`, and `pitch_bend`; interpolation is `step` by default or deterministic `linear` on a fixed 60-tick grid.

Loop clips must divide every active scene or section. Events stay inside the clip boundary, and loop automation must return to its initial value. Clip timing ignores swing, legato, and humanization, while track/section intensity and dynamics still scale velocity. For sfizz, the effective leaf profile must declare every active control, and `scorekit profile check` must certify that the patch responds.

## Motifs and scale degrees

A motif is a list of `{ degree, beats }` entries:

- `degree: 1` is the tonic in the current key.
- `degree: 8` is the tonic one octave higher.
- `degree: 0` is a rest.
- Negative degrees extend below the reference register.
- `beats` is measured in quarter-note beats and ranges from 0.125 to 16.

A melody repeats or truncates its motif to fill the scene or section exactly. Split a rest longer than 16 beats into multiple entries.

## Sound textures

ScoreKit provides deterministic non-instrument layers:

```yaml
textures:
  - source: river
    mode: loop
    start_beat: 0
    gain: 0.25
  - source: birds
    mode: one_shot
    at: [4, 20]
    gain: 0.5
```

`loop` repeats one source from `start_beat`; `one_shot` triggers it at each quarter-note beat in `at`. `gain` is a linear multiplier from 0 to 1. Source names are portable keys, never file paths. Bind them in a texture-profile YAML selected from scorebench's Render panel:

```yaml
name: forest-recordings
root: recordings
schema_version: 1
sources:
  river:
    path: river.flac
    description: Steady close river
    category: organic
    tags: [water, flowing]
    playback:
      modes: [loop]
      default_mode: loop
    use_cases: [forest]
    provenance:
      library: field-recordings@1.0.0
```

ScoreKit 0.7 retains the old path-only binding for build compatibility, but discovery and certification require the structured form. The Agent queries the active profile with exact `inspect_textures` filters before choosing a source; `no_match` means it must change the plan, not invent a key. The observation panel reports missing mappings and a `loop`/`one_shot` mode not declared by the source before build. ScoreKit still performs authoritative validation and mixing. Enabling stems produces aligned texture stems alongside instrument stems.

## Performance

```yaml
performance:
  swing: 0.10
  legato: true
  humanize:
    timing_ms: 14
    velocity: 8
    seed: 42
  dynamics:
    start: p
    peak: f
```

- `swing` delays offbeat eighth notes and ranges from 0.0 to 0.5.
- `legato` slightly extends non-drum notes so adjacent notes overlap.
- `humanize` varies onset and velocity using a fixed seed, so the result is reproducible.
- `dynamics` uses `pp p mp mf f ff`, rises from `start` to `peak` at the midpoint, then returns to `start` for a loop-safe arc.

## Sections: related cues that share material

```yaml
sections:
  - { name: intro, bars: 4, loop: false, mute: [motion, foundation], intensity: 0.7 }
  - { name: explore, bars: 8, loop: true, mute: [foundation], intensity: 0.9 }
  - { name: combat, bars: 8, loop: true, intensity: 1.25, tempo: 108 }
  - { name: victory, bars: 4, loop: false, mute: [foundation], intensity: 1.1 }
```

A section can change `bars`, `tempo`, `loop`, and overall `intensity`, silence tracks through the **stable track `id`s** listed in `mute`, or replace a clip track with `clips: { track_id: clip_id }`. Sections inherit the top-level key, harmony, motifs, clips, tracks, and performance. The current protocol cannot replace harmony or motif contents per section.

## What does not belong in the scene protocol

- SoundFont, SFZ, renderer, orchestration, and recording paths. They belong in build parameters, orchestration/renderer profiles, or texture profiles; scene textures use portable source keys.
- Arbitrary `mood`, `danger`, or `avoid` fields without compile semantics. Keep them in the conversation or `story`.
- Plugin chains, mastering, equalization, or post-processing instructions.
- Renderer-specific synth parameters, arbitrary MIDI outside the exact-clip protocol, or free-form per-note articulation.

For the complete current field ranges and instrument enum, run `scorekit schema` instead of copying an old list, or consult the [ScoreKit Scene Protocol](https://talkincode.github.io/scorekit/scene-protocol.html).
