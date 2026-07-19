<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { api, errorText } from "../api";
  import { bench } from "../state.svelte";

  async function openProject() {
    const dir = await open({ directory: true, title: "Open project directory" });
    if (typeof dir !== "string") return;
    try {
      bench.project = await api.openProject(dir);
      bench.selectedScene = bench.project.scenes[0]?.rel_path ?? null;
      bench.messages = [];
      bench.buildStatus = null;
      bench.buildFailed = false;
      bench.loadedAsset = null;
      bench.projectRevision++;
    } catch (error) {
      bench.buildStatus = errorText(error);
      bench.buildFailed = true;
    }
  }

  async function revealOut() {
    if (!bench.project) return;
    const target = bench.project.assets.some((asset) => asset.rel_path.startsWith("out/"))
      ? `${bench.project.root}/out`
      : bench.project.root;
    await revealItemInDir(target).catch(() => {});
  }
</script>

<header class="topbar">
  <div class="brand">
    <span class="brand-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
    <span class="name">scorebench</span>
    {#if bench.project}<span class="project-name" title={bench.project.root}>/ {bench.project.name}</span>{/if}
  </div>

  <div class="actions">
    {#if bench.scorekitPath}
      <span class="scorekit" class:healthy={!bench.versionInfo?.scorekit.warning} class:warn={Boolean(bench.versionInfo?.scorekit.warning)} title={bench.versionInfo?.scorekit.warning ?? bench.scorekitPath}>
        scorekit <i></i>
      </span>
    {:else if bench.scorekitError}
      <span class="scorekit missing" title={bench.scorekitError}>scorekit <i></i></span>
    {/if}
    {#if bench.project}<button class="toolbar-btn" onclick={revealOut}><span>□</span> Open folder</button>{/if}
    <button class="toolbar-btn" onclick={() => (bench.settingsOpen = true)}><span>⚙</span> Settings</button>
    <button class="open-project" onclick={openProject}><span>□</span> Open project…</button>
  </div>
</header>

<style>
  .topbar { display: flex; align-items: center; gap: 16px; height: 52px; padding: 0 12px 0 16px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel-deep) 92%, transparent); box-shadow: 0 8px 22px rgba(0,0,0,.16); }
  .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .brand-wave { display: flex; align-items: center; gap: 3px; height: 27px; padding: 0 5px; border-left: 1px solid var(--accent-line-strong); border-right: 1px solid var(--accent-line-strong); }
  .brand-wave i { display: block; width: 2px; height: 8px; border-radius: 9px; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .brand-wave i:nth-child(2), .brand-wave i:nth-child(4) { height: 17px; }
  .brand-wave i:nth-child(3) { height: 25px; }
  .name { font-size: 16px; font-weight: 450; letter-spacing: .015em; }
  .project-name { max-width: 220px; overflow: hidden; color: var(--fg-muted); font: 11px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .scorekit { display: flex; align-items: center; gap: 7px; height: 29px; padding: 0 12px; color: var(--fg-dim); border: 1px solid var(--line-strong); border-radius: 6px; background: rgba(0,0,0,.14); font: 11px var(--mono); }
  .scorekit i { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-muted); }
  .scorekit.healthy { color: var(--good); border-color: color-mix(in srgb, var(--good) 26%, transparent); }
  .scorekit.healthy i { background: var(--good); box-shadow: 0 0 8px var(--good); }
  .scorekit.warn { color: var(--warning); }
  .scorekit.warn i { background: var(--warning); box-shadow: 0 0 7px var(--warning); }
  .scorekit.missing { color: var(--bad); }
  .scorekit.missing i { background: var(--bad); }
  .toolbar-btn, .open-project { display: flex; align-items: center; justify-content: center; gap: 7px; height: 30px; padding: 0 13px; border-radius: 6px; font-size: 11px; cursor: pointer; }
  .toolbar-btn { color: var(--fg-dim); border: 1px solid var(--line-strong); background: linear-gradient(180deg, rgba(255,255,255,.02), transparent); }
  .toolbar-btn:hover { color: var(--accent); border-color: var(--accent-line-strong); background: var(--accent-soft); }
  .toolbar-btn span { color: var(--accent); }
  .open-project { color: var(--warning); border: 1px solid color-mix(in srgb, var(--warning) 60%, transparent); background: linear-gradient(135deg, color-mix(in srgb, var(--warning) 12%, transparent), transparent); box-shadow: inset 0 0 12px color-mix(in srgb, var(--warning) 6%, transparent), 0 0 12px color-mix(in srgb, var(--warning) 8%, transparent); }
  .open-project:hover { color: #151005; background: var(--warning); box-shadow: 0 0 18px color-mix(in srgb, var(--warning) 25%, transparent); }
  @media (max-width: 1040px) { .project-name { display: none; } .toolbar-btn, .open-project { padding: 0 9px; } }
</style>
