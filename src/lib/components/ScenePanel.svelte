<script lang="ts">
  import { api, errorText, type BuildEvent, type BuildParams } from "../api";
  import { bench } from "../state.svelte";

  let selectedScene = $state<string | null>(null);
  let renderer = $state("fluidsynth");
  let sampleRate = $state(44100);
  let gain = $state(0.8);
  let quality = $state(5);
  let stems = $state(false);
  let format = $state<"ogg" | "wav">("ogg");

  $effect(() => {
    // Keep the selection valid as the project changes.
    const scenes = bench.project?.scenes ?? [];
    if (scenes.length === 0) selectedScene = null;
    else if (!scenes.some((s) => s.rel_path === selectedScene)) selectedScene = scenes[0].rel_path;
  });

  const audioAssets = $derived((bench.project?.assets ?? []).filter((a) => a.kind === "audio"));

  async function refreshProject() {
    if (!bench.project) return;
    try {
      bench.project = await api.openProject(bench.project.root);
    } catch {
      // Directory vanished mid-session; surface via status line.
      bench.buildStatus = "project directory is no longer readable";
      bench.buildFailed = true;
    }
  }

  function onBuildEvent(e: BuildEvent) {
    switch (e.type) {
      case "started":
        bench.buildStatus = e.command;
        break;
      case "finished": {
        bench.building = false;
        bench.buildFailed = false;
        const total = (e.result.meta as { total_samples?: number }).total_samples;
        bench.buildStatus = `done${total ? ` — ${total.toLocaleString()} samples` : ""}`;
        refreshProject().then(() => {
          if (!bench.project) return;
          const rel = e.result.output.startsWith(bench.project.root)
            ? e.result.output.slice(bench.project.root.length + 1)
            : null;
          if (rel) bench.requestLoad(rel);
        });
        break;
      }
      case "failed":
        bench.building = false;
        bench.buildFailed = true;
        bench.buildStatus = errorText(e.error);
        break;
    }
  }

  async function render() {
    if (!bench.project || !selectedScene || bench.building) return;
    bench.building = true;
    bench.buildFailed = false;
    bench.buildStatus = "starting…";
    const params: BuildParams = {
      renderer,
      sample_rate: sampleRate,
      gain,
      quality,
      stems,
    };
    try {
      await api.runBuild(bench.project.root, selectedScene, params, format, onBuildEvent);
    } catch (err) {
      bench.building = false;
      bench.buildFailed = true;
      bench.buildStatus = errorText(err);
    }
  }

  function fmtSize(bytes: number): string {
    if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
    if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
    return `${bytes} B`;
  }
</script>

<div class="panel">
  <section>
    <h2>Scenes</h2>
    {#if (bench.project?.scenes ?? []).length === 0}
      <p class="empty">No scene YAML in this project.</p>
    {:else}
      <ul class="scene-list">
        {#each bench.project?.scenes ?? [] as scene}
          <li>
            <label class:selected={selectedScene === scene.rel_path}>
              <input type="radio" name="scene" value={scene.rel_path} bind:group={selectedScene} />
              <span>{scene.rel_path}</span>
            </label>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h2>Render</h2>
    <div class="params">
      <label>
        <span>renderer</span>
        <select bind:value={renderer} disabled={bench.building}>
          <option value="fluidsynth">fluidsynth</option>
          <option value="timidity">timidity</option>
          <option value="sfizz">sfizz</option>
        </select>
      </label>
      <label>
        <span>sample rate</span>
        <select bind:value={sampleRate} disabled={bench.building}>
          <option value={44100}>44100</option>
          <option value={48000}>48000</option>
        </select>
      </label>
      <label>
        <span>gain</span>
        <input type="number" min="0" max="2" step="0.05" bind:value={gain} disabled={bench.building} />
      </label>
      <label>
        <span>quality</span>
        <input type="number" min="0" max="10" step="1" bind:value={quality} disabled={bench.building} />
      </label>
      <label>
        <span>format</span>
        <select bind:value={format} disabled={bench.building}>
          <option value="ogg">ogg</option>
          <option value="wav">wav</option>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={stems} disabled={bench.building} />
        <span>stems</span>
      </label>
    </div>

    <button
      class="primary render-btn"
      onclick={render}
      disabled={!bench.project || !selectedScene || bench.building}
    >
      {bench.building ? "Rendering…" : "Render"}
    </button>

    {#if bench.building}
      <div class="progress" role="progressbar" aria-label="rendering">
        <div class="progress-fill"></div>
      </div>
    {/if}
    {#if bench.buildStatus}
      <p class="status" class:failed={bench.buildFailed}>{bench.buildStatus}</p>
    {/if}
  </section>

  <section class="assets-section">
    <h2>Assets</h2>
    {#if audioAssets.length === 0}
      <p class="empty">Nothing rendered yet.</p>
    {:else}
      <ul class="asset-list">
        {#each audioAssets as asset}
          <li>
            <button
              class="asset"
              class:playing={bench.loadedAsset === asset.rel_path}
              onclick={() => bench.requestLoad(asset.rel_path)}
              title="Load into player"
            >
              <span class="asset-name">{asset.rel_path}</span>
              <span class="asset-size">{fmtSize(asset.size_bytes)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 20px;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--fg-dim);
  }
  .empty {
    color: var(--fg-dim);
    font-size: 13px;
    margin: 0;
  }
  .scene-list,
  .asset-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .scene-list label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-family: var(--mono);
    font-size: 12.5px;
    cursor: pointer;
  }
  .scene-list label:hover {
    background: var(--panel-2);
  }
  .scene-list label.selected {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .scene-list input {
    accent-color: var(--accent);
  }
  .params {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 12px;
    margin-bottom: 12px;
  }
  .params label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--fg-dim);
  }
  .params label.check {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    align-self: end;
    padding-bottom: 6px;
  }
  .params select,
  .params input[type="number"] {
    background: var(--panel-2);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 6px 8px;
    font: inherit;
    font-size: 13px;
  }
  .params input[type="checkbox"] {
    accent-color: var(--accent);
  }
  .render-btn {
    width: 100%;
  }
  .progress {
    margin-top: 10px;
    height: 4px;
    border-radius: 999px;
    background: var(--panel-2);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    width: 40%;
    border-radius: 999px;
    background: var(--accent);
    animation: sweep 1.1s ease-in-out infinite alternate;
  }
  @keyframes sweep {
    from { transform: translateX(-60%); }
    to { transform: translateX(260%); }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress-fill { animation: none; width: 100%; opacity: 0.5; }
  }
  .status {
    margin: 8px 0 0;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--fg-dim);
    word-break: break-word;
  }
  .status.failed {
    color: var(--bad);
  }
  .asset {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    background: none;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--fg);
    font-family: var(--mono);
    font-size: 12.5px;
    cursor: pointer;
    text-align: left;
  }
  .asset:hover {
    background: var(--panel-2);
  }
  .asset.playing {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .asset-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .asset-size {
    color: var(--fg-dim);
    flex-shrink: 0;
  }
</style>
