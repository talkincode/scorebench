# Verification record

Last updated: 2026-07-23 (Asia/Shanghai)

This record is evidence for the M0–M5 issue set. It distinguishes automated proof, native-app smoke, and release operations that require external credentials.

## Automated baseline

All commands ran from a clean dependency graph on the implementation branch:

| Check | Result |
| --- | --- |
| `cargo fmt --check` | pass |
| `cargo clippy --all-targets --all-features -- -D warnings` | pass |
| `cargo test --all-features` | 58 passed, including keychain write verification, Azure/OpenAI auth headers, and strict tool-schema coverage |
| `npm run check` | 0 errors, 0 warnings |
| `npm test` | 2 Vitest files passed |
| `npm run build` | production static build passed |
| `actionlint .github/workflows/*.yml` | pass |
| `npm run tauri build -- --debug` | `.app` and `.dmg` produced |

The Rust suite uses recorded SSE and scene fixtures. It makes no live LLM call. Real scorekit integration tests self-skip only when the CLI is absent; scorekit was present for this run.

## Native macOS GUI smoke

The app was exercised as a bundled Tauri application, not as a static browser mock.

- Startup: healthy scorekit status and version-warning states rendered; an explicit missing-binary launch rendered actionable first-run guidance. The current healthy welcome state is captured in [screenshots-welcome.png](screenshots/screenshots-welcome.png); the missing-binary path remains covered by the startup checks recorded here.
- Project opening: scene YAML and audio assets populated the scene rail and read-only inspector. Empty-project behavior is backed by the project scan test and the UI empty state.
- Observation: tempo/key/meter/bars/loop/tracks updated after an external YAML edit without manual refresh; invalid YAML is covered by the malformed fixture test.
- Rendering: FluidSynth produced OGG and WAV; Timidity produced WAV. Both WAV files were readable by `afinfo` as stereo 44.1 kHz Int16, 20.869546 seconds, 920,347 packets. Their SHA-256 values differed, proving distinct renderer output.
- Playback: auto-load, play/pause/resume, seeking while paused and playing, loop toggle, and metadata display were exercised.
- Spectrum: Bars, Wave, Spectrogram, and Loop ring switched live while audio continued. Style choice persisted across relaunch. The draw-throw test proves fallback to Bars without stopping playback.
- Filesystem: a live tempo edit changed the inspector from 92 to 93 BPM and was reverted to 92, exercising watcher refresh.
- Layout: the native window declares and enforces a 960×640 minimum; the final three-column dark-console design was visually inspected at 1280×800. At narrower widths it uses the compact grid breakpoint. The manual authoring surface remains raw YAML with explicit Validate/Save actions, not a structured editor.
- Theme: the default 171° dark teal hue was inspected in the bundled app. Hue is a persisted setting and feeds the CSS token system plus every canvas spectrum style; backend validation rejects values outside 0–359.
- Azure v1: the bundled app read the existing macOS Keychain entry, `Test connection` returned `connection ok`, and a full Agent request with all eight strict tools returned `OK`. The live model then accepted nullable optional build arguments and completed read/write/validate/build without an HTTP 400.

The old M0 `/doctor` and `/build` stub commands no longer exist: M1 intentionally replaced them with the Responses-driven ReACT loop. Their scorekit tool-start/tool-result/error behaviors are covered by scripted loop tests and the real render smoke above.

## State-safety evidence

- Settings and scene YAML use temp-file + fsync + rename; injected rename failures preserve the prior file.
- API key tests use a fake secret and confirm the keychain path writes no project/app-config plaintext. The explicit insecure fallback is mode 0600 and is never enabled implicitly.
- API key writes are read back before success is reported. A keychain false-positive fails closed, or uses the mode-0600 fallback only when the user explicitly opted in; a fallback write outranks a stale keychain value.
- macOS Keychain access uses the system `security` client with secret input over stdin, so the key is absent from argv and logs. Azure OpenAI/Foundry v1 hosts use the documented `api-key` header; OpenAI hosts retain Bearer authentication.
- Strict tool schemas list every property in `required`; logical optional parameters are nullable. HTTP error bodies are capped in Rust and surfaced by the frontend so invalid-request details are actionable.
- Transcript loading skips corrupt lines with a warning.
- Compaction has four injected kill points; every point restores the previous readable generation.
- Three consecutive compaction cycles preserve the rolling memory and the four most recent input items while archiving every folded item.

## Release boundary

The four-target tag workflow, artifact collection, checksums, version guard, draft release, and conditional notarization are implemented. Local unsigned `.app` and `.dmg` bundles build successfully. The first `v0.1.0` tag dry-run proved the Windows and Linux packages, then exposed that empty Apple environment variables make Tauri attempt an invalid certificate import. The workflow now keeps all Apple variables completely absent on the unsigned path and injects them only when the full six-secret signing/notarization set exists. The repository currently has no Apple secrets, so a notarized public tag cannot be truthfully recorded until release credentials are configured.

## Style pack system (2026-07-19)

Structured style packs replaced the free-text persona setting.

- `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test` (106 passed) ran clean in `src-tauri/` after the change; `npm run check` reported 0 errors and `npm test` passed 5 Vitest files (22 tests).
- `styles.rs` unit tests cover built-in parsing, envelope validation (id/name/YAML-size), user-pack save/list/find/delete round trips with atomic writes, rename-by-`previous_id`, built-in id collision rejection, and corrupt-file tolerance with warnings.
- `agent.rs` proves the active pack's YAML plus the mandatory STYLE CONFLICT DETECTION protocol are injected into the system prompt; `review.rs` proves the pack and its `review.criteria` are embedded in review evidence.
- `manifest.rs` proves the `style.id` reference round-trips through `bench.json` while preserving unknown fields; a dangling reference degrades to no style with a warning event instead of blocking chat or review.
- Legacy `settings.json` files containing `personal_instructions` still parse (field retained for serde compatibility); the persona settings tab and prompt injection were removed.

## Spectrum performance controls (2026-07-23)

This pass adds bounded resource ownership and repeatable performance gates without moving rendering or audio work into the Rust core.

- `npm run check` reported 0 errors and 0 warnings; `npm test` passed 11 Vitest files (134 tests); `npm run build` completed successfully.
- `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `actionlint .github/workflows/*.yml` passed. `cargo test --all-features` completed 113 of 118 tests successfully; its five local HTTP-stream tests could not bind a loopback socket in the execution sandbox and all failed at setup with `PermissionDenied (Operation not permitted)`, so this run is not recorded as a full Rust-suite pass.
- `npm run check:bundle` passed against the fresh production manifest: client JavaScript was 916.0 KiB raw / 267.5 KiB gzip; the largest chunk was 550.6 KiB raw / 138.6 KiB gzip; the Mood entry chunk was 17.2 KiB raw / 6.8 KiB gzip; the Voyage entry chunk was 76.2 KiB raw / 24.1 KiB gzip.
- The production build still emits Vite's generic warning for a chunk above 500 kB. CI now enforces explicit raw and gzip budgets, so further growth fails instead of being hidden by that warning.
- Unit tests cover the two-entry LRU lifecycle (reuse, pre-construction eviction, disposal, failure cleanup), deterministic 120-frame timing summaries, bounded next-style preload selection, and revision-scoped coalescing of identical in-flight scene inspections with retry after settlement.
- Windowed and fullscreen presentation now share one `SpectrumView` and one active canvas. Recording resolves that same canvas instead of creating a second renderer/context.
- Runtime instrumentation emits `scorebench:spectrum-performance` summaries with average, p95, p99, maximum, sample count, and an 8 ms CPU-side frame-work budget. This is diagnostic evidence, not a claim about GPU frame time.

Native WebView GPU timing, forced WebGL context-loss recovery, repeated fullscreen recording, and long-session memory stability were not rerun in this pass. They remain manual acceptance work described in [performance.md](performance.md); the local browser smoke could not start because the execution sandbox denied binding the development server port.
