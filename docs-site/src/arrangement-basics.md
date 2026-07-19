# From Protocol to Arrangement

A valid scene is merely compilable. Giving it direction, depth, and a memorable identity requires deliberate assignment of musical roles to the structures ScoreKit can express.

## Start with five roles

| Arrangement role | Common protocol mapping | What to control |
| --- | --- | --- |
| Theme or melody | `pattern: melody` + `motif` | Contour, rhythm, rests, register, and repetition |
| Harmonic bed | `sustain` | Progression, weight, intensity, and perceived distance |
| Moving texture | `arpeggio` | Pulse, brightness, and density |
| Low foundation | `bass` | Stability without unnecessary low-frequency doubling |
| Rhythmic frame | `drums` | Whether the scene needs an explicit beat at all |

Give each track a clear job first. Several similar instruments all using `sustain` usually create thickness and masking, not automatically “more layers.”

## Build identity with a motif

A motif does not need to be long. Four to six recognizable scale degrees with a deliberate rhythm are often more memorable than a stream of unrelated melodies.

Ways to develop the same motif include:

- Move the contour up or down an octave.
- Change durations while keeping important arrival points.
- Let another instrument answer it.
- Insert `degree: 0` rests between statements.
- Preserve it in combat while changing intensity and instrumentation.

ScoreKit repeats a `melody` motif until the target length is filled. Design rests at the end of a short motif or it may sound like a phrase that never breathes.

## Use harmony to create direction

`harmony` supplies one diatonic triad per bar and cycles to the end. Ask two questions:

1. Does the final bar lead naturally back to the first? This matters especially for loops.
2. Is one chord per bar the right harmonic rhythm? That is the protocol's fixed resolution; it cannot change chords halfway through a bar.

In minor, `i, VI, III, VII` often forms a stable cycle, while `i, iv, VI, v` can create a stronger pull back toward the start. Treat these as starting points, not emotion formulas, and judge them with the melody and orchestration.

## Density matters more than making everything louder

Build an emotional arc with three independent controls:

- **Voice count:** section `mute` controls which tracks enter.
- **Relative weight:** track `intensity` sets role balance, while section `intensity` scales the complete cue.
- **Register and color:** choose high, mid, or low instruments and brighter or softer timbres.

An exploration-to-combat transition might mute drums and brass during exploration, then restore them and raise tempo and intensity for combat while preserving the same motif. The energy changes without losing identity.

The `sustain`, `arpeggio`, `bass`, and `drums` patterns fill the entire scene or section. For a mid-section entrance or exit, use a `melody` track with rests, or split the form into sections.

## Stereo and depth

- `pan` places a track left or right. Keep a primary melody near the center and separate complementary textures modestly.
- `reverb` is a send value, not a guaranteed built-in acoustic space. Different renderers and sources may respond differently to CC91.
- Lowering background `intensity` is often more natural than pushing the lead to maximum velocity.
- Too many low instruments can mask each other even when none is loud. Choose one clear low-frequency anchor.

## Mechanical feel and humanization

Fix phrasing, rhythm, and density before adding humanization. Random offsets cannot repair a phrase with no breathing room.

A restrained starting point is:

```yaml
performance:
  humanize: { timing_ms: 10, velocity: 6, seed: 17 }
  legato: true
  dynamics: { start: mp, peak: f }
```

- Excessive timing variation weakens rhythmic clarity.
- Excessive velocity variation destabilizes role balance.
- Keep the seed fixed so revisions are reproducible and comparable.
- Use swing only when the groove calls for it; it is not a universal “human” switch.
- Protocol `legato` overlaps durations. It does not select a sample library's scripted legato patch.

## Loops and one-shot cues

### Seamless loops

- Set `loop: true`.
- Let the final harmony want to return to the opening.
- Avoid high-energy material that appears only at the end and vanishes at the loop point.
- `dynamics` returns to its start level, but orchestration and harmony still need a musical loop design.
- Inspect loop sample metadata and listen through several consecutive passes.

### One-shot cues

- Set `loop: false`.
- Allow the final harmony and melody to resolve clearly.
- ScoreKit preserves a decay tail, which suits intros, transitions, and victory stings.

## Example: translating a brief into fields

Brief: “Oppressive underground-ruin exploration with an occasional distant echo. Combat should tighten the rhythm without losing the theme.”

| Brief element | Executable choice |
| --- | --- |
| Oppressive | Minor key, low-to-medium tempo, sparse motif, and substantial rests |
| Underground ruins | Sustained low strings, restrained color, and more background reverb after checking backend response |
| Distant echo | A second low-intensity melody, offset pan, and rests that create call and response |
| Exploration | A section with drums muted and lower overall intensity |
| Combat | Restore drums, raise tempo and intensity, and retain the motif |
| Continuous identity | Share motifs and harmony across sections and pass the same material between instruments |

If a brief requires a capability the protocol does not have—such as independent harmony per section, arbitrary automation curves, or free per-note articulation—state the limitation instead of adding imaginary YAML fields.
