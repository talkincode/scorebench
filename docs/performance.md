# Performance contract

scorebench treats performance as an acceptance surface, not as a commit-prefix
claim. The primary risks are webview frame cost, WebGL lifetime/resource growth,
startup and style-switch latency, duplicate scorekit subprocess work, bundle
growth, and long recording memory. Optimizations must preserve the project
boundaries in `roadmap.md`: scorekit remains a JSON/exit-code subprocess, audio
and video encoding remain in the webview, and the Rust core is only a byte sink
for finished recordings.

## Runtime policy

- One `Player` owns one `SpectrumView`. Entering fullscreen moves the same view
  through CSS; it does not create a second renderer, scene, analyser loop, or
  GPU cache.
- The in-tree Three.js cache is LRU-bounded to two initialized styles: the
  active style and one warm style. Eviction disposes the instance and remounts
  that style's canvas before it can be selected again.
- Dynamic imports stay lazy. After first paint, at most one likely-next Three.js
  module is imported during idle time; the registry is never preloaded in bulk.
- A hidden document renders no spectrum frames. The synthetic no-audio stage is
  capped at 30 fps; live analyser frames continue to follow `requestAnimationFrame`.
- Import, initialization, resize, render, and unexpected WebGL-context failures
  fall back to Bars without stopping playback. Intentional context loss during
  LRU disposal is not treated as a style failure.
- Concurrent `inspectScene(root, path, revision)` calls share only their
  in-flight Promise for the same explicit project revision. A newer revision
  starts a fresh request even if the old one has not settled; every entry is
  removed on success or failure.

## Machine-observable budgets

`SpectrumView` emits `scorebench:spectrum-performance` on `window` after every
disjoint 120-frame window. `detail` contains `styleId`, `samples`, `averageMs`,
`p95Ms`, `p99Ms`, `maxMs`, `budgetMs`, and `overBudget`. This is CPU-side frame work; a
native WebView/GPU runner must also measure presentation and dropped frames.

| Scenario | Required evidence | Acceptance |
| --- | --- | --- |
| Warm Mood ↔ Voyage switching | 30 switches on a fixed native machine | first presented frame p95 ≤ 33 ms; no two consecutive dropped frames |
| Steady deterministic Voyage journey | 1280×800, DPR 1 and 2, Bloom on/off | 120-frame average ≤ 8 ms; p99 ≤ 16.7 ms; dropped frames < 1% |
| Cache/lifecycle torture | 30 style switches + 20 fullscreen cycles | at most two live in-tree Three contexts; resources plateau; all dispose on view teardown |
| Failure injection | import/create/resize/render/context-loss | next frame falls back to Bars; playback continues; no unhandled rejection |
| Client bundle | production Vite manifest and gzip output | `npm run check:bundle` passes the reviewed total, largest-chunk, Mood, and Voyage limits |
| Scene observation fan-out | concurrent identical API calls | one Tauri invocation per root/path/revision; a newer revision and calls after settle invoke again |

Cold startup, cold first-style selection, GPU time, RSS/heap, power use, and a
30-second recording frame/audio check still require a fixed native Tauri runner.
Until that runner is committed, those are explicit manual evidence gaps; Node
Vitest and a successful Vite build must not be reported as GPU proof.

## Verification commands

```sh
npm run check
npm test
npm run build
npm run check:bundle
```

The dated results belong in `docs/verification.md`. Bundle budgets live in
`scripts/check-client-bundle.mjs`; raising one requires an explained review of
the generated production manifest, not merely changing the threshold until CI
passes.
