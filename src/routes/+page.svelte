<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import TopBar from "$lib/components/TopBar.svelte";
  import Chat from "$lib/components/Chat.svelte";
  import SceneRail from "$lib/components/SceneRail.svelte";
  import ScenePanel from "$lib/components/ScenePanel.svelte";
  import SceneSource from "$lib/components/SceneSource.svelte";
  import ScenePreview from "$lib/components/ScenePreview.svelte";
  import Player from "$lib/components/Player.svelte";
  import SettingsModal from "$lib/components/SettingsModal.svelte";
  import { api, errorText } from "$lib/api";
  import { setLocale, t } from "$lib/i18n.svelte";
  import { bench } from "$lib/state.svelte";

  onMount(() => {
    const boot = document.getElementById("boot");
    if (boot) {
      boot.classList.add("done");
      window.setTimeout(() => boot.remove(), 340);
    }
    const unlisten = listen<{ root: string }>("project-changed", async (event) => {
      if (!bench.project || event.payload.root !== bench.project.root) return;
      try {
        bench.project = await api.refreshProject(bench.project.root);
        bench.projectRevision++;
      } catch (error) {
        bench.buildFailed = true;
        bench.buildStatus = errorText(error);
      }
    });
    void Promise.all([
      api.versionInfo().then(
        (info) => {
          bench.versionInfo = info;
          bench.scorekitPath = info.scorekit.path ?? null;
          bench.scorekitError = info.scorekit.ready ? null : (info.scorekit.warning ?? "scorekit unhealthy");
        },
        (error) => (bench.scorekitError = errorText(error)),
      ),
      api.getSettings().then(
        (view) => {
          bench.settings = view.settings;
          bench.apiKeySet = view.api_key_set;
          bench.settingsWarning = view.warning ?? null;
          setLocale(view.settings.locale);
        },
        (error) => (bench.settingsWarning = errorText(error)),
      ),
    ]);
    return () => void unlisten.then((stop) => stop());
  });

  function sceneLabel(): string {
    return bench.selectedScene?.split("/").at(-1) ?? t("tabs.source");
  }

  // Scene/preview tabs need a selected scene; fall back to the agent view.
  $effect(() => {
    if (!bench.selectedScene && bench.workspaceTab !== "agent") bench.workspaceTab = "agent";
  });
</script>

<div class="theme-root" style={`--theme-hue: ${bench.themeHuePreview ?? bench.settings?.theme_hue ?? 171}`}>
  <div class="app">
    <TopBar />
    {#if bench.versionInfo && (!bench.versionInfo.scorekit.found || !bench.versionInfo.scorekit.ready)}
      <div class="first-run" role="status">
        <strong>{t("setup.required")}</strong>
        <span>{bench.versionInfo.scorekit.warning ?? t("setup.notReady")}</span>
        {#if bench.versionInfo.scorekit.hints.length}<span class="hint">{bench.versionInfo.scorekit.hints.join(" · ")}</span>{/if}
      </div>
    {/if}

    {#if bench.project}
      <main class="workbench">
        <SceneRail />
        <section class="center-stage">
          <nav class="workspace-tabs" aria-label="Workspace views">
            <button
              class="tab"
              class:active={bench.workspaceTab === "agent"}
              onclick={() => (bench.workspaceTab = "agent")}
              aria-pressed={bench.workspaceTab === "agent"}
            >
              <i>⌁</i> {t("tabs.agent")} {#if bench.agentBusy}<b class="live">◆</b>{/if}
            </button>
            <button
              class="tab"
              class:active={bench.workspaceTab === "scene"}
              onclick={() => (bench.workspaceTab = "scene")}
              aria-pressed={bench.workspaceTab === "scene"}
              disabled={!bench.selectedScene}
            >
              <i>◇</i> {sceneLabel()}
            </button>
            <button
              class="tab muted"
              class:active={bench.workspaceTab === "preview"}
              onclick={() => (bench.workspaceTab = "preview")}
              aria-pressed={bench.workspaceTab === "preview"}
              disabled={!bench.selectedScene}
            >
              <i>▶</i> {t("tabs.preview")}
            </button>
          </nav>
          <div class="chat-frame">
            <div class="workspace-pane" class:hidden={bench.workspaceTab !== "agent"}><Chat /></div>
            {#if bench.workspaceTab === "scene"}
              <div class="workspace-pane"><SceneSource /></div>
            {:else if bench.workspaceTab === "preview"}
              <div class="workspace-pane"><ScenePreview /></div>
            {/if}
          </div>
        </section>
        <aside class="inspector"><ScenePanel /></aside>
      </main>
    {:else}
      <div class="welcome">
        <div class="welcome-signal" aria-hidden="true"><span></span><span></span><span></span><i>▮▮▮</i></div>
        <div class="welcome-card">
          <p class="eyebrow">{t("welcome.eyebrow")}</p>
          <h1>Compose in the <em>signal</em>.</h1>
          <p>{t("welcome.body")}</p>
          {#if bench.scorekitError}<p class="warn">{bench.scorekitError}</p>{/if}
          <p class="cta"><strong>{t("welcome.ctaButton")}</strong> {t("welcome.cta")}</p>
        </div>
      </div>
    {/if}

    <Player />
  </div>
  <SettingsModal />
</div>

<style>
  :global(:root) { color-scheme: dark; }
  :global(*) { box-sizing: border-box; }
  :global(html, body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: #020706;
    color: #d8e5e1;
    font-family: "Avenir Next", "Segoe UI", sans-serif;
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
  }
  :global(button), :global(input), :global(select), :global(textarea) { font: inherit; }
  :global(button:focus-visible), :global(input:focus-visible), :global(select:focus-visible), :global(textarea:focus-visible) {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }
  :global(::selection) { color: var(--bg); background: var(--accent); }
  :global(::-webkit-scrollbar) { width: 6px; height: 6px; }
  :global(::-webkit-scrollbar-track) { background: transparent; }
  :global(::-webkit-scrollbar-thumb) { background: var(--line-strong); border-radius: 9px; }
  :global(button.primary) {
    padding: 8px 15px;
    color: #171004;
    border: 1px solid color-mix(in srgb, var(--warning) 70%, white);
    border-radius: 6px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--warning) 78%, white), var(--warning));
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.16), 0 0 16px color-mix(in srgb, var(--warning) 16%, transparent);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .02em;
    cursor: pointer;
  }
  :global(button.primary:hover:not(:disabled)) { filter: brightness(1.12); box-shadow: 0 0 22px color-mix(in srgb, var(--warning) 28%, transparent); }
  :global(button.primary:disabled) { opacity: .35; cursor: default; }
  :global(button.ghost) {
    padding: 7px 12px;
    color: var(--fg-dim);
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: linear-gradient(180deg, rgba(255,255,255,.018), transparent);
    font-size: 11px;
    cursor: pointer;
  }
  :global(button.ghost:hover) { color: var(--accent); border-color: var(--accent-line-strong); background: var(--accent-soft); }
  :global(button.primary:active:not(:disabled)), :global(button.ghost:active) { transform: translateY(1px); }

  .theme-root :global(select) {
    appearance: none;
    -webkit-appearance: none;
    padding-right: 22px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='7' height='5'%3E%3Cpath d='M0 0l3.5 5L7 0z' fill='%2352615d'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    cursor: pointer;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .theme-root :global(select:hover) { border-color: var(--accent-line-strong); }
  .theme-root :global(select:focus) { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }

  .theme-root :global(input[type="range"]) {
    appearance: none;
    -webkit-appearance: none;
    height: 3px;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--accent-dim), var(--line-strong));
    cursor: pointer;
  }
  .theme-root :global(input[type="range"]::-webkit-slider-thumb) {
    appearance: none;
    -webkit-appearance: none;
    width: 11px;
    height: 11px;
    border: 1px solid var(--accent-line-strong);
    border-radius: 50%;
    background: radial-gradient(circle at 36% 30%, color-mix(in srgb, var(--accent) 55%, var(--panel-deep)), var(--panel-deep) 78%);
    box-shadow: 0 0 8px var(--accent-soft), inset 0 1px 0 rgba(255,255,255,.14);
    transition: box-shadow .15s ease;
  }
  .theme-root :global(input[type="range"]:hover::-webkit-slider-thumb) { box-shadow: 0 0 12px var(--accent-glow); }

  .theme-root {
    --bg: #020706;
    --panel-deep: #040b0a;
    --panel: #07100f;
    --panel-glass: hsl(var(--theme-hue) 28% 6% / .91);
    --panel-raised: hsl(var(--theme-hue) 24% 10% / .88);
    --panel-2: var(--panel-raised);
    --control-bg: hsl(var(--theme-hue) 26% 5% / .95);
    --line: hsl(var(--theme-hue) 35% 28% / .22);
    --line-strong: hsl(var(--theme-hue) 40% 44% / .32);
    --accent: hsl(var(--theme-hue) 78% 59%);
    --accent-dim: hsl(var(--theme-hue) 52% 42%);
    --accent-soft: hsl(var(--theme-hue) 75% 55% / .075);
    --accent-line: hsl(var(--theme-hue) 78% 55% / .27);
    --accent-line-strong: hsl(var(--theme-hue) 82% 62% / .62);
    --accent-glow: hsl(var(--theme-hue) 88% 58% / .32);
    --fg: #dbe7e3;
    --fg-dim: #84928e;
    --fg-muted: #52615d;
    --warning: #f2b946;
    --good: #62d184;
    --bad: #f06f62;
    --mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
    --sans: "Avenir Next", "Segoe UI", sans-serif;
    --radius-lg: 9px;
    --panel-shadow: 0 12px 30px rgba(0, 0, 0, .18), 0 0 22px hsl(var(--theme-hue) 70% 35% / .025);
    position: relative;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    color: var(--fg);
    background:
      radial-gradient(ellipse at 47% -14%, hsl(var(--theme-hue) 72% 28% / .16), transparent 42%),
      linear-gradient(180deg, hsl(var(--theme-hue) 25% 5%), var(--bg));
  }
  .theme-root::before {
    content: "";
    position: absolute;
    z-index: 0;
    inset: 0;
    pointer-events: none;
    opacity: .32;
    background-image:
      linear-gradient(hsl(var(--theme-hue) 70% 55% / .025) 1px, transparent 1px),
      linear-gradient(90deg, hsl(var(--theme-hue) 70% 55% / .02) 1px, transparent 1px);
    background-size: 24px 24px;
    mask-image: linear-gradient(to bottom, #000, transparent 70%);
  }
  .app {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
  }
  .first-run {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 30px;
    padding: 5px 14px;
    color: var(--bad);
    border-bottom: 1px solid color-mix(in srgb, var(--bad) 25%, var(--line));
    background: color-mix(in srgb, var(--bad) 6%, var(--panel-deep));
    font-size: 11px;
  }
  .first-run strong { letter-spacing: .06em; text-transform: uppercase; }
  .first-run .hint { margin-left: auto; color: var(--fg-muted); font-family: var(--mono); }
  .workbench {
    flex: 1;
    display: grid;
    grid-template-columns: 248px minmax(380px, 1fr) 342px;
    gap: 8px;
    min-height: 0;
    padding: 8px 8px 6px;
  }
  .center-stage { display: flex; min-width: 0; min-height: 0; flex-direction: column; }
  .workspace-tabs { display: flex; min-height: 36px; align-items: flex-end; gap: 2px; padding: 0 3px; }
  .tab { display: flex; align-items: center; gap: 7px; min-width: 122px; max-width: 180px; height: 32px; padding: 0 13px; overflow: hidden; color: var(--fg-dim); border: 1px solid var(--line); border-bottom: 0; border-radius: 7px 7px 0 0; background: color-mix(in srgb, var(--panel) 88%, transparent); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; transition: color .15s ease, background .15s ease; }
  .tab:hover:not(:disabled):not(.active) { color: var(--fg); background: color-mix(in srgb, var(--panel-raised) 92%, transparent); }
  .tab:disabled { opacity: .45; cursor: default; }
  .tab i { color: var(--accent); font-style: normal; }
  .tab b.live { margin-left: auto; color: var(--good); font-size: 8px; animation: blink 1.2s ease-in-out infinite alternate; }
  .tab.active { position: relative; color: var(--accent); border-color: var(--accent-line-strong); background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 14%, var(--panel)), var(--panel)); box-shadow: 0 -6px 18px color-mix(in srgb, var(--accent) 8%, transparent); }
  .tab.active::after { content: ""; position: absolute; right: 0; bottom: -1px; left: 0; height: 1px; background: var(--panel-deep); }
  .tab.muted { min-width: 95px; }
  @keyframes blink { from { opacity: .35; } to { opacity: 1; } }
  .chat-frame { position: relative; flex: 1; min-height: 0; border: 1px solid var(--accent-line); border-radius: var(--radius-lg); background: var(--panel-glass); box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255,255,255,.025); overflow: hidden; }
  .workspace-pane { position: absolute; inset: 0; }
  .workspace-pane.hidden { visibility: hidden; pointer-events: none; }
  .inspector { min-width: 0; min-height: 0; }
  .welcome { flex: 1; display: grid; place-items: center; align-content: center; gap: 28px; text-align: center; }
  .welcome-signal { position: relative; display: grid; place-items: center; width: 136px; height: 136px; }
  .welcome-signal span { position: absolute; inset: 0; border: 1px solid var(--accent-line-strong); border-radius: 50%; box-shadow: inset 0 0 24px var(--accent-soft), 0 0 24px var(--accent-soft); animation: breathe 3.8s ease-in-out infinite alternate; }
  .welcome-signal span:nth-child(2) { inset: 17px; border-style: dashed; animation-direction: alternate-reverse; }
  .welcome-signal span:nth-child(3) { inset: 36px; border-color: var(--accent); }
  .welcome-signal i { z-index: 1; color: var(--accent); font-style: normal; letter-spacing: 5px; text-shadow: 0 0 15px var(--accent); transform: rotate(90deg); }
  .welcome-card { max-width: 520px; padding: 0 26px; }
  .eyebrow { margin: 0 0 8px; color: var(--accent); font: 11px var(--mono); letter-spacing: .18em; text-transform: uppercase; }
  h1 { margin: 0 0 12px; font-size: clamp(27px, 3vw, 42px); font-weight: 450; letter-spacing: .01em; }
  h1 em { color: var(--accent); font-style: normal; text-shadow: 0 0 24px var(--accent-glow); }
  .welcome-card > p:not(.eyebrow) { margin: 6px 0; color: var(--fg-dim); line-height: 1.65; }
  .welcome-card .warn { color: var(--bad); font: 11px var(--mono); }
  .welcome-card .cta { padding-top: 10px; color: var(--fg); }
  @keyframes breathe { from { opacity: .45; transform: scale(.96); } to { opacity: 1; transform: scale(1.03); } }
  @media (prefers-reduced-motion: reduce) { .welcome-signal span { animation: none; } }
  @media (max-width: 1120px) {
    .workbench { grid-template-columns: 204px minmax(350px, 1fr) 300px; gap: 6px; padding: 6px; }
    .tab { min-width: 100px; }
  }
</style>
