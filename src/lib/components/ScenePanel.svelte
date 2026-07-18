<script lang="ts">
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import {
    api,
    errorText,
    type AssetEntry,
    type BuildEvent,
    type BuildParams,
    type SceneInspection,
  } from "../api";
  import { bench } from "../state.svelte";

  let renderer = $state("fluidsynth");
  let sampleRate = $state(44100);
  let gain = $state(0.8);
  let quality = $state(5);
  let stems = $state(false);
  let format = $state<"ogg" | "wav">("ogg");
  let inspection = $state<SceneInspection | null>(null);
  let inspectionError = $state<string | null>(null);
  let inspectionSeq = 0;
  let selectedAsset = $state<string | null>(null);
  let meta = $state<Record<string, unknown> | null>(null);
  let metaError = $state<string | null>(null);

  $effect(() => {
    const root = bench.project?.root;
    const path = bench.selectedScene;
    const revision = bench.projectRevision;
    void revision;
    const seq = ++inspectionSeq;
    inspection = null;
    inspectionError = null;
    if (!root || !path) return;
    void api.inspectScene(root, path).then(
      (value) => {
        if (seq === inspectionSeq) inspection = value;
      },
      (error) => {
        if (seq === inspectionSeq) inspectionError = errorText(error);
      },
    );
  });

  const audioAssets = $derived((bench.project?.assets ?? []).filter((asset) => asset.kind === "audio"));
  const profile = $derived.by(() => {
    const scene = inspection?.scene;
    if (!scene) return [0, 0, 0, 0];
    const intensities = scene.tracks
      .map((track) => track.intensity)
      .filter((value): value is number => typeof value === "number");
    const average = intensities.length
      ? intensities.reduce((sum, value) => sum + value, 0) / intensities.length
      : 0.45;
    return [
      Math.min(100, 18 + scene.tracks.length * 13 + scene.sections.length * 5),
      Math.min(100, Math.round(average * 100)),
      Math.min(100, 16 + scene.harmony.length * 7 + scene.tracks.length * 9),
      Math.min(100, Math.max(12, Math.round(((scene.tempo ?? 90) - 45) * 0.85 + average * 22))),
    ];
  });

  async function refreshProject() {
    if (!bench.project) return;
    try {
      bench.project = await api.refreshProject(bench.project.root);
      bench.projectRevision++;
    } catch {
      bench.buildStatus = "project directory is no longer readable";
      bench.buildFailed = true;
    }
  }

  function onBuildEvent(event: BuildEvent) {
    switch (event.type) {
      case "started":
        bench.buildStatus = event.command;
        break;
      case "finished": {
        bench.building = false;
        bench.buildFailed = false;
        const total = (event.result.meta as { total_samples?: number }).total_samples;
        bench.buildStatus = `done${total ? ` · ${total.toLocaleString()} samples` : ""}`;
        void refreshProject().then(() => {
          if (!bench.project) return;
          const rel = event.result.output.startsWith(bench.project.root)
            ? event.result.output.slice(bench.project.root.length + 1)
            : null;
          if (rel) bench.requestLoad(rel);
        });
        break;
      }
      case "failed":
        bench.building = false;
        bench.buildFailed = true;
        bench.buildStatus = errorText(event.error);
        break;
    }
  }

  async function render() {
    if (!bench.project || !bench.selectedScene || bench.building) return;
    bench.building = true;
    bench.buildFailed = false;
    bench.buildStatus = "starting…";
    const params: BuildParams = { renderer, sample_rate: sampleRate, gain, quality, stems };
    try {
      await api.runBuild(bench.project.root, bench.selectedScene, params, format, onBuildEvent);
    } catch (error) {
      bench.building = false;
      bench.buildFailed = true;
      bench.buildStatus = errorText(error);
    }
  }

  function fmtSize(bytes: number): string {
    if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
    if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
    return `${bytes} B`;
  }

  async function selectAsset(asset: AssetEntry) {
    if (!bench.project) return;
    selectedAsset = asset.rel_path;
    bench.requestLoad(asset.rel_path);
    meta = null;
    metaError = null;
    const metaPath = asset.rel_path.replace(/\.(ogg|wav)$/i, ".meta.json");
    if (!bench.project.assets.some((candidate) => candidate.rel_path === metaPath)) {
      metaError = "No matching meta.json artifact.";
      return;
    }
    try {
      meta = await api.readMeta(bench.project.root, metaPath);
    } catch (error) {
      metaError = errorText(error);
    }
  }

  function displayMeta(value: unknown): string {
    if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
    if (typeof value === "number") return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (typeof value === "boolean") return value ? "yes" : "no";
    return value == null ? "—" : String(value);
  }

  function titleForAsset(path: string): string {
    return path.split("/").at(-1) ?? path;
  }

  async function revealOut() {
    if (!bench.project) return;
    const target = bench.project.assets.some((asset) => asset.rel_path.startsWith("out/"))
      ? `${bench.project.root}/out`
      : bench.project.root;
    await revealItemInDir(target).catch(() => {});
  }
</script>

<div class="panel">
  <section class="module overview">
    <header class="module-head">
      <h2>Scene overview</h2>
      {#if inspection}
        <span class="badge {inspection.validation.status}">{inspection.validation.status}</span>
      {/if}
      <button class="mini" onclick={refreshProject}>Refresh</button>
    </header>
    {#if inspectionError}
      <p class="status failed">{inspectionError}</p>
    {:else if !bench.selectedScene}
      <p class="empty">Select a scene.</p>
    {:else if !inspection}
      <p class="empty scanning">Reading scene signal…</p>
    {:else if inspection.parse_error}
      <p class="status failed">Unparseable YAML · {inspection.parse_error}</p>
    {:else if inspection.scene}
      <div class="facts">
        <span class="wide"><b>Title</b>{inspection.scene.title ?? "Untitled scene"}</span>
        <span><b>Tempo</b>{inspection.scene.tempo ?? "—"} BPM</span>
        <span><b>Key</b>{inspection.scene.key ?? "—"}</span>
        <span><b>Meter</b>{inspection.scene.time_signature ?? "—"}</span>
        <span><b>Bars</b>{inspection.scene.bars ?? "—"}</span>
        <span><b>Loop</b>{inspection.scene.loop_enabled == null ? "—" : inspection.scene.loop_enabled ? "Yes" : "No"}</span>
        <span class="wide"><b>Performance</b>{inspection.scene.has_performance ? "Present" : "Default"}</span>
      </div>
      {#if inspection.scene.tracks.length}
        <details class="scene-detail">
          <summary>{inspection.scene.tracks.length} tracks · {inspection.scene.sections.length} sections</summary>
          <ul>
            {#each inspection.scene.tracks as track, index}
              <li><strong>{index + 1}. {track.instrument ?? "unknown"}</strong><span>{track.pattern ?? "—"}</span></li>
            {/each}
          </ul>
        </details>
      {/if}
      {#if inspection.last_diff}
        <details class="scene-detail diff">
          <summary>Last agent change</summary>
          <pre>{JSON.stringify(inspection.last_diff, null, 2)}</pre>
        </details>
      {/if}
      {#if inspection.validation.error}<p class="status failed">{errorText(inspection.validation.error)}</p>{/if}
    {/if}
  </section>

  <section class="module profile-module">
    <header class="module-head"><h2>Musical profile</h2></header>
    <div class="profile-grid">
      {#each ["Density", "Dynamics", "Complexity", "Energy"] as label, index}
        <div class="meter">
          <span class="arc" style={`--value: ${profile[index]}; --meter-shift: ${index * 38}`}>
            <strong>{profile[index]}<small>%</small></strong>
          </span>
          <b>{label}</b>
        </div>
      {/each}
    </div>
  </section>

  <section class="module render-module">
    <header class="module-head"><h2>Render controls</h2></header>
    <div class="params">
      <label><span>Renderer</span><select bind:value={renderer} disabled={bench.building}><option value="fluidsynth">fluidsynth</option><option value="timidity">timidity</option><option value="sfizz">sfizz</option></select></label>
      <label><span>Sample rate</span><select bind:value={sampleRate} disabled={bench.building}><option value={44100}>44100 Hz</option><option value={48000}>48000 Hz</option></select></label>
      <label><span>Format</span><select bind:value={format} disabled={bench.building}><option value="ogg">OGG</option><option value="wav">WAV</option></select></label>
      <label><span>Gain</span><input type="number" min="0" max="2" step="0.05" bind:value={gain} disabled={bench.building} /></label>
      <label><span>Quality</span><input type="number" min="0" max="10" step="1" bind:value={quality} disabled={bench.building} /></label>
      <label class="check"><input type="checkbox" bind:checked={stems} disabled={bench.building} /><span>Stems</span></label>
    </div>
    <button class="render-btn" onclick={render} disabled={!bench.project || !bench.selectedScene || bench.building}>
      <span class="render-glyph">▮▮▮</span>{bench.building ? "Rendering…" : "Render"}
    </button>
    {#if bench.building}<div class="progress" role="progressbar" aria-label="rendering"><div></div></div>{/if}
    {#if bench.buildStatus}<p class="status" class:failed={bench.buildFailed}>{bench.buildStatus}</p>{/if}
  </section>

  <section class="module assets-module">
    <header class="module-head"><h2>Current outputs</h2><span class="count">{audioAssets.length}</span></header>
    {#if audioAssets.length === 0}
      <p class="empty">Nothing rendered yet.</p>
    {:else}
      <ul class="asset-list">
        {#each audioAssets as asset}
          <li class:selected={selectedAsset === asset.rel_path}>
            <button class="asset-main" onclick={() => selectAsset(asset)} title="Load into player">
              <strong>{titleForAsset(asset.rel_path)}</strong><span>{fmtSize(asset.size_bytes)}</span><i>▶</i>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if meta}
      <div class="meta-grid">
        {#each ["seconds", "sample_rate", "loop_samples", "stems"] as key}<span><b>{key}</b>{displayMeta(meta[key])}</span>{/each}
      </div>
    {:else if metaError}
      <p class="status failed">{metaError}</p>
    {/if}
    <button class="open-output" onclick={revealOut}><span>□</span> Open output folder</button>
  </section>
</div>

<style>
  .panel { display: flex; min-height: 0; flex-direction: column; gap: 8px; height: 100%; overflow-y: auto; }
  .module {
    border: 1px solid var(--accent-line);
    border-radius: var(--radius-lg);
    background: var(--panel-glass);
    box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255,255,255,.022);
    overflow: hidden;
  }
  .module-head { display: flex; align-items: center; min-height: 32px; padding: 0 10px; border-bottom: 1px solid var(--line); background: linear-gradient(90deg, var(--accent-soft), transparent 70%); }
  h2 { margin: 0; color: var(--accent); font-size: 9px; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
  .mini { margin-left: auto; padding: 3px 7px; color: var(--fg-dim); background: transparent; border: 1px solid var(--line-strong); border-radius: 4px; font-size: 8px; cursor: pointer; }
  .mini:hover { color: var(--accent); border-color: var(--accent-line-strong); }
  .badge { margin-left: 7px; padding: 2px 5px; border-radius: 2px; font: 7px var(--mono); text-transform: uppercase; }
  .badge.valid { color: var(--good); background: color-mix(in srgb, var(--good) 12%, transparent); }
  .badge.invalid { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
  .badge.unavailable { color: var(--warning); background: color-mix(in srgb, var(--warning) 12%, transparent); }
  .facts { display: grid; grid-template-columns: repeat(2, 1fr); }
  .facts span { min-width: 0; padding: 7px 9px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); color: var(--fg); font: 10px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .facts span:nth-child(even), .facts .wide { border-right: 0; }
  .facts .wide { grid-column: 1 / -1; }
  .facts b, .meta-grid b { display: block; margin-bottom: 3px; color: var(--fg-muted); font: 7px var(--sans); font-weight: 500; text-transform: uppercase; }
  .empty, .status { margin: 0; padding: 10px; color: var(--fg-dim); font: 9px var(--mono); line-height: 1.45; overflow-wrap: anywhere; }
  .scanning { animation: pulse 1.3s ease-in-out infinite alternate; }
  .status.failed { color: var(--bad); }
  .scene-detail { margin: 6px 8px 8px; color: var(--fg-dim); font: 8.5px var(--mono); }
  .scene-detail summary { cursor: pointer; }
  .scene-detail ul { display: grid; gap: 3px; margin: 6px 0 0; padding: 0; list-style: none; }
  .scene-detail li { display: flex; justify-content: space-between; gap: 8px; }
  .scene-detail li strong { color: var(--fg); font-weight: 500; }
  .scene-detail pre { max-height: 120px; overflow: auto; white-space: pre-wrap; font: 8px var(--mono); }
  .profile-grid { display: grid; grid-template-columns: repeat(4, 1fr); padding: 9px 6px 8px; }
  .meter { display: grid; place-items: center; gap: 3px; }
  .meter > b { color: var(--fg-muted); font-size: 7px; font-weight: 500; }
  .arc { --meter-color: hsl(calc(var(--theme-hue) + var(--meter-shift)) 82% 62%); display: grid; place-items: center; width: 45px; height: 45px; border-radius: 50%; background: conic-gradient(from 220deg, var(--meter-color) calc(var(--value) * .72%), var(--line) 0 72%, transparent 0); box-shadow: 0 0 14px color-mix(in srgb, var(--meter-color) 15%, transparent); }
  .arc::before { content: ""; grid-area: 1 / 1; width: 37px; height: 37px; border-radius: 50%; background: var(--panel-deep); }
  .arc strong { z-index: 1; grid-area: 1 / 1; color: var(--fg); font: 11px var(--mono); font-weight: 400; }
  .arc small { color: var(--fg-muted); font-size: 6px; }
  .params { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; padding: 9px; }
  .params label { display: grid; min-width: 0; gap: 3px; }
  .params label > span { color: var(--fg-muted); font-size: 7px; text-transform: uppercase; }
  .params select, .params input[type="number"] { box-sizing: border-box; min-width: 0; width: 100%; height: 25px; padding: 3px 6px; color: var(--fg); background: var(--control-bg); border: 1px solid var(--line-strong); border-radius: 4px; font: 9px var(--mono); }
  .params select:focus, .params input:focus { outline: none; border-color: var(--accent); }
  .params .check { display: flex; align-items: center; gap: 5px; padding-top: 11px; }
  .params input[type="checkbox"] { accent-color: var(--accent); }
  .render-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: calc(100% - 18px); height: 31px; margin: 0 9px 9px; color: var(--warning); background: linear-gradient(110deg, color-mix(in srgb, var(--warning) 12%, transparent), transparent); border: 1px solid color-mix(in srgb, var(--warning) 65%, transparent); border-radius: 5px; box-shadow: inset 0 0 12px color-mix(in srgb, var(--warning) 7%, transparent), 0 0 10px color-mix(in srgb, var(--warning) 8%, transparent); font-size: 10px; font-weight: 700; cursor: pointer; }
  .render-btn:hover:not(:disabled) { color: #171004; background: var(--warning); box-shadow: 0 0 16px color-mix(in srgb, var(--warning) 32%, transparent); }
  .render-btn:disabled { opacity: .4; cursor: default; }
  .render-glyph { font-size: 6px; letter-spacing: 1px; transform: rotate(90deg); }
  .progress { height: 2px; margin: -4px 9px 8px; overflow: hidden; background: var(--line); }
  .progress div { width: 38%; height: 100%; background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: sweep 1.1s ease-in-out infinite alternate; }
  .count { margin-left: auto; color: var(--fg-muted); font: 8px var(--mono); }
  .asset-list { margin: 0; padding: 5px 8px; list-style: none; }
  .asset-list li { border-bottom: 1px solid var(--line); }
  .asset-list li:last-child { border: 0; }
  .asset-list li.selected { background: var(--accent-soft); }
  .asset-main { display: grid; grid-template-columns: minmax(0, 1fr) auto 22px; align-items: center; gap: 8px; width: 100%; padding: 7px 4px; color: var(--fg); background: transparent; border: 0; text-align: left; cursor: pointer; }
  .asset-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 9px var(--mono); font-weight: 550; }
  .asset-main span { color: var(--fg-muted); font: 8px var(--mono); }
  .asset-main i { display: grid; place-items: center; width: 18px; height: 18px; color: var(--accent); border: 1px solid var(--accent-line-strong); border-radius: 50%; font: normal 6px var(--sans); }
  .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); margin: 0 8px 7px; border: 1px solid var(--line); }
  .meta-grid span { padding: 5px 6px; color: var(--fg); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); font: 8px var(--mono); }
  .open-output { width: calc(100% - 16px); margin: 0 8px 8px; padding: 6px; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 4px; font-size: 8px; cursor: pointer; }
  @keyframes pulse { from { opacity: .45; } to { opacity: 1; } }
  @keyframes sweep { from { transform: translateX(-60%); } to { transform: translateX(260%); } }
  @media (prefers-reduced-motion: reduce) { .scanning, .progress div { animation: none; } }
</style>
