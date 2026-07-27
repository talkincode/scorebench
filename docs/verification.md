# Verification record

Last updated: 2026-07-27 (Asia/Shanghai)

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

## Version source sync + audit follow-ups (2026-07-24)

This pass closes the 2026-07-24 project-audit findings: version drift across manifests, an undeclared demo-script dependency, and two roadmap commitments left open-ended.

- `scripts/set-version.mjs` now writes all five version sources in one run: `src-tauri/tauri.conf.json`, `package.json`, `package-lock.json` (both top-level and `packages[""]`), `src-tauri/Cargo.toml`, and the `scorebench` entry in `src-tauri/Cargo.lock`. Running it with `0.3.3` brought `package.json`/`Cargo.toml` (previously stuck at `0.1.0`) in line with the released version.
- `scripts/check-tag-version.mjs` (the release workflow's tag gate) now fails on drift between any of the five sources before comparing against the tag. Verified three ways: matching tag passes, mismatched tag fails, and an injected `package.json` desync is caught as `version drift across sources`.
- `esbuild` is a declared devDependency (`^0.25.12`); the `demo:*` scripts no longer depend on a global install (`npx --no-install esbuild --version` resolves locally).
- Roadmap commitments made falsifiable: the legacy `personal_instructions` field's parsing is scheduled for removal in 0.5.0 (M7 + acceptance matrix), and shared weather-helper extraction is recorded as a hard prerequisite for the next M9 imagery module.
- Gates after the change: `cargo fmt --check` clean; `cargo clippy --all-targets --all-features -- -D warnings` clean; `cargo test` passed 121 unit tests + the `tauri_boundary` integration test; `npm test` passed 12 Vitest files (141 tests); `npm run check` reported 0 errors and 0 warnings.

## scorekit 0.5 orchestration evidence (2026-07-25)

The `--orchestration` migration landed against scorekit 0.5.0 but kept 0.4.0 recordings and no build-time evidence. This pass closes that gap and was run against a real `scorekit 0.5.0` (`~/.local/bin/scorekit`) with the local `/Volumes/WT9/ScoreData` sound library.

- Recorded contract fixtures re-taken from the 0.5.0 binary: `doctor.json` (`scorekit doctor --json`), `forest.meta.json` (a real `scorekit build` of `tests/fixtures/scenes/forest.yaml`), and the new `error_resolution.json` (a real sfizz build refused because a track routed an unmapped instrument through the `solo` palette). `doctor_fixture_shape_holds` now asserts the recorded version satisfies `TESTED_SCOREKIT_RANGE` instead of pinning a literal, so the recording cannot rot behind the range again; `meta_fixture_shape_holds` asserts every meta track carries `id`/`palette`/`articulation` and that `instrument_resolution` is keyed by the same `track_id`.
- End-to-end sfizz routing proved with the exact argument vector `BuildParams::to_args` emits: `scorekit build routed.yaml -o routed.ogg --renderer sfizz --orchestration /Volumes/WT9/ScoreData/profiles/orchestrations/hybrid-cinematic.yaml --stems --json` produced a seamless 441000-sample loop, a `meta.json` whose `orchestration` block lists all four palettes, and stems named by track ID (`01-harmony.ogg`, `02-solo_line.ogg`) — a `palette: solo` track rendered through `scoredata-chamber` while the default track rendered through `scoredata-open`. `scorekit orchestration check` passed the same profile.
- Failure path confirmed rather than assumed: under scorekit's default `conservative` fallback mode an instrument outside the resolved palette aborts the build (exit 2, `code: "resolution"`), which is what scorebench's pre-build compatibility warning claims.
- `BenchError::Scorekit` now carries scorekit's `report` verbatim (boxed, so the rare payload does not widen every `Result`), and `errorText` folds it into one line per unresolved track: track ID, palette, leaf renderer profile, requested instrument, and the closest candidate with the reason it was rejected. Previously the agent and the panel saw only "1 unresolved instrument(s)".
- The scene preview table now shows each track's stable `id` and resolved `palette` next to its instrument, and a section segment lists the track IDs it mutes — without them a `mute: [pulse]` list could not be mapped back to a row after 0.5 replaced positional indices with IDs. Palette-less tracks use `OrchestrationCompat.tracks[].palette`, not a hard-coded `default` label, so an orchestration whose `default_palette` is `solo` is displayed truthfully.
- A 1440×900 headless browser smoke preloaded the real app with mocked Tauri IPC, opened a three-track project, and navigated to Preview. Two palette-less tracks routed by `default_palette: solo` displayed `solo`, the explicit `electronic` track displayed `electronic`, and section mute IDs remained legible without table or panel overflow. This exercises the Svelte render path; it is not a substitute for the native WebView smoke below.
- `manifest.rs` gained `leaf_profiles_resolve_against_the_orchestration_directory`, covering the layout scorekit's own sound-library contract prescribes: an absolute out-of-project orchestration whose palettes bind to `../renderers/<name>.yaml`. Its temp-root helper also gained the atomic counter the other test modules use; without it parallel tests could collide on one directory and fail with `DirectoryNotEmpty`, which reproduced three times in five runs before the fix and zero times in five runs after.
- Gates after the change: `cargo fmt --check` clean; `cargo clippy --all-targets --all-features -- -D warnings` clean; `cargo test` passed 126 unit tests + the `tauri_boundary` integration test; `npm run check` reported 0 errors and 0 warnings; `npm test` passed 12 Vitest files (145 tests); `npm run build` succeeded and `npm run check:bundle` passed at 923.7 KiB raw / 270.0 KiB gzip client JavaScript.
- Not covered here: the native macOS GUI smoke for the new preview columns was not rerun in this pass.

## ScoreKit 0.6 Agent arrangement contract (2026-07-26)

This pass was verified against `/Users/wangjuntao/GitHub/scorekit/target/debug/scorekit` at ScoreKit `0.6.0` (repository `main` commit `c2e0b0c`; its CLI contract matches the `v0.6.0` release commit pinned in CI). The PATH-installed `~/.local/bin/scorekit` remained at 0.5.0, so every live 0.6 command used `SCOREBENCH_SCOREKIT` explicitly.

- The supported range is `>=0.6.0, <0.7.0`. `doctor.json` and the real Forest build's `forest.meta.json` were re-recorded from 0.6.0; instrument-resolution reasons now record `general_midi_exact`.
- CI has a separate non-skippable contract job. It checks out the immutable ScoreKit v0.6.0 release commit, installs FFmpeg plus FluidSynth so `doctor` can prove both decode and render readiness, builds ScoreKit, sets `SCOREBENCH_REQUIRE_SCOREKIT_CONTRACT=1`, then runs the real v0.6 capability test inside the twelve-tool Agent surface. Missing, unready, or incompatible ScoreKit fails this job rather than turning the integration test into a no-op.
- The live contract test exercises `inspect-instruments`, exact texture match, exit-0 `no_match`, and `texture check` against a generated structured profile and audible WAV. It also proves `erhu` remains unresolved without an exact source even under `fallback_mode: flexible`, preserving ScoreKit's world-identity boundary.
- Scorebench now accepts both path-only and v0.6 structured texture bindings. The local, range-bound v0.6 preflight mirrors ScoreKit's required metadata, closed category/mode vocabulary, token/provenance constraints, and playback invariants; malformed structured profiles block readiness. A valid source used as `loop` when it only declares `one_shot` is reported before build in Rust, Agent tool output, and both observation-panel locations.
- The composing prompt contains a 1.1.0, ScoreKit-range-bound Arrangement Canon derived from the repository skill, alongside a live capability section and the independent active StylePack. Tests cover task-mode applicability, the typed intent contract, advisory palette/craft rules, exact-only world identities, source discovery/certification, and ordered G1–G5 gates.
- `write_scene.validate` was removed. Every scene write now also requires a run-local `declare_arrangement_intent`; revisions and repairs must read the scene first. The original baseline is frozen, stale first writes are rejected, and missing/extra/invariant field changes create an intent-alignment blocker independent of validation, build, instrument-resolution, and grammar gates. A successful build made with one-shot overrides also rechecks the active `bench.json` configuration, so it cannot hide the failure the next default build would hit. Invalid or incompatible scenes may remain on disk for repair, but normal completion stays blocked.
- Text deltas still stream immediately, but the frontend marks them as a provisional draft. A turn is accepted only after all its tool results are known and the gate is clear, and remains transactional until the completed run history is durable on disk. Incomplete Responses, blocked/failed tools, cancellation, max-turn exhaustion, a later-turn failure, or a persistence failure discard or roll back the affected model claims. Channel events are scoped to one run/root/session, project switching is disabled while a run is live, and Stop targets the captured run rather than mutable UI selection. Scripted tests cover multi-delta streaming, incomplete output, failed preflights, text-plus-invalid-write, failed repair, max-turn rollback, durable finalization, persistence rollback, explicit-build override safety, `./`/symlink aliases, Unix backslash filename non-collision, and stale frontend run identities.
- The offline capability fixture produced one pass and one fail across tempo, track count, melody-rest ratio, mode, loop, and motif-contour assertions (`pass_rate: 0.5`). `--min-pass-rate 0.5` exited 0 and `0.75` exited 1.
- Adding the `capability_eval` helper creates a second Cargo binary, so `Cargo.toml` explicitly sets `default-run = "scorebench"`. The exact Tauri dev command `cargo run --no-default-features --color always --` resolves to `target/debug/scorebench`; CI checks the metadata field so a future helper binary cannot silently break development startup again.
- Final gates: `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and the required explicit-v0.6 `cargo test --all-features` passed (151 Rust unit tests plus the Tauri-boundary integration test). `npm run check` reported 0 errors and 0 warnings; `npm test` passed 12 files / 149 tests; `npm run build` succeeded; `npm run check:bundle` passed at 926.4 KiB raw / 270.9 KiB gzip; `actionlint .github/workflows/*.yml` and `mdbook build docs-site` passed.
- Not covered here: no live LLM quality run or native macOS GUI smoke was performed. The opt-in M8 capability runner measures saved output samples without making live model calls; statistical model/prompt baselines and signal-level V-A-T assertions remain follow-up acceptance work.
