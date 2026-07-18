# scorebench Project Profile & Direction

> **scorebench is the agent-native workbench for scorekit — a shell, not a brain, not a DAW.**
> The LLM composes, scorekit compiles, scorebench hosts the conversation and lets you hear the result.

## Project overview

scorebench is a desktop app (Tauri 2 + Svelte 5) for chat-driven game-music production. Each window opens exactly one **project directory** containing scene YAML, rendered assets, and agent memory. The user talks; a minimal hand-rolled ReACT agent (OpenAI Responses API spec only) edits the scene DSL and drives the `scorekit` CLI to validate, lint, build, and diff. The GUI's job is observation: read-only parameter panels, a spectrum/playback view (WebAudio `AnalyserNode`), render progress, and the chat itself.

Origin ruling (2026-07): a "simple render GUI inside scorekit" was audited and rejected — scorekit's *No GUI* iron rule stands. scorebench exists as an independent repository precisely so that scorekit stays a pure compiler. A second audit rejected building on agent frameworks/SDKs: the owner has built agents before, needs exactly one provider spec, and third-party frameworks add more uncertainty than they remove.

## Non-goals (iron rules)

- **No agent frameworks, no LLM SDKs.** The ReACT loop is hand-rolled against the OpenAI Responses API spec (configurable base URL/key/model — works with any compatible endpoint). No multi-provider abstraction until a second provider spec is a proven need.
- **No in-house audio.** No rendering, mixing, decoding, or DSP in Rust. scorekit produces every artifact; the webview's WebAudio API handles playback and FFT for the spectrum display.
- **No editing UI.** No piano roll, timeline, or YAML form editors. Parameters are read-only observations; the agent is the only writer. (The user can always edit files in their own editor — scorebench watches the directory.)
- **No multi-project workspace.** One window, one project. Project switching = open a different directory.
- **No in-house version control.** Project directories are plain files, git-managed by the user.

## Direction & intent (roadmap)

> Milestones express target capabilities, not a mandated implementation order.

### M0 — Walking skeleton (status: complete)

One window that opens a project directory, shows a chat panel wired to a stub agent loop, invokes `scorekit doctor --json` / `build --json` as subprocess tools, and plays a rendered OGG with a canvas spectrum. Proves the four seams: chat ↔ agent core, agent ↔ scorekit subprocess, disk ↔ project state, audio ↔ WebAudio.

Findings: scorekit's machine contract is *failure-side* JSON — success is exit 0 plus (for `build`) the atomically-written `<stem>.meta.json`, which scorebench treats as the build result; human stdout is never parsed. The binary is located via `SCOREBENCH_SCOREKIT` > PATH > well-known prefixes (GUI apps on macOS launch with a stripped PATH). Asset bytes cross IPC as binary (`tauri::ipc::Response`) with a containment check pinning reads inside the project root; playback, FFT, and the spectrum stay entirely in the webview (WebAudio `AnalyserNode`), honoring the no-in-house-audio rule. The July 2026 GUI smoke covered native project opening, both renderers, OGG/WAV playback, seek/pause/loop, live spectrum switching, filesystem watching, scorekit-missing guidance, and the 960×640 minimum layout contract. M1 replaced the temporary slash-command stub with the real ReACT loop while preserving the tagged `AgentEvent` frontend contract.

### M1 — Agent core (status: complete)

Hand-rolled ReACT loop over the Responses API: streaming, tool dispatch (validate/lint/build/diff/read scene/write scene), error surfaces from scorekit's JSON verbatim, cancellation. Settings panel: base URL, API key (OS keychain), model name, context budget.

### M2 — Observation surfaces (status: complete)

Read-only parameter panel derived from the current scene YAML (tempo/key/sections/tracks/performance), render progress reporting, project asset browser (open output directory), scene diff view after each agent edit (via `scorekit diff`).

### M3 — Project memory (status: complete)

Rolling project summary maintained by the agent; automatic compaction when the transcript exceeds the context budget; memory persisted in the project directory as plain text.

### M4 — Spectrum module system (status: complete)

The spectrum view becomes a pluggable module with a stable interface (bars/waveform/spectrogram variants) so styles can be added without touching playback code.

### M5 — Release engineering (status: implementation complete)

Signed binaries via GitHub Actions for macOS/Windows/Linux; scorekit discovery and version check at startup (`scorekit doctor --json`).

The release workflow builds both macOS architectures plus Windows and Linux, collects platform installers and checksums, and creates a draft release. macOS signing/notarization is conditional on repository Apple credentials; local unsigned bundles remain supported. A real notarized tag is an operational release action, not something the application can synthesize without those credentials.

## Interface direction

scorebench uses a dark "sonic control room" visual system: dense three-column project/agent/observation layout, low-luminance panels, signal-grid texture, and one user-selectable global hue. The hue is stored in app settings and drives borders, status lights, focus states, scene art, player transport, and every spectrum style. Amber is reserved for render/open actions so the chosen hue remains an information channel rather than decoration. The observation surfaces stay read-only.

## Acceptance matrix

Rules (MUST):

1. Every tier-1 feature has at least one happy-path E2E or integration test (agent loop against recorded fixtures; scorekit tools against the real CLI).
2. Every high-risk feature covers at least one failure path (LLM endpoint down, scorekit missing/failing, corrupt project dir).
3. Permission-related features verify at least two roles — not applicable (no permission system).
4. Every state-mutating operation (project files, memory, settings) verifies recovery after at least one failure: no corrupted partial state.
5. New tier-1 features land together with their tests and an update to this matrix.

| Feature | Tier | Happy path | Failure path |
| --- | --- | --- | --- |
| scorekit binary discovery | 1 | integration tests run via PATH-located binary | `locate_missing_everywhere_is_typed_error`, `locate_env_override_must_be_executable` (`scorekit.rs`) |
| scorekit error contract (`--json` stderr) | 1 | `doctor_fixture_shape_holds`, `meta_fixture_shape_holds` (recorded fixtures) | `parses_recorded_io_error`, `falls_back_on_non_json_stderr` |
| Build param → CLI arg mapping | 1 | `build_params_render_full_arg_set` | n/a (pure function, no state) |
| Project directory scan | 1 | `scan_finds_scenes_and_assets` | `scan_rejects_non_directory` |
| Asset read containment (webview → disk) | 1 | `resolve_inside` accepts in-root paths | `resolve_inside_blocks_escape` rejects traversal |
| Responses SSE transport | 1 | recorded text/tool/multi-tool fixtures; arbitrary chunk-boundary equivalence | 401/429 metadata, failed event, mid-stream disconnect, dead endpoint, cancellation |
| ReACT loop + tool dispatch | 1 | scripted transport writes a scene and completes; stable eight-tool schema | offline transport, unknown/malformed tools, max-turn guard, scorekit tool errors |
| Atomic scene write + semantic history | 1 | real-scorekit diff integration test | rename failure preserves original; history failure warns without blocking edit |
| Settings + API key | 1 | settings/keychain round trip | corrupt-file backup, keychain opt-in fallback, atomic-write kill point, invalid hue |
| Scene observation + watcher | 1 | scorekit scene fixtures; external-change GUI smoke | malformed YAML and watcher-storm coalescing |
| Project memory + compaction | 1 | repeated three-cycle compaction keeps recent turns and coherent memory | corrupt line recovery; every two-phase kill point restores a loadable generation |
| Player + spectrum (WebAudio) | 2 | GUI smoke: OGG/WAV, seek/pause/loop, four live styles | decode errors surface; draw exception falls back to bars without stopping playback |
| scorekit startup handshake | 1 | doctor/version fixture and local GUI startup | missing/unversioned binary yields guidance or warning without blocking the app |
| Release packaging | 1 | local macOS app + DMG build; four-target workflow validated by actionlint | absent Apple secrets leave unsigned/non-mac builds available; tag/version mismatch fails early |
| Dark hue-variable interface | 2 | native-app visual smoke at default hue; settings round trip | hue outside 0–359 rejected before settings write |

The dated command log and manual GUI evidence live in [verification.md](verification.md).
