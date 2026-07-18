# scorebench

> **Agent-native workbench for [scorekit](https://github.com/talkincode/scorekit).**
> You talk to the agent; the agent writes the scene DSL and drives scorekit. The GUI observes — it does not edit.

scorebench is a desktop app (Tauri 2 + Svelte 5) that hosts a minimal ReACT agent for composing and rendering game music with scorekit. It is the *shell*, scorekit is the *compiler*, the LLM is the *composer*.

```text
you ──chat──► agent core (Rust, OpenAI Responses API only)
                 │  tool calls (subprocess, --json)
                 ▼
              scorekit  validate / lint / build / diff
                 │
                 ▼
              project dir ──► scene.yaml + out/*.ogg + meta.json
                 │
                 ▼
              WebAudio playback + spectrum (AnalyserNode, zero in-house DSP)
```

## Product shape

- **One project per window.** Opening scorebench means opening one project directory (scene YAML + rendered assets + agent memory). No multi-project tabs.
- **Chat is the only write path.** The agent edits scene YAML and re-renders via scorekit. Parameter panels are read-only observations of the current scene/render state.
- **Playback & spectrum in the webview.** Decoding, FFT, and progress come from the browser's WebAudio API (`AnalyserNode`) — no Rust audio stack, no in-house DSP.
- **Project memory.** The agent maintains a rolling project summary; when the conversation exceeds the configured context budget it compacts automatically.

## Iron rules

1. **Agent core stays minimal.** One provider spec: the OpenAI Responses API (any compatible endpoint via base URL + key). No multi-provider abstraction, no agent framework, no SDK.
2. **scorebench never renders audio itself.** All compilation/rendering/export goes through the `scorekit` CLI (`--json`). If scorekit can't do it, scorebench doesn't do it.
3. **No editing UI.** No piano roll, no timeline, no form-based YAML editor. The DSL is edited by the agent (or by the user in their own editor); scorebench observes and plays.
4. **Deterministic boundary respected.** scorebench never post-processes rendered artifacts; what scorekit writes is what plays.

## Status

Walking skeleton. See [docs/roadmap.md](docs/roadmap.md).

## Development

```bash
npm install
npm run tauri dev    # requires Rust toolchain + scorekit on PATH
```

## License

[MIT](LICENSE)
