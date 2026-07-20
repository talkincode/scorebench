# Troubleshooting

First identify the layer that failed: model connection, scene protocol, ScoreKit environment, renderer, sound source, or musical result. Do not hide an environment error by repeatedly asking the Agent to regenerate the scene.

## scorebench cannot find ScoreKit

Typical symptoms are a “ScoreKit missing” startup notice or failed Agent/Render calls.

```bash
which scorekit
scorekit --version
scorekit doctor
```

If the CLI works in a terminal but not in the desktop application, set `SCOREBENCH_SCOREKIT` to the executable's absolute path and restart scorebench. Confirm that the current user can execute the file.

## Homebrew says `untrusted tap`

If install fails with:

`Refusing to load formula talkincode/tap/scorekit from untrusted tap talkincode/tap`

trust the tap explicitly, then retry:

```bash
brew tap talkincode/tap
brew trust --tap talkincode/tap
brew install --cask talkincode/tap/scorebench
```

This happens when the cask is trusted but the tap's formulae are not yet trusted.

## `doctor` says the environment is not ready

A complete ScoreKit audio build needs FFmpeg and at least one renderer:

- **FluidSynth missing:** install the `fluid-synth` or `fluidsynth` package.
- **TiMidity++ missing:** ignore it if you do not use that backend.
- **FFmpeg missing:** install it and run `scorekit doctor` again.
- **Default SoundFont missing:** reinstall ScoreKit's default sound source or configure `SCOREKIT_SOUND_LIBRARY_DIR`.

`doctor` knows the current platform and ScoreKit version better than this guide, so prefer its specific installation hints.

## Invalid YAML or `unknown field`

```bash
scorekit schema
scorekit --json validate path/to/scene.yaml
```

Common causes include:

- Misspelled fields or invalid indentation.
- Prose concepts added as fields that do not exist in the schema.
- A `melody` track without `motif`, or a missing motif reference.
- A motif or glide set on a non-`melody` track.
- A `drums` instrument paired with another pattern, or the reverse.
- More than 16 tracks or more than one drum track.
- Fields from a newer ScoreKit than the locally installed version.

Ask the Agent to repair the exact `field` and `message` from the structured error rather than deleting an entire section it does not understand.

## sfizz cannot render

Check in this order:

1. A profile is selected in the Render panel.
2. The profile `root` and relative `.sfz` paths exist.
3. Every instrument in the scene has a profile mapping.
4. Every mapped instrument has at least `sustain`.
5. `sfizz_render` is on `PATH`.
6. `scorekit profile check profile.yaml` succeeds.
7. Every WAV or FLAC referenced by the SFZ is present.

A missing dedicated articulation falls back to sustain. A completely unmapped instrument fails the build.

## Articulation does not change the sound

This is expected with FluidSynth or TiMidity++: `articulation` does not change MIDI and cannot switch SF2 programs. Only an sfizz renderer profile can map articulations to different `.sfz` files.

With sfizz, verify that the profile has a dedicated mapping for the requested articulation. Otherwise ScoreKit deliberately falls back to sustain.

## The build succeeds but an instrument is wrong or silent

- For SF2, confirm that the file is valid and has complete GM mappings.
- For SFZ, verify that the patch's playable range covers the scene notes.
- Check gain, track intensity, and section intensity for near-zero values.
- Check whether a section's zero-based `mute` list silences the track.
- Inspect the structured ScoreKit error and matching `meta.json`, not only the process exit code.

## The loop seam sounds abrupt

ScoreKit guarantees asset length and performs seam processing, but it cannot replace musical loop design:

- Does the final harmony want to return to the opening harmony?
- Does the melody stop on a strongly unresolved note?
- Does a drum or bright layer appear only at the end and disappear at the start?
- Is `loop: true` set?
- Have you listened through several consecutive passes rather than only one ending?

## The scene validates but sounds muddy or flat

- Reduce tracks that perform the same role simultaneously.
- Keep one clear low-frequency anchor.
- Add rests to melody motifs.
- Use section mute lists to change density.
- Adjust pan and background intensity instead of raising every track.
- Confirm the arrangement with the default source before assuming SFZ is required.
- Humanization adds nuance; it cannot repair a structural problem.

## The model connection fails

- Confirm that Base URL points to a Responses API-compatible endpoint.
- Check the model name and API-key permissions.
- Distinguish authentication, rate limiting, and server errors by HTTP status.
- For an Azure or OpenAI-compatible gateway, confirm support for tool calls and streaming Responses events.
- Never paste the API key into chat, scenes, or screenshots.

## Reporting a reproducible problem

Include:

- scorebench and ScoreKit versions.
- Operating system and architecture.
- Redacted output from `scorekit --json doctor`.
- A minimal scene YAML that reproduces the issue.
- Renderer, sample rate, format, and profile name.
- The complete structured error.
- Whether default FluidSynth plus MuseScore General also reproduces the issue.

Do not attach API keys, authorization headers, private sound files, or samples whose license does not permit publication.
