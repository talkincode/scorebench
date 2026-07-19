# Quick Start

This chapter takes the shortest path through the complete loop: install the dependencies, open a project directory, ask the Agent for a scene, render it, and listen.

## 1. Install scorebench and ScoreKit

Download the installer for your system from [scorebench Releases](https://github.com/talkincode/scorebench/releases). scorebench also needs a separate ScoreKit installation; the CLI is not bundled with the desktop application.

On macOS with Homebrew:

```bash
brew install --cask talkincode/tap/scorebench
scorekit doctor
```

The cask installs the `talkincode/tap/scorekit` formula as a dependency. Linux users can install scorebench from the release artifacts and ScoreKit with `brew install talkincode/tap/scorekit` or from [ScoreKit Releases](https://github.com/talkincode/scorekit/releases). `scorekit doctor` should confirm that FFmpeg and at least one renderer are available and report the state of the default SoundFont.

> If scorebench cannot locate the command, set `SCOREBENCH_SCOREKIT` to the absolute path of the ScoreKit executable. GUI applications on macOS often receive a shorter `PATH` than terminal shells, so a command can work in Terminal and still be invisible to the app.

## 2. Create a project directory

Create an ordinary directory and open it in scorebench. One window owns one project directory; opening another directory is how you switch projects.

```text
my-score/
├── scene.yaml          # Created and edited by the Agent
├── bench.json          # Renderer, StylePack, and other project choices
├── sessions/           # Conversations and Agent memory
└── out/                # Rendered artifacts
```

The directory may already be a Git repository, or it can start empty. scorebench does not initialize or manage Git for you.

## 3. Configure the model connection

Open Settings and provide:

- **Base URL:** an endpoint compatible with the OpenAI Responses API.
- **Model:** a model name available at that endpoint.
- **API key:** stored in the operating-system keychain when available.
- **Context budget:** the threshold at which long conversations are compacted.

The frontend never contacts the model endpoint directly; the Rust backend owns all model traffic. Never put an API key in project files or commit it to Git.

## 4. Make the first request

A useful brief includes purpose, mood, structure, and constraints. For example:

> Create an eight-bar seamless loop for nighttime forest exploration in D minor at 92 BPM. Use sustained low strings, a piano arpeggio, bass, and very light drums. Give the melody room to breathe and avoid a bright mood. Create the scene, validate it, and render an OGG preview.

The Agent writes YAML and uses ScoreKit's validation, build, and semantic-diff tools. Do not ask it to invent fields that are absent from the schema. When a goal is outside the protocol, the Agent should explain the limitation and find the closest valid representation.

## 5. Observe, render, and listen

The main workspace areas are:

- **Agent:** continue the conversation and request revisions.
- **Source:** inspect the scene YAML or use explicit Validate and Save actions for manual raw-YAML editing.
- **Preview:** inspect compiled musical parameters and the latest semantic diff.
- **Review:** request structured advice from composing, arranging, production, and media-scoring perspectives.
- **Render:** select a backend, sample rate, format, gain, quality, and optional stems.
- **Outputs:** load audio from `out/` and inspect the matching `meta.json` summary.

For a first render, keep the defaults:

| Setting | Suggested value | Why |
| --- | --- | --- |
| Renderer | `fluidsynth` | Simple setup and a default GM SoundFont |
| Sample rate | `44100 Hz` | Suitable for ordinary listening and most music assets |
| Format | `OGG` | Small files for fast iteration |
| Gain | `0.8` | ScoreKit's default leaves useful headroom |
| Quality | `5` | A middle ground between Vorbis size and quality |
| Stems | Off | Confirm the full mix before exporting every track |

After a successful build, `out/` contains the audio file and a matching `meta.json`. Enabling stems also creates a matching `.stems/` directory.

## Where to go next

- Unfamiliar with the YAML fields? Read [The ScoreKit Scene Protocol](scene-protocol.md).
- The scene validates but sounds thin? Read [From Protocol to Arrangement](arrangement-basics.md).
- Need a different instrument library? Read [Rendering Pipeline and Backends](rendering.md) and [Sound Sources, Sample Libraries, and Licensing](sound-sources.md).
