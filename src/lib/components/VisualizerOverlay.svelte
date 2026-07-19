<script lang="ts">
  import { t } from "../i18n.svelte";
  import SpectrumView from "./SpectrumView.svelte";
  import { AUTO_STYLE_ID, visualStyles } from "../spectrum";

  let {
    analyser = null,
    styleId,
    effectiveStyleId,
    autoLabel = null,
    options,
    getPosition = () => 0,
    playing = false,
    canPlay = false,
    timeText = "",
    assetName = null,
    ontoggle,
    onstyle,
    onclose,
  }: {
    analyser?: AnalyserNode | null;
    styleId: string;
    effectiveStyleId: string;
    autoLabel?: string | null;
    options: Readonly<Record<string, number>>;
    getPosition?: () => number;
    playing?: boolean;
    canPlay?: boolean;
    timeText?: string;
    assetName?: string | null;
    ontoggle?: () => void;
    onstyle?: (id: string) => void;
    onclose?: () => void;
  } = $props();

  let idle = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function wake() {
    idle = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (idle = true), 2600);
  }

  $effect(() => {
    wake();
    return () => clearTimeout(idleTimer);
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onclose?.();
    } else if (event.key === " ") {
      event.preventDefault();
      ontoggle?.();
    }
  }

  function onDblclick(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest(".hud")) return;
    onclose?.();
  }
</script>

<svelte:window onkeydown={onKeydown} onpointermove={wake} onpointerdown={wake} ondblclick={onDblclick} />

<div class="visualizer" class:idle role="dialog" aria-label="Visualizer">
  <div class="stage">
    <SpectrumView {analyser} styleId={effectiveStyleId} {options} {getPosition} active={true} />
  </div>

  <header class="hud hud-top">
    {#if assetName}<span class="asset">{assetName}</span>{/if}
    <button class="close" onclick={() => onclose?.()} aria-label={t("overlay.close")}>✕</button>
  </header>

  <footer class="hud hud-bottom">
    <button class="play" onclick={() => ontoggle?.()} disabled={!canPlay} aria-label={playing ? "Pause" : "Play"}>
      {playing ? "❚❚" : "▶"}
    </button>
    <span class="time">{timeText}</span>
    <nav class="styles" aria-label="Visual styles">
      <button class:active={styleId === AUTO_STYLE_ID} onclick={() => onstyle?.(AUTO_STYLE_ID)}>
        Auto{#if styleId === AUTO_STYLE_ID && autoLabel}<i>· {autoLabel}</i>{/if}
      </button>
      {#each visualStyles as entry}
        <button class:active={styleId === entry.id} onclick={() => onstyle?.(entry.id)}>{entry.label}</button>
      {/each}
    </nav>
    <span class="hint">ESC to exit · double-click stage</span>
  </footer>
</div>

<style>
  .visualizer {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: #010403;
    animation: viz-in 0.25s ease;
  }
  .visualizer.idle {
    cursor: none;
  }
  .stage {
    position: absolute;
    inset: 0;
  }
  .hud {
    position: absolute;
    right: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    transition: opacity 0.35s ease, transform 0.35s ease;
  }
  .idle .hud {
    opacity: 0;
    pointer-events: none;
  }
  .hud-top {
    top: 0;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.55), transparent);
  }
  .idle .hud-top {
    transform: translateY(-6px);
  }
  .hud-bottom {
    bottom: 0;
    background: linear-gradient(0deg, rgba(0, 0, 0, 0.6), transparent);
  }
  .idle .hud-bottom {
    transform: translateY(6px);
  }
  .asset {
    color: var(--fg-dim);
    font: 11px var(--mono);
    letter-spacing: 0.04em;
  }
  .close {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    margin-left: auto;
    color: var(--fg-dim);
    border: 1px solid var(--line-strong);
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.35);
    font-size: 11px;
    cursor: pointer;
  }
  .close:hover {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    box-shadow: 0 0 14px var(--accent-soft);
  }
  .play {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    color: var(--accent);
    border: 1px solid var(--accent-line-strong);
    border-radius: 50%;
    background: radial-gradient(circle, color-mix(in srgb, var(--accent) 14%, transparent), transparent 70%);
    box-shadow: 0 0 16px var(--accent-soft);
    font-size: 11px;
    cursor: pointer;
  }
  .play:hover:not(:disabled) {
    color: var(--bg);
    background: var(--accent);
  }
  .play:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .time {
    color: var(--fg-dim);
    font: 11px var(--mono);
    min-width: 74px;
  }
  .styles {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 0 auto;
  }
  .styles button {
    padding: 5px 11px;
    color: var(--fg-dim);
    border: 1px solid var(--line-strong);
    border-radius: 20px;
    background: rgba(0, 0, 0, 0.4);
    font-size: 11px;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .styles button i {
    margin-left: 4px;
    color: var(--fg-muted);
    font-style: normal;
    font-size: 10px;
  }
  .styles button:hover {
    color: var(--fg);
    border-color: var(--accent-line-strong);
  }
  .styles button.active {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
    box-shadow: 0 0 12px var(--accent-soft);
  }
  .hint {
    color: var(--fg-muted);
    font-size: 10px;
    white-space: nowrap;
  }
  @keyframes viz-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .visualizer {
      animation: none;
    }
  }
</style>
