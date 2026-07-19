# Meet scorebench

scorebench is an agent-native desktop workbench for [ScoreKit](https://github.com/talkincode/scorekit). You describe the music in natural language, the Agent turns that intent into a ScoreKit scene YAML file, and ScoreKit compiles and renders the YAML into playable, shippable audio.

```text
Your brief
   │
   ▼
scorebench Agent ──writes──► scene.yaml
                                │
                                ▼
                           ScoreKit CLI
                                │
                      MIDI + renderer + FFmpeg
                                │
                                ▼
                    OGG/WAV + meta.json + stems
                                │
                                ▼
                  scorebench playback and spectrum
```

## Three distinct roles

| Component | What it does | What it does not do |
| --- | --- | --- |
| scorebench | Hosts the conversation, project files, Agent tool calls, read-only observation, playback, and spectrum views | It does not synthesize or mix audio, and it is not a piano-roll editor |
| Agent | Interprets the brief, arranges the music, writes scene YAML, and iterates on validation feedback | It does not bypass ScoreKit to generate audio directly |
| ScoreKit | Validates scenes, compiles deterministic MIDI, invokes renderers, and exports audio and metadata | It does not interpret natural language or decide what the piece should express |

The short version is: **the Agent composes, ScoreKit compiles, and scorebench hosts the workflow.**

## Good fits

- Seamless game-music loops and related exploration, combat, or victory cues.
- Instrumental sketches for narrative or film-style scoring.
- Layered scores whose stems can be added or removed dynamically in a game engine.
- Projects that keep musical descriptions, scene files, and outputs under Git.
- Natural-language iteration with reproducible, inspectable build results.

## Boundaries to understand first

- scorebench is not a DAW. It has no piano roll, timeline, or plugin chain.
- Scene YAML is an executable musical description, not an arbitrary prose container. Every field must match the live ScoreKit schema.
- The same scene produces stable MIDI. Final timbre still depends on the renderer, sound files, and external tool versions.
- ScoreKit and its sound sources are external dependencies. scorebench does not bundle ScoreKit, SoundFonts, or SFZ sample libraries into a project.
- The Review panel evaluates scene data, schema, validation results, semantic diffs, and render metadata. It has not listened to the audio; a human must still judge the sound.

If this is your first session, continue with [Quick Start](getting-started.md). If you can already render but need help translating musical intent into scene fields, go to [From Protocol to Arrangement](arrangement-basics.md).
