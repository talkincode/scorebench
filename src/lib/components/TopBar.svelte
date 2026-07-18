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
      bench.messages = [];
      bench.buildStatus = null;
      bench.buildFailed = false;
      bench.loadedAsset = null;
    } catch (err) {
      bench.buildStatus = errorText(err);
      bench.buildFailed = true;
    }
  }

  async function revealOut() {
    if (!bench.project) return;
    // Reveal out/ when it exists, otherwise the project root itself.
    const target = bench.project.assets.find((a) => a.rel_path.startsWith("out/"))
      ? `${bench.project.root}/out`
      : bench.project.root;
    await revealItemInDir(target).catch(() => {});
  }
</script>

<header class="topbar">
  <div class="brand">
    <span class="logo">◳</span>
    <span class="name">scorebench</span>
  </div>

  <div class="project">
    {#if bench.project}
      <span class="project-name" title={bench.project.root}>{bench.project.name}</span>
    {:else}
      <span class="project-none">no project open</span>
    {/if}
  </div>

  <div class="actions">
    {#if bench.scorekitPath}
      <span class="chip ok" title={bench.scorekitPath}>scorekit ✓</span>
    {:else if bench.scorekitError}
      <span class="chip err" title={bench.scorekitError}>scorekit missing</span>
    {/if}
    {#if bench.project}
      <button class="ghost" onclick={revealOut} title="Reveal output directory">Open folder</button>
    {/if}
    <button class="primary" onclick={openProject}>Open project…</button>
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 52px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 650;
    letter-spacing: 0.02em;
  }
  .logo {
    color: var(--accent);
    font-size: 18px;
  }
  .project {
    flex: 1;
    min-width: 0;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-name {
    color: var(--fg);
    font-weight: 550;
  }
  .project-none {
    color: var(--fg-dim);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .chip {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
  }
  .chip.ok {
    color: var(--good);
    border-color: color-mix(in srgb, var(--good) 40%, transparent);
  }
  .chip.err {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 40%, transparent);
  }
</style>
