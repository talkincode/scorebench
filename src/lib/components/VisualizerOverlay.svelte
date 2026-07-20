<script lang="ts">
  import { t } from "../i18n.svelte";
  import { sceneSignature } from "../titleCard";
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
    meta = null,
    recordingState = "idle",
    recordingTime = "",
    recordError = null,
    onrecord,
    onrecordstop,
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
    meta?: {
      title?: string | null;
      story?: string | null;
      tempo?: number | null;
      key?: string | null;
      time_signature?: string | null;
      bars?: number | null;
    } | null;
    recordingState?: "idle" | "starting" | "recording" | "saving";
    recordingTime?: string;
    recordError?: string | null;
    onrecord?: (canvas: HTMLCanvasElement | null) => void;
    onrecordstop?: () => void;
    ontoggle?: () => void;
    onstyle?: (id: string) => void;
    onclose?: () => void;
  } = $props();

  /** `128 BPM · A minor · 4/4 · 16 bars` — only the facts the scene declares. */
  let signature = $derived(sceneSignature(meta));

  let view: { getActiveCanvas: () => HTMLCanvasElement | null } | undefined = $state();
  let recordingActive = $derived(recordingState !== "idle");

  let idle = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function wake() {
    idle = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Keep the HUD (and its recording indicator) visible during a take.
      if (!recordingActive) idle = true;
    }, 2600);
  }

  $effect(() => {
    void recordingActive;
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
    <SpectrumView bind:this={view} {analyser} styleId={effectiveStyleId} {options} {getPosition} active={true} />
  </div>

  <header class="hud hud-top">
    <div class="meta">
      {#if assetName}<span class="asset">{assetName}</span>{/if}
      {#if meta?.title}<h1 class="title">{meta.title}</h1>{/if}
      {#if signature}<span class="signature">{signature}</span>{/if}
      {#if meta?.story}<p class="story">{meta.story}</p>{/if}
    </div>
    <button class="close" onclick={() => onclose?.()} aria-label={t("overlay.close")}>✕</button>
  </header>

  <footer class="hud hud-bottom">
    <button class="play" onclick={() => ontoggle?.()} disabled={!canPlay} aria-label={playing ? "Pause" : "Play"}>
      {playing ? "❚❚" : "▶"}
    </button>
    <span class="time">{timeText}</span>
    {#if recordingState === "recording"}
      <button class="rec live" onclick={() => onrecordstop?.()} title={t("overlay.recordStop")} aria-label={t("overlay.recordStop")}>
        <i class="rec-dot" aria-hidden="true"></i>{recordingTime}
      </button>
    {:else if recordingState === "starting"}
      <button class="rec" disabled>{t("overlay.recordStarting")}</button>
    {:else if recordingState === "saving"}
      <button class="rec" disabled>{t("overlay.recordSaving")}</button>
    {:else}
      <button
        class="rec"
        onclick={() => onrecord?.(view?.getActiveCanvas() ?? null)}
        disabled={!canPlay}
        title={t("overlay.recordHint")}
        aria-label={t("overlay.record")}
      >
        <i class="rec-dot" aria-hidden="true"></i>REC
      </button>
    {/if}
    {#if recordError}
      <span class="rec-error" title={recordError}>{recordError}</span>
    {/if}
    <nav class="styles" aria-label="Visual styles">
      <button
        class:active={styleId === AUTO_STYLE_ID}
        disabled={recordingActive}
        onclick={() => onstyle?.(AUTO_STYLE_ID)}
      >
        Auto{#if styleId === AUTO_STYLE_ID && autoLabel}<i>· {autoLabel}</i>{/if}
      </button>
      {#each visualStyles as entry}
        <button class:active={styleId === entry.id} disabled={recordingActive} onclick={() => onstyle?.(entry.id)}>{entry.label}</button>
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
    align-items: flex-start;
    padding-bottom: 40px;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.68) 0%, rgba(0, 0, 0, 0.3) 55%, transparent);
  }
  .idle .hud-top {
    transform: translateY(-6px);
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
    text-shadow: 0 1px 18px rgba(0, 0, 0, 0.85);
  }
  .asset {
    color: var(--fg-dim);
    font: 10px var(--mono);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    opacity: 0.85;
  }
  .title {
    margin: 0;
    color: var(--fg);
    font-family: var(--sans);
    font-size: clamp(21px, 3.1vw, 34px);
    font-weight: 250;
    line-height: 1.15;
    letter-spacing: 0.015em;
  }
  .signature {
    color: color-mix(in srgb, var(--accent) 72%, var(--fg));
    font: 11px var(--mono);
    letter-spacing: 0.09em;
  }
  .story {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    max-width: min(56ch, 44vw);
    margin: 5px 0 0;
    padding-left: 13px;
    overflow: hidden;
    color: color-mix(in srgb, var(--fg) 74%, transparent);
    border-left: 2px solid var(--accent-line-strong);
    font-size: 12.5px;
    line-height: 1.75;
    white-space: pre-line;
  }
  .hud-bottom {
    bottom: 0;
    background: linear-gradient(0deg, rgba(0, 0, 0, 0.6), transparent);
  }
  .idle .hud-bottom {
    transform: translateY(6px);
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
    font-size: 12px;
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
    font-size: 12px;
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
  .rec {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    color: var(--fg-dim);
    border: 1px solid var(--line-strong);
    border-radius: 20px;
    background: rgba(0, 0, 0, 0.4);
    font: 11px var(--mono);
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .rec:hover:not(:disabled) {
    color: hsl(0 85% 68%);
    border-color: hsl(0 70% 45% / 0.7);
  }
  .rec:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .rec.live {
    color: hsl(0 85% 68%);
    border-color: hsl(0 70% 45% / 0.7);
    background: hsl(0 70% 45% / 0.12);
    box-shadow: 0 0 12px hsl(0 70% 45% / 0.35);
  }
  .rec-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: hsl(0 80% 55%);
  }
  .rec.live .rec-dot {
    animation: rec-pulse 1.2s ease-in-out infinite;
  }
  .rec-error {
    max-width: 260px;
    overflow: hidden;
    color: hsl(0 80% 66%);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @keyframes rec-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
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
    font-size: 12px;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .styles button i {
    margin-left: 4px;
    color: var(--fg-dim);
    font-style: normal;
    font-size: 11px;
  }
  .styles button:hover:not(:disabled) {
    color: var(--fg);
    border-color: var(--accent-line-strong);
  }
  .styles button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .styles button.active {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
    box-shadow: 0 0 12px var(--accent-soft);
  }
  .hint {
    color: var(--fg-dim);
    font-size: 11px;
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
    .rec.live .rec-dot {
      animation: none;
    }
  }
</style>
