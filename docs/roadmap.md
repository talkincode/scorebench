# scorebench Project Profile & Direction

> **scorebench is the agent-native workbench for scorekit — a shell, not a brain, not a DAW.**
> The LLM composes, scorekit compiles, scorebench hosts the conversation and lets you hear the result.

## Project overview

scorebench is a desktop app (Tauri 2 + Svelte 5) for chat-driven game-music production. Each window opens exactly one **project directory** containing scene YAML, rendered assets, and agent memory. The user talks; a minimal hand-rolled ReACT agent (OpenAI Responses API spec only) edits the scene DSL and drives the `scorekit` CLI to validate, lint, build, and diff. The GUI's job is observation: read-only parameter panels, a spectrum/playback view (WebAudio `AnalyserNode`), render progress, and the chat itself.

Origin ruling (2026-07): a "simple render GUI inside scorekit" was audited and rejected — scorekit's *No GUI* iron rule stands. scorebench exists as an independent repository precisely so that scorekit stays a pure compiler. A second audit rejected building on agent frameworks/SDKs: the owner has built agents before, needs exactly one provider spec, and third-party frameworks add more uncertainty than they remove.

## Non-goals (iron rules)

- **No agent frameworks, no LLM SDKs.** The ReACT loop is hand-rolled against the OpenAI Responses API spec (configurable base URL/key/model — works with any compatible endpoint). No multi-provider abstraction until a second provider spec is a proven need.
- **No in-house audio.** No rendering, mixing, decoding, or DSP in Rust. scorekit produces every artifact; the webview's WebAudio API handles playback and FFT for the spectrum display. Visualizer video export stays inside the same boundary: the webview's MediaRecorder captures canvas + playback audio through the system encoder, and the Rust core only writes the finished container bytes to a user-chosen path.
- **No structured editing UI.** No piano roll, timeline, or YAML form editors. Parameters are read-only observations. Scene YAML has exactly two writers: the agent's tools, and a manual raw-source editor (explicit Validate/Save buttons, never autosave) so experienced users can create and edit scenes without an API key. (The user can always edit files in their own editor too — scorebench watches the directory.)
- **No multi-project workspace.** One window, one project. Project switching = open a different directory.
- **No in-house version control.** Project directories are plain files, git-managed by the user.
- **Host-agnostic core, no second host.** Tauri APIs are confined to the host layer (`lib.rs`, `main.rs`, `watcher.rs`, `settings.rs`); core modules (agent, llm, scorekit, project, sessions, memory, observation, attachments) stay framework-free — enforced by `src-tauri/tests/tauri_boundary.rs`. No web server / second host is built until a concrete deployment need exists; the rule exists so that extraction stays mechanical if that day comes.

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

The release workflow builds both macOS architectures plus Windows and Linux, collects platform installers and checksums, and creates a draft release. Publishing that release updates the Homebrew cask in `talkincode/homebrew-tap` when `HOMEBREW_TAP_TOKEN` is configured. macOS signing/notarization is conditional on repository Apple credentials; local unsigned bundles remain supported. A real notarized tag is an operational release action, not something the application can synthesize without those credentials.

### M6 — Review panel (status: complete)

A fourth workspace tab (`Agent | Source | Preview | Review`) that turns critique into a first-class workflow: the user picks reviewer perspectives (composer, arranger, producer, media scoring, young listener) and gets one structured multi-perspective report — per-perspective strengths/issues with severity and confidence (no numeric scores), cross-perspective tensions, consensus, and actionable suggestions labeled with priority and severity (high-priority first). Each suggestion can be handed to the agent, which prefills the chat input — review output is advice, never a command; the agent remains the only writer.

Design ruling (2026-07 audit): the original "expert jury" proposal (N parallel role agents + consensus engine) was rejected as framework-resurrection with cosplay divergence. v1 is **one** LLM call (`tools: []`, same side-channel pattern as compaction) whose evidence pack is assembled deterministically in Rust: scene YAML, the scene DSL JSON schema (`scorekit schema --json`), `scorekit validate` status, last semantic diff, render `meta.json` when present, project memory, and recent user intents. The schema closes the information asymmetry that made early reviews unactionable — without it the reviewer prescribed general orchestration controls (octave constraints, per-track exceptions, intra-section ramps) the DSL cannot express, and the composing agent rightly rejected them; the prompt now requires suggestions to stay schema-expressible and routes out-of-schema musical goals into `issues`. The prompt states plainly that the reviewer has not heard the audio. Deferred until evidence demands them: parallel per-role calls, a signal-analyst perspective (needs a scorekit audio-features contract), review persistence, and any consensus machinery.

### M7 — Style packs (status: complete)

Preset styles are structured **StylePacks**, not prompt strings: YAML documents with a validated envelope (`id`, `name`, optional `name_en`/`category`) and a free-form body (`defaults`, `harmony`, `melody`, `arrangement`, `form`, `review.criteria`) that the agent reads as data. Built-in packs (e.g. epic new-age instrumental, 90s Chinese campus folk) compile into the binary read-only; user packs live in the global app-config `styles/` directory and are managed from a fifth workspace tab (list + YAML editor, create/duplicate/edit/delete). The active pack is a per-project `style.id` reference in `bench.json`, selectable from the creative assist panel.

The pack is injected into the system prompt with a mandatory conflict-detection protocol: the agent must check each request against the active style, surface conflicts and propose a reconciliation (or ask) instead of silently implementing, with explicit user instructions winning after the conflict is acknowledged. `review.criteria` feed the review panel's evidence pack so a pack also carries its own acceptance standards. This replaced the free-text "persona" setting, which conflicted with per-request intent; the legacy settings field still parses but is no longer injected.

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
| Player + spectrum (WebAudio) | 2 | GUI smoke: OGG/WAV, seek/pause/loop, live style switching incl. three.js scenes, auto style, fullscreen visualizer | decode errors surface; draw/WebGL failure falls back to bars without stopping playback |
| Visualizer video export (webview MediaRecorder) | 2 | mime pick + file naming unit tests (`recording.test.ts`); watermark wrap/signature unit tests (`titleCard.test.ts`); filter/sink handoff unit tests (`lib.rs`); GUI smoke: fullscreen REC restarts the piece with the title card + logo/repo watermark burned into every frame, stops manually or at natural end, saves H.264/AAC MP4 via native dialog | unsupported recorder yields an inline message; encoder warm-up timeout, cancelled dialog (discard), and missing-destination write are typed errors surfaced in the overlay; style switching disabled during a take (canvas remount would kill the stream) |
| scorekit startup handshake | 1 | doctor/version fixture and local GUI startup | missing/unversioned binary yields guidance or warning without blocking the app |
| Release packaging | 1 | local macOS app + DMG build; four-target workflow validated by actionlint; published releases update the Homebrew cask when the tap token is configured | absent Apple secrets leave unsigned/non-mac builds available; absent tap token skips Homebrew without failing; tag/version mismatch fails early |
| Dark hue-variable interface | 2 | native-app visual smoke at default hue; settings round trip | hue outside 0–359 rejected before settings write |
| Chat sessions (per-session memory) | 1 | session create/list/select round trip; legacy single-session state migrates to `sessions/main/` | invalid session ids rejected; corrupt index rebuilt from directory scan (`sessions.rs`) |
| Message attachments (image/pdf/text) | 1 | paths become typed `ContentPart`s with data URLs (`attachments.rs`); clipboard pastes are stashed to temp files (`stash`) and reuse the same path pipeline | oversize and unsupported files yield typed errors, no partial sends |
| Scene deletion (GUI-confirmed) | 1 | `delete_scene` removes scene inside root | non-scene paths and traversal rejected by `resolve_inside` |
| Scene source read (workspace tabs) | 1 | `read_scene_source` returns raw YAML for source/preview tabs | out-of-root and non-YAML paths rejected |
| Manual scene authoring (create/edit/validate/save) | 1 | `create_scene` template + refuse-overwrite; `save_scene_source` snapshots history then writes atomically; `validate_scene_content` stages a hidden temp file for `scorekit validate --json` (`project.rs`, `observation.rs`) | non-YAML names, traversal, and existing files rejected; failed history snapshot degrades to a warning; editor never autosaves — Validate/Save are explicit buttons |
| Locale + interface settings | 2 | persist/load round trip incl. `locale`; unknown locale falls back to `en` before write | legacy `personal_instructions` field still parses (persona retired in favor of style packs) |
| Spectrum dynamics helpers | 2 | envelope/smoother/impact unit tests (`dynamics.test.ts`) | idle spectrum stays below quiet ceiling; impact decays without audio |
| Mood spectrum (emotion-compiler acceptance view) | 2 | perceptual features distinguish major/minor/cluster/fifths chords (`features.test.ts`); V-A-T emotion matrix — sad/happy valence split, tense material raises tension, build-up detected on crescendo but not steady groove, five world archetypes each win on matching material, intent prior nudges valence, dominant switch respects dwell (`mood.test.ts`) | empty/zero frames stay neutral without NaN; missing `sampleRate`/`intentMode` options degrade to defaults; HUD is read-only and toggleable (`moodHud`) |
| Review panel (multi-perspective critique) | 1 | recorded report fixture streams through scripted transport and parses into a typed report; evidence pack assembled from scene/validation/meta/memory/intents (`review.rs`) | non-JSON reply, empty-perspective report, unknown perspective id, transport failure, and missing terminal event are typed errors; evidence gathering rejects out-of-root scenes and tolerates unbuilt projects |
| Toolchain validation gate (write → validate → profile check) | 1 | `write_scene` auto-validates via real scorekit and reports inline; scene×profile compatibility detected from `bench.json` (`tools.rs`, `manifest.rs`); render config injected into system prompt with mapped instruments | invalid scene persists but is reported `invalid` with the machine error; missing scorekit degrades to `unavailable`; unreadable profile and unmapped instruments surface as warnings, never block the write |
| bench.json render config persistence | 1 | render round trip preserves unknown fields; GUI selection inherited by `build_scene` when params omitted | missing file loads defaults silently; corrupt JSON degrades to defaults with a warning, never an error |
| Scene story display (scorekit ≥0.2 `story` field) | 2 | `inspect_scene` surfaces optional top-level `story` prose in the observation panel (`observation.rs`) | absent or non-string story renders nothing; field stays informational, never parsed |
| Creative assist panel (prompt tags) | 2 | tag click appends its bilingual description to the chat input; selections light recommended pairings across categories (`assist.ts` unit tests: unique ids, valid recommends graph, bilingual coverage) | panel writes prompt text only — never scene YAML; empty selection recommends nothing |
| Style pack library (structured presets) | 1 | built-in packs parse and validate; user pack save/list/find round trip with atomic write; rename via `previous_id` removes the old file (`styles.rs`) | invalid id/name/YAML rejected before write; built-in ids are read-only (no save/delete); corrupt user file skipped with a warning, never fatal |
| Active style injection + conflict detection | 1 | `bench.json` `style.id` round trip (`manifest.rs`); active pack YAML injected into the system prompt with the mandatory conflict-detection protocol; `review.criteria` embedded in review evidence (`agent.rs`, `review.rs`) | dangling style reference degrades to no style with a warning event; chat and review still run |

The dated command log and manual GUI evidence live in [verification.md](verification.md).
