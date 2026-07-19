<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import {
    api,
    errorText,
    type AssetEntry,
    type BuildEvent,
    type BuildParams,
    type SceneInspection,
  } from "../api";
  import { t } from "../i18n.svelte";
  import { bench } from "../state.svelte";

  let tab = $state<"observe" | "render" | "outputs">("observe");
  let renderer = $state("fluidsynth");
  let sampleRate = $state(44100);
  let gain = $state(0.8);
  let quality = $state(5);
  let stems = $state(false);
  let format = $state<"ogg" | "wav">("ogg");
  let profilePath = $state<string | null>(null);
  let renderConfigRoot: string | null = null;
  let inspection = $state<SceneInspection | null>(null);
  let inspectionError = $state<string | null>(null);
  let inspectionSeq = 0;
  let selectedAsset = $state<string | null>(null);
  let meta = $state<Record<string, unknown> | null>(null);
  let metaError = $state<string | null>(null);

  const GAUGES = [
    { key: "gauge.density", words: ["Sparse", "Balanced", "Dense"] },
    { key: "gauge.dynamics", words: ["Flat", "Expressive", "Wild"] },
    { key: "gauge.complexity", words: ["Simple", "Layered", "Intricate"] },
    { key: "gauge.energy", words: ["Calm", "Driving", "Intense"] },
  ] as const;

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

  // Load the persisted render selection (bench.json) once per project so the
  // agent and the render panel agree on renderer + profile.
  $effect(() => {
    const root = bench.project?.root;
    if (!root || root === renderConfigRoot) return;
    renderConfigRoot = root;
    void api.loadRenderConfig(root).then(
      ([config]) => {
        if (renderConfigRoot !== root || !config) return;
        if (config.renderer) renderer = config.renderer;
        profilePath = config.profile
          ? config.profile.startsWith("/")
            ? config.profile
            : `${root}/${config.profile}`
          : null;
      },
      () => {},
    );
  });

  function persistRenderConfig() {
    const root = bench.project?.root;
    if (!root) return;
    const profile =
      profilePath && profilePath.startsWith(root + "/")
        ? profilePath.slice(root.length + 1)
        : profilePath;
    void api.saveRenderConfig(root, { renderer, profile }).catch(() => {});
  }

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

  function gaugeWord(index: number): string {
    const value = profile[index];
    const words = GAUGES[index].words;
    return value < 34 ? words[0] : value < 67 ? words[1] : words[2];
  }

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

  const needsProfile = $derived(renderer === "sfizz" && !profilePath);

  async function pickProfile() {
    const picked = await open({
      multiple: false,
      directory: false,
      defaultPath: bench.project?.root,
      filters: [{ name: "Render profile", extensions: ["yaml", "yml"] }],
    });
    if (typeof picked === "string") {
      profilePath = picked;
      persistRenderConfig();
    }
  }

  async function render() {
    if (!bench.project || !bench.selectedScene || bench.building || needsProfile) return;
    bench.building = true;
    bench.buildFailed = false;
    bench.buildStatus = "starting…";
    const params: BuildParams = { renderer, sample_rate: sampleRate, gain, quality, stems };
    if (renderer === "sfizz" && profilePath) {
      // Absolute path: the scorekit subprocess does not run from the project root.
      params.profile = profilePath;
    }
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
  <nav class="tabs">
    <button class:active={tab === "observe"} onclick={() => (tab = "observe")} aria-pressed={tab === "observe"}>
      {t("panel.observe")}
      {#if inspection}<i class="dot {inspection.validation.status}" aria-hidden="true"></i>{/if}
    </button>
    <button class:active={tab === "render"} onclick={() => (tab = "render")} aria-pressed={tab === "render"}>
      {t("panel.render")}
      {#if bench.building}<i class="dot busy" aria-hidden="true"></i>{:else if bench.buildFailed}<i class="dot invalid" aria-hidden="true"></i>{/if}
    </button>
    <button class:active={tab === "outputs"} onclick={() => (tab = "outputs")} aria-pressed={tab === "outputs"}>
      {t("panel.outputs")}
      {#if audioAssets.length}<em>{audioAssets.length}</em>{/if}
    </button>
  </nav>

  {#if tab === "observe"}
    <section class="module gauges-module">
      <header class="module-head"><h2>{t("panel.profileTitle")}</h2></header>
      <div class="gauge-grid">
        {#each GAUGES as gauge, index}
          <div class="gauge">
            <span class="dial" style={`--value: ${profile[index]}; --gauge-shift: ${index * 38}`}>
              <strong>{profile[index]}<small>%</small></strong>
            </span>
            <b>{t(gauge.key)}</b>
            <em>{inspection?.scene ? gaugeWord(index) : "—"}</em>
          </div>
        {/each}
      </div>
    </section>

    <section class="module overview">
      <header class="module-head">
        <h2>{t("panel.sceneSignal")}</h2>
        {#if inspection}
          <span class="badge {inspection.validation.status}">{inspection.validation.status}</span>
        {/if}
        <button class="mini" onclick={refreshProject}>{t("panel.refresh")}</button>
      </header>
      {#if inspectionError}
        <p class="status failed">{inspectionError}</p>
      {:else if !bench.selectedScene}
        <p class="empty">{t("panel.selectScene")}</p>
      {:else if !inspection}
        <p class="empty scanning">{t("panel.reading")}</p>
      {:else if inspection.parse_error}
        <p class="status failed">{t("panel.unparseable")} · {inspection.parse_error}</p>
      {:else if inspection.scene}
        <div class="facts">
          <span class="wide"><b>{t("panel.title")}</b>{inspection.scene.title ?? t("panel.untitled")}</span>
          <span><b>{t("panel.tempo")}</b>{inspection.scene.tempo ?? "—"} BPM</span>
          <span><b>{t("panel.key")}</b>{inspection.scene.key ?? "—"}</span>
          <span><b>{t("panel.meter")}</b>{inspection.scene.time_signature ?? "—"}</span>
          <span><b>{t("panel.bars")}</b>{inspection.scene.bars ?? "—"}</span>
          <span><b>{t("panel.loop")}</b>{inspection.scene.loop_enabled == null ? "—" : inspection.scene.loop_enabled ? t("panel.yes") : t("panel.no")}</span>
          <span><b>{t("panel.performance")}</b>{inspection.scene.has_performance ? t("panel.present") : t("panel.default")}</span>
        </div>
        {#if inspection.scene.story}
          <details class="scene-detail story" open>
            <summary>{t("panel.story")}</summary>
            <p class="story-text">{inspection.scene.story}</p>
          </details>
        {/if}
        {#if inspection.scene.tracks.length}
          <details class="scene-detail">
            <summary>{t("panel.tracksSections", { tracks: inspection.scene.tracks.length, sections: inspection.scene.sections.length })}</summary>
            <ul>
              {#each inspection.scene.tracks as track, index}
                <li><strong>{index + 1}. {track.instrument ?? "unknown"}</strong><span>{track.pattern ?? "—"}</span></li>
              {/each}
            </ul>
          </details>
        {/if}
        {#if inspection.last_diff}
          <details class="scene-detail diff">
            <summary>{t("panel.lastChange")}</summary>
            <pre>{JSON.stringify(inspection.last_diff, null, 2)}</pre>
          </details>
        {/if}
        {#if inspection.render_profile}
          {#if inspection.render_profile.error}
            <p class="status failed">{t("panel.profileUnusable", { error: inspection.render_profile.error })}</p>
          {:else if inspection.render_profile.unmapped.length}
            <p class="status failed">{t("panel.profileUnmapped", {
              profile: inspection.render_profile.profile_name ?? inspection.render_profile.profile,
              instruments: inspection.render_profile.unmapped.join(", "),
            })}</p>
          {/if}
        {/if}
        {#if inspection.validation.error}<p class="status failed">{errorText(inspection.validation.error)}</p>{/if}
      {/if}
    </section>
  {:else if tab === "render"}
    <section class="module render-module">
      <header class="module-head">
        <h2>{t("panel.renderControls")}</h2>
        {#if bench.selectedScene}
          <span class="scene-chip" title={bench.selectedScene}>{bench.selectedScene.split("/").at(-1)}</span>
        {/if}
      </header>
      <div class="params">
        <label><span>{t("panel.renderer")}</span><select bind:value={renderer} onchange={persistRenderConfig} disabled={bench.building}><option value="fluidsynth">fluidsynth</option><option value="timidity">timidity</option><option value="sfizz">sfizz</option></select></label>
        <label><span>{t("panel.sampleRate")}</span><select bind:value={sampleRate} disabled={bench.building}><option value={44100}>44100 Hz</option><option value={48000}>48000 Hz</option></select></label>
        <label><span>{t("panel.format")}</span><select bind:value={format} disabled={bench.building}><option value="ogg">OGG</option><option value="wav">WAV</option></select></label>
        <label><span>{t("panel.gain")}</span><input type="number" min="0" max="2" step="0.05" bind:value={gain} disabled={bench.building} /></label>
        <label><span>{t("panel.quality")}</span><input type="number" min="0" max="10" step="1" bind:value={quality} disabled={bench.building} /></label>
        <label class="check"><input type="checkbox" bind:checked={stems} disabled={bench.building} /><span>{t("panel.stems")}</span></label>
      </div>
      {#if renderer === "sfizz"}
        <div class="profile-row">
          <button class="profile-pick" onclick={pickProfile} disabled={bench.building}>
            {#if profilePath}
              <strong title={profilePath}>{profilePath.split("/").at(-1)}</strong>
            {:else}
              <span>{t("panel.chooseProfile")}</span>
            {/if}
          </button>
          {#if profilePath}
            <button class="profile-clear" onclick={() => { profilePath = null; persistRenderConfig(); }} disabled={bench.building} aria-label="Clear profile">×</button>
          {/if}
        </div>
        {#if needsProfile}
          <p class="profile-hint">{t("panel.profileHint")}</p>
        {/if}
      {/if}
      {#if renderer === "sfizz" && inspection?.render_profile}
        {#if inspection.render_profile.error}
          <p class="status failed">{t("panel.profileUnusable", { error: inspection.render_profile.error })}</p>
        {:else if inspection.render_profile.unmapped.length}
          <p class="status failed">{t("panel.profileUnmapped", {
            profile: inspection.render_profile.profile_name ?? inspection.render_profile.profile,
            instruments: inspection.render_profile.unmapped.join(", "),
          })}</p>
        {/if}
      {/if}
      <button class="render-btn" onclick={render} disabled={!bench.project || !bench.selectedScene || bench.building || needsProfile}>
        <span class="render-glyph">▮▮▮</span>{bench.building ? t("panel.rendering") : t("panel.renderBtn")}
      </button>
      {#if bench.building}<div class="progress" role="progressbar" aria-label="rendering"><div></div></div>{/if}
      {#if bench.buildStatus}<p class="status" class:failed={bench.buildFailed}>{bench.buildStatus}</p>{/if}
    </section>
  {:else}
    <section class="module assets-module">
      <header class="module-head"><h2>{t("panel.currentOutputs")}</h2><span class="count">{audioAssets.length}</span></header>
      {#if audioAssets.length === 0}
        <p class="empty">{t("panel.nothingRendered")}</p>
      {:else}
        <ul class="asset-list">
          {#each audioAssets as asset}
            <li class:selected={selectedAsset === asset.rel_path}>
              <button class="asset-main" onclick={() => selectAsset(asset)} title={t("panel.loadIntoPlayer")}>
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
      <button class="open-output" onclick={revealOut}><span>□</span> {t("panel.openOutput")}</button>
    </section>
  {/if}
</div>

<style>
  .panel { display: flex; min-height: 0; flex-direction: column; gap: 8px; height: 100%; overflow-y: auto; }

  .tabs {
    display: flex;
    flex-shrink: 0;
    gap: 3px;
    padding: 3px;
    border: 1px solid var(--accent-line);
    border-radius: 9px;
    background: var(--panel-glass);
    box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255,255,255,.022);
  }
  .tabs button {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 27px;
    color: var(--fg-label);
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    font-size: var(--ui-label-size);
    font-weight: var(--ui-label-weight);
    letter-spacing: var(--ui-label-tracking);
    text-transform: uppercase;
    cursor: pointer;
    transition: color .15s ease, background .15s ease;
  }
  .tabs button:hover { color: var(--fg); }
  .tabs button.active {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: linear-gradient(180deg, var(--accent-soft), transparent 80%);
    box-shadow: 0 0 10px var(--accent-soft), inset 0 1px 0 rgba(255,255,255,.04);
  }
  .dot { width: 5px; height: 5px; border-radius: 50%; }
  .dot.valid { background: var(--good); box-shadow: 0 0 6px var(--good); }
  .dot.invalid { background: var(--bad); box-shadow: 0 0 6px var(--bad); }
  .dot.unavailable { background: var(--warning); box-shadow: 0 0 6px var(--warning); }
  .dot.busy { background: var(--warning); box-shadow: 0 0 6px var(--warning); animation: pulse .8s ease-in-out infinite alternate; }
  .tabs em { color: var(--fg-dim); font: 10px var(--mono); font-style: normal; }

  .module {
    border: 1px solid var(--accent-line);
    border-radius: var(--radius-lg);
    background: var(--panel-glass);
    box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255,255,255,.022);
    overflow: hidden;
    flex-shrink: 0;
  }
  .module-head { display: flex; align-items: center; min-height: 32px; padding: 0 10px; border-bottom: 1px solid var(--line); background: linear-gradient(90deg, var(--accent-soft), transparent 70%); }
  h2 { margin: 0; color: var(--accent); font-size: 12px; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
  .mini { margin-left: auto; padding: 3px 7px; color: var(--fg-label); background: transparent; border: 1px solid var(--line-strong); border-radius: 4px; font-size: 11px; cursor: pointer; }
  .mini:hover { color: var(--accent); border-color: var(--accent-line-strong); }
  .badge { margin-left: 7px; padding: 2px 5px; border-radius: 2px; font: 9px var(--mono); text-transform: uppercase; }
  .badge.valid { color: var(--good); background: color-mix(in srgb, var(--good) 12%, transparent); }
  .badge.invalid { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
  .badge.unavailable { color: var(--warning); background: color-mix(in srgb, var(--warning) 12%, transparent); }
  .scene-chip { margin-left: auto; overflow: hidden; max-width: 55%; padding: 2px 6px; color: var(--fg-dim); border: 1px solid var(--line-strong); border-radius: 8px; font: 9px var(--mono); text-overflow: ellipsis; white-space: nowrap; }

  .gauge-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 8px; padding: 13px 10px 12px; }
  .gauge { display: grid; justify-items: center; gap: 3px; }
  .gauge > b { color: var(--fg-label); font-size: var(--ui-label-size); font-weight: 700; letter-spacing: var(--ui-label-tracking); text-transform: uppercase; }
  .gauge > em { color: var(--accent); font: italic 10px var(--mono); opacity: .85; }
  .dial {
    --gauge-color: hsl(calc(var(--theme-hue) + var(--gauge-shift)) 82% 62%);
    position: relative;
    display: grid;
    place-items: center;
    width: 68px;
    height: 68px;
    border-radius: 50%;
    background: conic-gradient(
      from 225deg,
      var(--gauge-color) calc(var(--value) * .75%),
      hsl(var(--theme-hue) 18% 26% / .4) 0 75%,
      transparent 0
    );
    box-shadow: 0 0 16px color-mix(in srgb, var(--gauge-color) 16%, transparent);
    transition: box-shadow .3s ease;
  }
  .dial::after {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    background: repeating-conic-gradient(from 225deg, var(--line-strong) 0 1.4deg, transparent 1.4deg 15deg);
    -webkit-mask: radial-gradient(circle, transparent 59%, #000 60% 67%, transparent 68%);
    mask: radial-gradient(circle, transparent 59%, #000 60% 67%, transparent 68%);
    opacity: .8;
  }
  .dial::before {
    content: "";
    grid-area: 1 / 1;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: radial-gradient(circle at 36% 30%, hsl(var(--theme-hue) 22% 12%), var(--panel-deep) 72%);
    box-shadow: inset 0 1px 4px rgba(0,0,0,.5), inset 0 -1px 0 rgba(255,255,255,.03);
  }
  .dial strong { z-index: 1; grid-area: 1 / 1; color: var(--fg); font: 14px var(--mono); font-weight: 400; }
  .dial small { color: var(--fg-muted); font-size: 10px; }

  .facts { display: grid; grid-template-columns: repeat(2, 1fr); }
  .facts span { min-width: 0; padding: 7px 9px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); color: var(--fg); font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .facts span:nth-child(even), .facts .wide { border-right: 0; }
  .facts .wide { grid-column: 1 / -1; }
  .facts b, .meta-grid b { display: block; margin-bottom: 3px; color: var(--fg-label); font: var(--ui-label-size) var(--sans); font-weight: var(--ui-label-weight); letter-spacing: var(--ui-label-tracking); text-transform: uppercase; }
  .empty, .status { margin: 0; padding: 10px; color: var(--fg-dim); font: 11px var(--mono); line-height: 1.45; overflow-wrap: anywhere; }
  .scanning { animation: pulse 1.3s ease-in-out infinite alternate; }
  .status.failed { color: var(--bad); }
  .scene-detail { margin: 6px 8px 8px; color: var(--fg-dim); font: 10px var(--mono); }
  .scene-detail summary { cursor: pointer; }
  .scene-detail ul { display: grid; gap: 3px; margin: 6px 0 0; padding: 0; list-style: none; }
  .scene-detail li { display: flex; justify-content: space-between; gap: 8px; }
  .scene-detail li strong { color: var(--fg); font-weight: 500; }
  .scene-detail pre { max-height: 120px; overflow: auto; white-space: pre-wrap; font: 10px var(--mono); }
  .story-text { max-height: 110px; margin: 6px 0 0; overflow-y: auto; color: var(--fg-dim); font-size: 12px; line-height: 1.55; white-space: pre-wrap; }

  .params { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; padding: 10px; }
  .params label { display: grid; min-width: 0; gap: 3px; }
  .params label > span { color: var(--fg-label); font-size: var(--ui-label-size); font-weight: var(--ui-label-weight); letter-spacing: var(--ui-label-tracking); text-transform: uppercase; }
  .params select, .params input[type="number"] { box-sizing: border-box; min-width: 0; width: 100%; height: 26px; padding: 3px 7px; color: var(--fg); background: var(--control-bg); border: 1px solid var(--line-strong); border-radius: 5px; font: 11px var(--mono); }
  .params select:focus, .params input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .params .check { display: flex; align-items: center; gap: 5px; padding-top: 11px; }
  .params input[type="checkbox"] { accent-color: var(--accent); }
  .profile-row { display: flex; gap: 6px; margin: -2px 10px 8px; }
  .profile-pick { display: flex; flex: 1; align-items: center; min-width: 0; height: 28px; padding: 0 10px; color: var(--fg); background: var(--panel-glass); border: 1px solid var(--accent-line); border-radius: 6px; font: 11px var(--mono); cursor: pointer; transition: border-color .15s ease, background .15s ease; }
  .profile-pick:hover:not(:disabled) { border-color: var(--accent-line-strong); background: var(--accent-soft); }
  .profile-pick strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .profile-pick span { color: var(--fg-label); }
  .profile-clear { width: 28px; height: 28px; color: var(--fg-label); background: transparent; border: 1px solid var(--line); border-radius: 6px; font-size: 14px; cursor: pointer; transition: color .15s ease, border-color .15s ease; }
  .profile-clear:hover:not(:disabled) { color: var(--danger, #e5484d); border-color: color-mix(in srgb, var(--danger, #e5484d) 55%, transparent); }
  .profile-hint { margin: -2px 10px 8px; color: var(--warning); font-size: 11px; line-height: 1.4; }
  .render-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: calc(100% - 20px); height: 32px; margin: 0 10px 10px; color: var(--warning); background: linear-gradient(110deg, color-mix(in srgb, var(--warning) 12%, transparent), transparent); border: 1px solid color-mix(in srgb, var(--warning) 65%, transparent); border-radius: 6px; box-shadow: inset 0 0 12px color-mix(in srgb, var(--warning) 7%, transparent), 0 0 10px color-mix(in srgb, var(--warning) 8%, transparent), inset 0 1px 0 rgba(255,255,255,.05); font-size: 12px; font-weight: 700; cursor: pointer; transition: background .15s ease, color .15s ease, box-shadow .15s ease; }
  .render-btn:hover:not(:disabled) { color: #171004; background: var(--warning); box-shadow: 0 0 16px color-mix(in srgb, var(--warning) 32%, transparent); }
  .render-btn:active:not(:disabled) { transform: translateY(1px); }
  .render-btn:disabled { opacity: .4; cursor: default; }
  .render-glyph { font-size: 9px; letter-spacing: 1px; transform: rotate(90deg); }
  .progress { height: 2px; margin: -4px 10px 8px; overflow: hidden; background: var(--line); }
  .progress div { width: 38%; height: 100%; background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: sweep 1.1s ease-in-out infinite alternate; }

  .count { margin-left: auto; color: var(--fg-dim); font: 10px var(--mono); }
  .asset-list { margin: 0; padding: 5px 8px; list-style: none; }
  .asset-list li { border-bottom: 1px solid var(--line); }
  .asset-list li:last-child { border: 0; }
  .asset-list li.selected { background: var(--accent-soft); }
  .asset-main { display: grid; grid-template-columns: minmax(0, 1fr) auto 22px; align-items: center; gap: 8px; width: 100%; padding: 7px 4px; color: var(--fg); background: transparent; border: 0; text-align: left; cursor: pointer; }
  .asset-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px var(--mono); font-weight: 550; }
  .asset-main span { color: var(--fg-dim); font: 10px var(--mono); }
  .asset-main i { display: grid; place-items: center; width: 18px; height: 18px; color: var(--accent); border: 1px solid var(--accent-line-strong); border-radius: 50%; font: normal 8px var(--sans); }
  .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); margin: 0 8px 7px; border: 1px solid var(--line); }
  .meta-grid span { padding: 5px 6px; color: var(--fg); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); font: 10px var(--mono); }
  .open-output { width: calc(100% - 16px); margin: 0 8px 8px; padding: 6px; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 4px; font-size: 11px; cursor: pointer; transition: box-shadow .15s ease; }
  .open-output:hover { box-shadow: 0 0 10px var(--accent-soft); }

  @keyframes pulse { from { opacity: .45; } to { opacity: 1; } }
  @keyframes sweep { from { transform: translateX(-60%); } to { transform: translateX(260%); } }
  @media (prefers-reduced-motion: reduce) { .scanning, .progress div, .dot.busy { animation: none; } }
</style>
