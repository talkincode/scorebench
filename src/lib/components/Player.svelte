<script lang="ts">
  import { onMount } from "svelte";
  import { api, errorText } from "../api";
  import { bench } from "../state.svelte";
  import { drawWithFallback, spectrumStyles, type SpectrumFrame } from "../spectrum";

  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let gainNode: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;
  let buffer = $state<AudioBuffer | null>(null);
  let freqData: Uint8Array | null = null;
  let timeData: Uint8Array | null = null;

  let playing = $state(false);
  let looping = $state(true);
  let position = $state(0);
  let duration = $state(0);
  let loadError = $state<string | null>(null);
  let styleId = $state(spectrumStyles[0].id);
  let styleOptions = $state<Record<string, number>>({ bars: 64, themeHue: 171 });
  let prefersReducedMotion = $state(false);
  let seeking = $state(false);

  let canvas: HTMLCanvasElement | undefined = $state();
  let startCtxTime = 0;
  let startOffset = 0;
  let raf = 0;
  let lastLoadSeq = 0;
  let settingsApplied = false;
  const failedStyles = new Set<string>();
  let activeStyle = $derived(spectrumStyles.find((style) => style.id === styleId) ?? spectrumStyles[0]);

  onMount(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => (prefersReducedMotion = query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });

  function ensureGraph() {
    if (audioCtx) return;
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;
    gainNode = audioCtx.createGain();
    gainNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
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
      styleId = spectrumStyles.some((style) => style.id === bench.settings!.spectrum_style)
        ? bench.settings.spectrum_style
        : "bars";
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

  $effect(() => {
    const style = spectrumStyles.find((s) => s.id === styleId) ?? spectrumStyles[0];
    const fallback = spectrumStyles[0];
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;

    const tick = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w * dpr || el.height !== h * dpr) {
        el.width = w * dpr;
        el.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (analyser && freqData && timeData) {
        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(timeData);
        const frame: SpectrumFrame = {
          ctx,
          width: w,
          height: h,
          freq: freqData,
          time: timeData,
          positionFraction: duration > 0 ? currentPos() / duration : 0,
          prefersReducedMotion,
          options: styleOptions,
        };
        const used = drawWithFallback(style, fallback, frame, failedStyles, (error) => {
          console.error(`spectrum style ${style.id} failed`, error);
        });
        if (used.id !== style.id && styleId !== used.id) {
          styleId = used.id;
          void persistSpectrum();
        }
      } else {
        ctx.clearRect(0, 0, w, h);
      }
      if (!seeking) position = currentPos();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  function fmtTime(t: number): string {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
</script>

<footer class="player">
  <div class="transport">
    <button class="play" onclick={toggle} disabled={!buffer} aria-label={playing ? "Pause" : "Play"}>
      {playing ? "❚❚" : "▶"}
    </button>
    <label class="loop" title="Loop playback">
      <input type="checkbox" checked={looping} onchange={(e) => setLoop(e.currentTarget.checked)} />
      <span>loop</span>
    </label>
    <span class="time">{fmtTime(position)} / {fmtTime(duration)}</span>
  </div>

  <div class="middle">
    <input
      class="seek"
      type="range"
      min="0"
      max={duration || 1}
      step="0.01"
      value={position}
      disabled={!buffer}
      oninput={(e) => {
        seeking = true;
        position = Number(e.currentTarget.value);
      }}
      onchange={(e) => {
        seeking = false;
        seekTo(Number(e.currentTarget.value));
      }}
      aria-label="Seek"
    />
    <canvas bind:this={canvas} class="spectrum"></canvas>
  </div>

  <div class="meta">
    {#if loadError}
      <span class="err">{loadError}</span>
    {:else if bench.loadedAsset}
      <span class="asset" title={bench.loadedAsset}>{bench.loadedAsset}</span>
    {:else}
      <span class="idle">nothing loaded</span>
    {/if}
    <select value={styleId} onchange={(event) => chooseStyle(event.currentTarget.value)} aria-label="Spectrum style">
      {#each spectrumStyles as style}
        <option value={style.id}>{style.label}</option>
      {/each}
    </select>
    {#each activeStyle.options ?? [] as option}
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
      </label>
    {/each}
  </div>
</footer>

<style>
  .player {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 116px;
    padding: 8px 10px;
    border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel-deep) 95%, transparent);
    box-shadow: 0 -12px 30px rgba(0,0,0,.22);
  }
  .player::before {
    content: "";
    position: absolute;
    top: 4px;
    right: 10px;
    left: 10px;
    height: 1px;
    opacity: .3;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
  }
  .transport {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 4px;
    width: 112px;
    height: 98px;
    flex-shrink: 0;
    border: 1px solid var(--accent-line);
    border-radius: 50px 9px 9px 50px;
    background: radial-gradient(circle at 38% 50%, var(--accent-soft), transparent 58%);
  }
  .play {
    position: relative;
    width: 54px;
    height: 54px;
    border-radius: 50%;
    border: 1px solid var(--accent-line-strong);
    background: radial-gradient(circle, color-mix(in srgb, var(--accent) 14%, var(--panel-deep)), var(--panel-deep));
    color: var(--accent);
    box-shadow: 0 0 17px var(--accent-soft), inset 0 0 15px var(--accent-soft), 0 0 0 6px hsl(var(--theme-hue) 70% 55% / .035);
    font-size: 13px;
    text-shadow: 0 0 8px var(--accent);
    cursor: pointer;
  }
  .play:hover:not(:disabled) {
    color: var(--bg);
    background: var(--accent);
    box-shadow: 0 0 24px var(--accent-glow), 0 0 0 6px hsl(var(--theme-hue) 70% 55% / .07);
  }
  .play:disabled { opacity: .35; cursor: default; }
  .loop {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 8px;
    color: var(--fg-dim);
    cursor: pointer;
  }
  .loop input { width: 10px; height: 10px; accent-color: var(--accent); }
  .time { color: var(--fg-muted); font: 8px var(--mono); }
  .middle {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    height: 98px;
    min-width: 0;
    padding: 5px 7px 7px;
    border: 1px solid var(--accent-line);
    border-radius: 9px;
    background: linear-gradient(180deg, var(--accent-soft), transparent 32%), var(--panel-glass);
    overflow: hidden;
  }
  .seek {
    width: 100%;
    height: 13px;
    margin: 0;
    accent-color: var(--accent);
  }
  .spectrum {
    flex: 1;
    width: 100%;
    min-height: 0;
    border-radius: 4px;
    background:
      linear-gradient(hsl(var(--theme-hue) 70% 55% / .03) 1px, transparent 1px),
      linear-gradient(90deg, hsl(var(--theme-hue) 70% 55% / .03) 1px, transparent 1px),
      var(--control-bg);
    background-size: 16px 16px;
  }
  .meta {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-end;
    gap: 5px;
    width: 205px;
    height: 98px;
    flex-shrink: 0;
    padding: 8px;
    border: 1px solid var(--accent-line);
    border-radius: 9px;
    background: var(--panel-glass);
  }
  .meta .asset {
    color: var(--fg);
    max-width: 100%;
    overflow: hidden;
    font: 8px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
  }
  .meta .idle { color: var(--fg-muted); font-size: 8px; }
  .meta .err { color: var(--bad); font-size: 8px; }
  .meta select {
    width: 100%;
    height: 27px;
    padding: 3px 7px;
    color: var(--fg);
    border: 1px solid var(--line-strong);
    border-radius: 5px;
    background: var(--control-bg);
    font: 9px var(--mono);
  }
  .style-option {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    color: var(--fg-muted);
    font-size: 7px;
  }
  .style-option input { flex: 1; min-width: 0; accent-color: var(--accent); }
  @media (max-width: 1080px) { .transport { width: 95px; } .meta { width: 170px; } }
</style>
