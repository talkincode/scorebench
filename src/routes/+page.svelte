<script lang="ts">
  import { onMount } from "svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import Chat from "$lib/components/Chat.svelte";
  import ScenePanel from "$lib/components/ScenePanel.svelte";
  import Player from "$lib/components/Player.svelte";
  import { api, errorText } from "$lib/api";
  import { bench } from "$lib/state.svelte";

  onMount(async () => {
    try {
      bench.scorekitPath = await api.scorekitStatus();
    } catch (err) {
      bench.scorekitError = errorText(err);
    }
  });
</script>

<div class="app">
  <TopBar />
  {#if bench.project}
    <div class="body">
      <section class="chat-col">
        <Chat />
      </section>
      <aside class="side-col">
        <ScenePanel />
      </aside>
    </div>
  {:else}
    <div class="welcome">
      <div class="welcome-card">
        <span class="mark">◳</span>
        <h1>scorebench</h1>
        <p>Agent-native workbench for scorekit.</p>
        <p class="sub">
          Open a project directory — scene YAML in, rendered game audio out.
          The agent composes; you listen.
        </p>
        {#if bench.scorekitError}
          <p class="warn">{bench.scorekitError}</p>
        {/if}
        <p class="cta">Use <strong>Open project…</strong> in the top bar to begin.</p>
      </div>
    </div>
  {/if}
  <Player />
</div>

<style>
  :global(:root) {
    --bg: #101014;
    --panel: #16161c;
    --panel-2: #1e1e26;
    --line: #2a2a34;
    --fg: #e8e6e3;
    --fg-dim: #8b8b96;
    --accent: #e8a33d;
    --accent-soft: rgba(232, 163, 61, 0.14);
    --good: #57c470;
    --bad: #e26d5c;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
  }
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--fg);
    font-family:
      -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: 14px;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  :global(button) {
    font: inherit;
  }
  :global(button.primary) {
    background: var(--accent);
    color: #1a1206;
    border: none;
    border-radius: 8px;
    padding: 8px 16px;
    font-weight: 600;
    cursor: pointer;
  }
  :global(button.primary:hover:not(:disabled)) {
    filter: brightness(1.08);
  }
  :global(button.primary:disabled) {
    opacity: 0.45;
    cursor: default;
  }
  :global(button.ghost) {
    background: none;
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 7px 14px;
    cursor: pointer;
  }
  :global(button.ghost:hover) {
    border-color: var(--fg-dim);
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .chat-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .side-col {
    width: 340px;
    flex-shrink: 0;
    border-left: 1px solid var(--line);
    background: var(--panel);
    min-height: 0;
  }
  .welcome {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .welcome-card {
    text-align: center;
    max-width: 420px;
    padding: 40px;
  }
  .mark {
    font-size: 40px;
    color: var(--accent);
  }
  h1 {
    margin: 12px 0 4px;
    font-size: 26px;
    letter-spacing: 0.01em;
  }
  .welcome-card p {
    color: var(--fg-dim);
    line-height: 1.6;
    margin: 6px 0;
  }
  .welcome-card .sub {
    font-size: 13px;
  }
  .welcome-card .warn {
    color: var(--bad);
    font-size: 12.5px;
    border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent);
    border-radius: 8px;
    padding: 8px 12px;
    margin-top: 14px;
  }
  .welcome-card .cta {
    margin-top: 18px;
    color: var(--fg);
  }
</style>
