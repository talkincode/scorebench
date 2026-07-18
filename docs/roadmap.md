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

### M0 — Walking skeleton (status: in progress)

One window that opens a project directory, shows a chat panel wired to a stub agent loop, invokes `scorekit doctor --json` / `build --json` as subprocess tools, and plays a rendered OGG with a canvas spectrum. Proves the four seams: chat ↔ agent core, agent ↔ scorekit subprocess, disk ↔ project state, audio ↔ WebAudio.

### M1 — Agent core

Hand-rolled ReACT loop over the Responses API: streaming, tool dispatch (validate/lint/build/diff/read scene/write scene), error surfaces from scorekit's JSON verbatim, cancellation. Settings panel: base URL, API key (OS keychain), model name, context budget.

### M2 — Observation surfaces

Read-only parameter panel derived from the current scene YAML (tempo/key/sections/tracks/performance), render progress reporting, project asset browser (open output directory), scene diff view after each agent edit (via `scorekit diff`).

### M3 — Project memory

Rolling project summary maintained by the agent; automatic compaction when the transcript exceeds the context budget; memory persisted in the project directory as plain text.

### M4 — Spectrum module system

The spectrum view becomes a pluggable module with a stable interface (bars/waveform/spectrogram variants) so styles can be added without touching playback code.

### M5 — Release engineering

Signed binaries via GitHub Actions for macOS/Windows/Linux; scorekit discovery and version check at startup (`scorekit doctor --json`).

## Acceptance matrix

Rules (MUST):

1. Every tier-1 feature has at least one happy-path E2E or integration test (agent loop against recorded fixtures; scorekit tools against the real CLI).
2. Every high-risk feature covers at least one failure path (LLM endpoint down, scorekit missing/failing, corrupt project dir).
3. Permission-related features verify at least two roles — not applicable (no permission system).
4. Every state-mutating operation (project files, memory, settings) verifies recovery after at least one failure: no corrupted partial state.
5. New tier-1 features land together with their tests and an update to this matrix.

| Feature | Tier | Happy path | Failure path |
| --- | --- | --- | --- |
| (populated as M0 lands) | | | |
