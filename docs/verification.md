# Verification record

Last updated: 2026-07-19 (Asia/Shanghai)

This record is evidence for the M0–M5 issue set. It distinguishes automated proof, native-app smoke, and release operations that require external credentials.

## Automated baseline

All commands ran from a clean dependency graph on the implementation branch:

| Check | Result |
| --- | --- |
| `cargo fmt --check` | pass |
| `cargo clippy --all-targets --all-features -- -D warnings` | pass |
| `cargo test --all-features` | 51 passed after the repeated-compaction test was added |
| `npm run check` | 0 errors, 0 warnings |
| `npm test` | 1 Vitest file passed |
| `npm run build` | production static build passed |
| `actionlint .github/workflows/*.yml` | pass |
| `npm run tauri build -- --debug` | `.app` and `.dmg` produced |

The Rust suite uses recorded SSE and scene fixtures. It makes no live LLM call. Real scorekit integration tests self-skip only when the CLI is absent; scorekit was present for this run.

## Native macOS GUI smoke

The app was exercised as a bundled Tauri application, not as a static browser mock.

- Startup: healthy scorekit status and version-warning states rendered; an explicit missing-binary launch rendered actionable first-run guidance. Evidence: [first-run-scorekit-missing.jpg](screenshots/first-run-scorekit-missing.jpg).
- Project opening: scene YAML and audio assets populated the scene rail and read-only inspector. Empty-project behavior is backed by the project scan test and the UI empty state.
- Observation: tempo/key/meter/bars/loop/tracks updated after an external YAML edit without manual refresh; invalid YAML is covered by the malformed fixture test.
- Rendering: FluidSynth produced OGG and WAV; Timidity produced WAV. Both WAV files were readable by `afinfo` as stereo 44.1 kHz Int16, 20.869546 seconds, 920,347 packets. Their SHA-256 values differed, proving distinct renderer output.
- Playback: auto-load, play/pause/resume, seeking while paused and playing, loop toggle, and metadata display were exercised.
- Spectrum: Bars, Wave, Spectrogram, and Loop ring switched live while audio continued. Style choice persisted across relaunch. The draw-throw test proves fallback to Bars without stopping playback.
- Filesystem: a live tempo edit changed the inspector from 92 to 93 BPM and was reverted to 92, exercising watcher refresh.
- Layout: the native window declares and enforces a 960×640 minimum; the final three-column dark-console design was visually inspected at 1280×800. At narrower widths it uses the compact grid breakpoint rather than introducing an editing surface.
- Theme: the default 171° dark teal hue was inspected in the bundled app. Hue is a persisted setting and feeds the CSS token system plus every canvas spectrum style; backend validation rejects values outside 0–359.

The old M0 `/doctor` and `/build` stub commands no longer exist: M1 intentionally replaced them with the Responses-driven ReACT loop. Their scorekit tool-start/tool-result/error behaviors are covered by scripted loop tests and the real render smoke above.

## State-safety evidence

- Settings and scene YAML use temp-file + fsync + rename; injected rename failures preserve the prior file.
- API key tests use a fake secret and confirm the keychain path writes no project/app-config plaintext. The explicit insecure fallback is mode 0600 and is never enabled implicitly.
- Transcript loading skips corrupt lines with a warning.
- Compaction has four injected kill points; every point restores the previous readable generation.
- Three consecutive compaction cycles preserve the rolling memory and the four most recent input items while archiving every folded item.

## Release boundary

The four-target tag workflow, artifact collection, checksums, version guard, draft release, and conditional notarization are implemented. Local unsigned `.app` and `.dmg` bundles build successfully. The repository currently has no Apple signing/notarization secrets, so a notarized public tag cannot be truthfully recorded until release credentials are configured; the workflow deliberately keeps unsigned and non-macOS builds viable in that condition.
