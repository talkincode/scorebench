# Glossary

## Product and protocol

| Term | Meaning |
| --- | --- |
| Agent | The model-driven component that interprets goals, invokes tools, and edits scenes. |
| Scene | A compilable YAML music description, optionally containing related sections. |
| DSL | Domain-specific language; here, the ScoreKit scene YAML format. |
| Schema | The machine-readable definition of fields, types, ranges, and rules exported by `scorekit schema`. |
| Deterministic | The same input and fixed versions produce the same result; humanization stays reproducible through its seed. |
| Semantic diff | A comparison of musical meaning rather than whitespace or formatting. |
| `story` | Narrative intent stored in metadata and review context; it does not generate notes. |
| StylePack | A structured scorebench package of creative preferences and review criteria for the Agent. |
| Grammar | ScoreKit's measurable aesthetic constraints, distinct from renderer configuration. |

## Musical structure

| Term | Meaning |
| --- | --- |
| BPM / tempo | Beats per minute; larger values generally mean faster music. |
| Beat | The duration unit used by motif `beats`, measured as a quarter-note beat. |
| Bar | A group of beats determined by the time signature; `bars` controls scene length. |
| Time signature | Meter such as 4/4, 3/4, or 6/8. |
| Key | A tonic plus major or minor scale, such as `D_minor`. |
| Scale degree | A note's position in the current scale; 1 is tonic, 8 is the upper tonic, and 0 is a rest. |
| Motif | A short, recognizable melodic or rhythmic idea. |
| Harmony | The relationship of chords over time; ScoreKit currently uses one diatonic triad per bar. |
| Roman numeral | I–VII notation for a chord's scale degree; current ScoreKit ignores case when selecting the degree. |
| Pattern | ScoreKit's note generator: melody, sustain, arpeggio, bass, or drums. |
| Arrangement | Assigning melody, harmony, bass, rhythm, color, and form to instruments. |
| Texture | How simultaneous voices are organized, from sparse solo writing to dense layers. |
| Register | Whether material sits in a low, middle, or high pitch range. |
| Section | A named suite cue that can change length, tempo, looping, overall intensity, and muted tracks. |

## Performance and space

| Term | Meaning |
| --- | --- |
| Intensity | Track velocity scaling; section intensity multiplies the complete cue. |
| Dynamics | Conventional levels from pp to ff; ScoreKit can create a midpoint dynamic arc. |
| Articulation | A playing style such as sustain, staccato, or pizzicato; currently used only for SFZ sample selection. |
| Legato | Connected or overlapping notes; protocol legato is not a sample library's scripted legato instrument. |
| Swing | Delaying offbeat eighth notes to create an uneven subdivision. |
| Humanize | Small seeded onset and velocity variations. |
| Glide | Pitch bend at the tail of one melody note toward the next. |
| Pan | Left/right placement, compiled as MIDI CC10. |
| Reverb send | A controller value sent as MIDI CC91; actual response depends on the renderer and sound source. |

## Rendering and sound sources

| Term | Meaning |
| --- | --- |
| MIDI | Performance events such as pitch, duration, velocity, program, and controllers; it contains no recorded sound. |
| Renderer | Software that converts MIDI plus a sound source into PCM audio, such as FluidSynth, TiMidity++, or sfizz. |
| SoundFont / SF2 | A file that packages samples and mappings for multiple, often GM-compatible, instruments. |
| SFZ | A text instrument format that maps external WAV or FLAC samples. |
| Renderer profile | YAML that maps ScoreKit instruments and articulations to local SFZ files. |
| General MIDI / GM | Standard program and drum-channel conventions used to map scene instruments into compatible SoundFonts. |
| Sample | A digital recording used by a sampled instrument. |
| Sample rate | Audio samples per second, commonly 44,100 or 48,000 Hz. |
| Gain | Overall render amplitude; it is not loudness normalization or mastering. |
| OGG | Lossy Vorbis-compressed audio with relatively small files. |
| WAV | Usually uncompressed PCM audio, suitable for lossless storage and downstream production. |
| Stem | A sample-aligned render of one track for adaptive mixing or post-production. |
| `meta.json` | Machine-readable build metadata containing sample counts, loop points, stems, and other artifact data. |
| Loop | An asset whose end returns to its beginning; ScoreKit seals length and the audio seam. |
| One-shot | A cue that plays once and ends, usually with a decay tail. |
| Tail | Reverb or instrument decay preserved after the body of a one-shot cue. |
