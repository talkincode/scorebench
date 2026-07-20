# scorebench Agent Spec

The project profile, roadmap, and acceptance matrix live in [docs/roadmap.md](docs/roadmap.md). Read it before making changes.

## Core boundaries (MUST)

- MUST NOT introduce an agent framework or LLM SDK. The agent core is hand-rolled: a ReACT loop over the **OpenAI Responses API** spec only (configurable base URL + key + model). No multi-provider abstraction layers.
- MUST NOT render, mix, or post-process audio in-process. All musical output is produced by invoking the `scorekit` CLI as a subprocess with `--json`. Spectrum/playback use the webview's WebAudio API only; visualizer video export uses the webview's MediaRecorder (canvas + audio capture, system encoder) — the Rust core only writes the finished bytes to a user-chosen path.
- MUST NOT grow structured editing UI (piano roll, timeline, form-based scene editors). Parameter panels are read-only observations. Scene YAML is written through exactly two paths: the agent's tools, and the manual raw-source editor (explicit Validate/Save buttons, no autosave) for experienced users working without an API key.
- MUST keep scorekit's contract intact: scorebench consumes `scorekit`'s machine-readable JSON output and exit codes; it never parses human-oriented text output.
- Secrets (API keys) MUST be stored via the OS keychain or an untracked local config — never in project directories, never committed.

## Architecture stance

- Tauri 2 + Svelte 5 + TypeScript frontend; Rust backend owns: agent loop, tool dispatch (subprocess to scorekit), project directory management, context compaction.
- One window = one project directory. Project state on disk is plain files (scene YAML, rendered assets, `bench.json` project manifest, agent memory) — diff-friendly, git-managed by the user, no embedded database.
- Frontend never calls the network directly; all LLM traffic goes through the Rust core.

## Verification

- `cargo fmt --check`, `cargo clippy`, `cargo test` in `src-tauri/`; `npm run check` for the frontend.
- Tool-dispatch and compaction logic must be unit-tested against recorded fixtures — no live LLM calls in tests.
