<script lang="ts">
  import { api, errorText } from "../api";
  import { t } from "../i18n.svelte";
  import { bench } from "../state.svelte";
  import {
    AUTO_STYLE_ID,
    analyzeTraits,
    pickStyle,
    visualStyleById,
    visualStyles,
  } from "../spectrum";
  import SeekBar from "./SeekBar.svelte";
  import SpectrumView from "./SpectrumView.svelte";
  import VisualizerOverlay from "./VisualizerOverlay.svelte";

  let audioCtx: AudioContext | null = null;
  let analyser = $state<AnalyserNode | null>(null);
  let analyserL: AnalyserNode | null = null;
  let analyserR: AnalyserNode | null = null;
  let gainNode: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;
  let buffer = $state<AudioBuffer | null>(null);

  let playing = $state(false);
  let looping = $state(true);
  let position = $state(0);
  let duration = $state(0);
  let loadError = $state<string | null>(null);
  let styleId = $state(AUTO_STYLE_ID);
  let autoPicked = $state<string | null>(null);
  let styleOptions = $state<Record<string, number>>({ bars: 64, themeHue: 171 });
  let seeking = $state(false);
  let overlayOpen = $state(false);

  let meterCanvas: HTMLCanvasElement | undefined = $state();
  let startCtxTime = 0;
  let startOffset = 0;
  let lastLoadSeq = 0;
  let settingsApplied = false;
  let meterTime: Uint8Array | null = null;
  const meterState = { l: 0, r: 0, peakL: 0, peakR: 0, heldL: 0, heldR: 0 };

  let effectiveStyleId = $derived(styleId === AUTO_STYLE_ID ? (autoPicked ?? "bars") : styleId);
  let activeEntry = $derived(visualStyleById(effectiveStyleId) ?? visualStyleById("bars")!);
  let autoLabel = $derived(autoPicked ? (visualStyleById(autoPicked)?.label ?? autoPicked) : null);

  function ensureGraph() {
    if (audioCtx) return;
    audioCtx = new AudioContext();
    const mainAnalyser = audioCtx.createAnalyser();
    mainAnalyser.fftSize = 2048;
    mainAnalyser.smoothingTimeConstant = 0.82;
    gainNode = audioCtx.createGain();
    gainNode.channelCount = 2;
    gainNode.channelCountMode = "explicit";
    gainNode.connect(mainAnalyser);
    mainAnalyser.connect(audioCtx.destination);
    const splitter = audioCtx.createChannelSplitter(2);
    gainNode.connect(splitter);
    analyserL = audioCtx.createAnalyser();
    analyserR = audioCtx.createAnalyser();
    for (const node of [analyserL, analyserR]) {
      node.fftSize = 512;
      node.smoothingTimeConstant = 0.55;
    }
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    meterTime = new Uint8Array(512);
    analyser = mainAnalyser;
  }

  function teardownSource() {
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      source = null;
    }
  }

  function currentPos(): number {
    if (!playing || !audioCtx || !buffer) return position;
    const elapsed = audioCtx.currentTime - startCtxTime + startOffset;
    return looping ? elapsed % buffer.duration : Math.min(elapsed, buffer.duration);
  }

  function play() {
    if (!buffer || !audioCtx || !gainNode) return;
    void audioCtx.resume();
    teardownSource();
    source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = looping;
    source.connect(gainNode);
    const offset = Math.min(position, buffer.duration - 0.001);
    source.onended = () => {
      if (!looping) {
        playing = false;
        position = 0;
      }
    };
    source.start(0, Math.max(0, offset));
    startCtxTime = audioCtx.currentTime;
    startOffset = offset;
    playing = true;
  }

  function pause() {
    position = currentPos();
    teardownSource();
    playing = false;
  }

  function toggle() {
    if (!buffer) return;
    if (playing) pause();
    else play();
  }

  // Mirror playback state so other panels (scene rail) can show it.
  $effect(() => {
    bench.playing = playing;
  });

  function seekTo(t: number) {
    if (!buffer) return;
    const wasPlaying = playing;
    teardownSource();
    playing = false;
    position = Math.max(0, Math.min(t, buffer.duration));
    if (wasPlaying) play();
  }

  function setLoop(value: boolean) {
    looping = value;
    if (source) source.loop = value;
  }

  async function load(relPath: string) {
    if (!bench.project) return;
    ensureGraph();
    teardownSource();
    playing = false;
    loadError = null;
    try {
      const bytes = await api.readAsset(bench.project.root, relPath);
      buffer = await audioCtx!.decodeAudioData(bytes.slice(0));
      duration = buffer.duration;
      position = 0;
      autoPicked = pickStyle(analyzeTraits(buffer));
      play();
    } catch (err) {
      buffer = null;
      duration = 0;
      position = 0;
      loadError = errorText(err);
    }
  }

  $effect(() => {
    const seq = bench.loadSeq;
    const rel = bench.loadedAsset;
    if (seq !== lastLoadSeq && rel) {
      lastLoadSeq = seq;
      void load(rel);
    }
  });

  $effect(() => {
    if (!settingsApplied && bench.settings) {
      const saved = bench.settings.spectrum_style;
      styleId = saved === AUTO_STYLE_ID || visualStyleById(saved) ? saved : "bars";
      styleOptions.bars = bench.settings.spectrum_bars;
      settingsApplied = true;
    }
  });

  $effect(() => {
    styleOptions.themeHue = bench.themeHuePreview ?? bench.settings?.theme_hue ?? 171;
  });

  async function persistSpectrum() {
    if (!bench.settings) return;
    const next = {
      ...bench.settings,
      spectrum_style: styleId,
      spectrum_bars: Math.round(styleOptions.bars ?? 64),
    };
    bench.settings = next;
    try {
      await api.saveSettings(next);
    } catch (error) {
      loadError = errorText(error);
    }
  }

  function chooseStyle(value: string) {
    styleId = value;
    void persistSpectrum();
  }

  function setStyleOption(key: string, value: number) {
    styleOptions[key] = value;
    void persistSpectrum();
  }

  function meterLevel(node: AnalyserNode | null): number {
    if (!node || !meterTime) return 0;
    node.getByteTimeDomainData(meterTime);
    let sum = 0;
    for (let i = 0; i < meterTime.length; i++) {
      const v = (meterTime[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / meterTime.length) * 2.6);
  }

  function drawMeters() {
    const el = meterCanvas;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (el.width !== w * dpr || el.height !== h * dpr) {
      el.width = w * dpr;
      el.height = h * dpr;
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const now = performance.now();
    for (const side of ["l", "r"] as const) {
      const raw = playing ? meterLevel(side === "l" ? analyserL : analyserR) : 0;
      const prev = meterState[side];
      const next = raw > prev ? prev + (raw - prev) * 0.55 : prev * 0.9;
      meterState[side] = next;
      const peakKey = side === "l" ? "peakL" : "peakR";
      const heldKey = side === "l" ? "heldL" : "heldR";
      if (next >= meterState[peakKey]) {
        meterState[peakKey] = next;
        meterState[heldKey] = now;
      } else if (now - meterState[heldKey] > 900) {
        meterState[peakKey] = Math.max(next, meterState[peakKey] - 0.012);
      }
    }

    const hue = styleOptions.themeHue ?? 171;
    const colWidth = 7;
    const gap = 6;
    const x0 = (w - colWidth * 2 - gap) / 2;
    const segments = 16;
    const segGap = 2;
    const segHeight = (h - (segments - 1) * segGap) / segments;
    for (const [column, value, peak] of [
      [0, meterState.l, meterState.peakL],
      [1, meterState.r, meterState.peakR],
    ] as const) {
      const x = x0 + column * (colWidth + gap);
      const display = Math.pow(value, 0.72);
      for (let s = 0; s < segments; s++) {
        const t = (s + 1) / segments;
        const y = h - (s + 1) * segHeight - s * segGap;
        const lit = t <= display;
        const color = t > 0.86 ? "0 82% 58%" : t > 0.64 ? "40 90% 55%" : `${hue} 78% 52%`;
        ctx.fillStyle = lit ? `hsl(${color})` : `hsl(${hue} 30% 30% / .2)`;
        ctx.fillRect(x, y, colWidth, segHeight);
      }
      const displayPeak = Math.pow(peak, 0.72);
      if (displayPeak > 0.02) {
        const py = h - displayPeak * h;
        ctx.fillStyle = `hsl(${hue} 90% 72%)`;
        ctx.fillRect(x, Math.max(0, py - 1), colWidth, 1.5);
      }
    }
  }

  $effect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!seeking) position = currentPos();
      drawMeters();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  function fmtTime(t: number): string {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function assetTitle(path: string): string {
    return path.split("/").at(-1) ?? path;
  }
</script>

<footer class="player">
  <div class="transport">
    <button class="play" onclick={toggle} disabled={!buffer} aria-label={playing ? "Pause" : "Play"}>
      <span class="play-ring" aria-hidden="true"></span>
      <span class="play-glyph">{playing ? "❚❚" : "▶"}</span>
    </button>
    <div class="transport-side">
      <button
        class="loop"
        class:on={looping}
        onclick={() => setLoop(!looping)}
        aria-pressed={looping}
        title={t("player.loop")}
      >⟳ loop</button>
      <span class="time"><b>{fmtTime(position)}</b><i>/</i>{fmtTime(duration)}</span>
    </div>
  </div>

  <div class="stage">
    <SeekBar
      value={position}
      max={duration}
      disabled={!buffer}
      fmt={fmtTime}
      onscrub={(t) => {
        seeking = true;
        position = t;
      }}
      oncommit={(t) => {
        seeking = false;
        seekTo(t);
      }}
    />
    <div class="viz">
      <SpectrumView
        {analyser}
        styleId={effectiveStyleId}
        options={styleOptions}
        getPosition={() => (duration > 0 ? currentPos() / duration : 0)}
        active={!overlayOpen}
      />
      <button class="expand" onclick={() => (overlayOpen = true)} title={t("player.expand")} aria-label={t("player.expand")}>⛶</button>
    </div>
  </div>

  <div class="side">
    <div class="asset-row">
      {#if loadError}
        <span class="err" title={loadError}>{loadError}</span>
      {:else if bench.loadedAsset}
        <span class="asset" title={bench.loadedAsset}>{assetTitle(bench.loadedAsset)}</span>
        <i class="live" aria-hidden="true"></i>
      {:else}
        <span class="idle">nothing loaded</span>
      {/if}
    </div>
    <label class="style-row">
      <span class="style-label">{t("player.visual")}</span>
      <select value={styleId} onchange={(event) => chooseStyle(event.currentTarget.value)} aria-label={t("player.spectrumStyle")}>
        <option value={AUTO_STYLE_ID}>{t("player.auto")}{autoLabel && styleId === AUTO_STYLE_ID ? ` · ${autoLabel}` : ""}</option>
        {#each visualStyles as entry}
          <option value={entry.id}>{entry.label}</option>
        {/each}
      </select>
    </label>
    <div class="option-rows">
      {#each activeEntry.options ?? [] as option}
        <label class="style-option">
          <span>{option.label}</span>
          <input
            type="range"
            min={option.min}
            max={option.max}
            step={option.step}
            value={styleOptions[option.key] ?? option.defaultValue}
            oninput={(event) => setStyleOption(option.key, Number(event.currentTarget.value))}
          />
          <b>{Math.round(styleOptions[option.key] ?? option.defaultValue)}</b>
        </label>
      {:else}
        <span class="option-idle">{styleId === AUTO_STYLE_ID ? "style follows the music" : "no parameters"}</span>
      {/each}
    </div>
  </div>

  <div class="meters" aria-hidden="true">
    <canvas bind:this={meterCanvas}></canvas>
    <div class="meter-labels"><span>L</span><span>R</span></div>
  </div>
</footer>

{#if overlayOpen}
  <VisualizerOverlay
    {analyser}
    {styleId}
    {effectiveStyleId}
    {autoLabel}
    options={styleOptions}
    getPosition={() => (duration > 0 ? currentPos() / duration : 0)}
    {playing}
    canPlay={Boolean(buffer)}
    timeText={`${fmtTime(position)} / ${fmtTime(duration)}`}
    assetName={bench.loadedAsset}
    ontoggle={toggle}
    onstyle={chooseStyle}
    onclose={() => (overlayOpen = false)}
  />
{/if}

<style>
  .player {
    position: relative;
    display: flex;
    align-items: stretch;
    gap: 10px;
    height: 132px;
    padding: 9px 10px;
    border-top: 1px solid var(--line);
    background:
      linear-gradient(180deg, hsl(var(--theme-hue) 30% 9% / 0.5), transparent 40%),
      color-mix(in srgb, var(--panel-deep) 96%, transparent);
    box-shadow: 0 -12px 30px rgba(0, 0, 0, 0.22);
  }
  .player::before {
    content: "";
    position: absolute;
    top: -1px;
    right: 10px;
    left: 10px;
    height: 1px;
    opacity: 0.35;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 184px;
    flex-shrink: 0;
    padding: 0 12px;
    border: 1px solid var(--accent-line);
    border-radius: 58px 10px 10px 58px;
    background:
      radial-gradient(circle at 30% 50%, var(--accent-soft), transparent 62%),
      linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 55%),
      var(--panel-glass);
    box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }
  .play {
    position: relative;
    display: grid;
    place-items: center;
    width: 62px;
    height: 62px;
    flex-shrink: 0;
    color: var(--accent);
    border: 1px solid var(--accent-line-strong);
    border-radius: 50%;
    background: radial-gradient(circle at 38% 32%, color-mix(in srgb, var(--accent) 20%, var(--panel-deep)), var(--panel-deep) 72%);
    box-shadow:
      0 0 18px var(--accent-soft),
      inset 0 0 16px var(--accent-soft),
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 0 0 5px hsl(var(--theme-hue) 70% 55% / 0.04);
    cursor: pointer;
    transition: box-shadow 0.18s ease, transform 0.12s ease;
  }
  .play-ring {
    position: absolute;
    inset: 3px;
    border: 1px dashed hsl(var(--theme-hue) 70% 55% / 0.28);
    border-radius: 50%;
  }
  .play-glyph {
    font-size: 16px;
    text-shadow: 0 0 9px var(--accent);
  }
  .play:hover:not(:disabled) {
    color: var(--bg);
    background: var(--accent);
    box-shadow: 0 0 26px var(--accent-glow), 0 0 0 5px hsl(var(--theme-hue) 70% 55% / 0.08);
  }
  .play:active:not(:disabled) {
    transform: scale(0.96);
  }
  .play:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .transport-side {
    display: grid;
    gap: 7px;
    min-width: 0;
  }
  .loop {
    padding: 4px 9px;
    color: var(--fg-label);
    border: 1px solid var(--line-strong);
    border-radius: 20px;
    background: rgba(0, 0, 0, 0.22);
    font-size: 11px;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .loop.on {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
    box-shadow: 0 0 10px var(--accent-soft), inset 0 0 6px var(--accent-soft);
  }
  .time {
    color: var(--fg-dim);
    font: 11px var(--mono);
    white-space: nowrap;
  }
  .time b {
    color: var(--fg);
    font-weight: 500;
  }
  .time i {
    margin: 0 4px;
    font-style: normal;
    opacity: 0.5;
  }

  .stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 6px 9px 8px;
    border: 1px solid var(--accent-line);
    border-radius: 10px;
    background:
      linear-gradient(180deg, var(--accent-soft), transparent 30%),
      var(--panel-glass);
    box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.025);
  }
  .viz {
    position: relative;
    flex: 1;
    min-height: 0;
    border-radius: 6px;
    border: 1px solid hsl(var(--theme-hue) 40% 40% / 0.14);
    background:
      linear-gradient(hsl(var(--theme-hue) 70% 55% / 0.028) 1px, transparent 1px) 0 0 / 16px 16px,
      linear-gradient(90deg, hsl(var(--theme-hue) 70% 55% / 0.028) 1px, transparent 1px) 0 0 / 16px 16px,
      radial-gradient(ellipse at 50% 130%, hsl(var(--theme-hue) 60% 30% / 0.14), transparent 62%),
      var(--control-bg);
    box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .expand {
    position: absolute;
    top: 5px;
    right: 5px;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    color: var(--fg-label);
    border: 1px solid var(--line-strong);
    border-radius: 5px;
    background: rgba(0, 0, 0, 0.45);
    font-size: 12px;
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .viz:hover .expand,
  .expand:focus-visible {
    opacity: 1;
  }
  .expand:hover {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    box-shadow: 0 0 10px var(--accent-soft);
  }

  .side {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 216px;
    flex-shrink: 0;
    padding: 8px 9px;
    border: 1px solid var(--accent-line);
    border-radius: 10px;
    background: var(--panel-glass);
    box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.025);
  }
  .asset-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 14px;
  }
  .asset {
    flex: 1;
    overflow: hidden;
    color: var(--fg);
    font: 10px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .live {
    width: 5px;
    height: 5px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--good);
    box-shadow: 0 0 7px var(--good);
  }
  .idle {
    color: var(--fg-dim);
    font-size: 11px;
  }
  .err {
    overflow: hidden;
    color: var(--bad);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .style-row {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .style-label {
    color: var(--fg-label);
    font-size: var(--ui-label-size);
    font-weight: var(--ui-label-weight);
    letter-spacing: var(--ui-label-tracking);
    text-transform: uppercase;
  }
  .style-row select {
    flex: 1;
    min-width: 0;
    height: 26px;
    padding: 3px 7px;
    color: var(--fg);
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background-color: var(--control-bg);
    font: 11px var(--mono);
  }
  .option-rows {
    display: grid;
    gap: 4px;
    min-height: 15px;
  }
  .style-option {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-label);
    font-size: var(--ui-label-size);
    font-weight: var(--ui-label-weight);
  }
  .style-option input {
    flex: 1;
    min-width: 0;
    height: 3px;
    accent-color: var(--accent);
  }
  .style-option b {
    min-width: 22px;
    color: var(--fg-dim);
    font: 10px var(--mono);
    font-weight: 400;
    text-align: right;
  }
  .option-idle {
    color: var(--fg-dim);
    font-size: var(--ui-label-size);
    font-style: italic;
  }

  .meters {
    display: flex;
    flex-direction: column;
    width: 42px;
    flex-shrink: 0;
    padding: 7px 5px 4px;
    border: 1px solid var(--accent-line);
    border-radius: 10px;
    background: var(--panel-glass);
    box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.025);
  }
  .meters canvas {
    flex: 1;
    width: 100%;
    min-height: 0;
  }
  .meter-labels {
    display: flex;
    justify-content: space-around;
    padding-top: 3px;
    color: var(--fg-label);
    font: var(--ui-label-size) var(--mono);
    font-weight: var(--ui-label-weight);
  }

  @media (max-width: 1120px) {
    .transport {
      width: 162px;
    }
    .side {
      width: 182px;
    }
  }
</style>
