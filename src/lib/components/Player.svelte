<script lang="ts">
  import { api, errorText } from "../api";
  import { bench } from "../state.svelte";
  import { spectrumStyles } from "../spectrum";

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
  let seeking = $state(false);

  let canvas: HTMLCanvasElement | undefined = $state();
  let startCtxTime = 0;
  let startOffset = 0;
  let raf = 0;
  let lastLoadSeq = 0;

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
    const style = spectrumStyles.find((s) => s.id === styleId) ?? spectrumStyles[0];
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
        style.draw(ctx, w, h, freqData, timeData);
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
    <select bind:value={styleId} aria-label="Spectrum style">
      {#each spectrumStyles as style}
        <option value={style.id}>{style.label}</option>
      {/each}
    </select>
  </div>
</footer>

<style>
  .player {
    display: flex;
    align-items: stretch;
    gap: 16px;
    height: 108px;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  .transport {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 6px;
    width: 120px;
    flex-shrink: 0;
  }
  .play {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: var(--panel-2);
    color: var(--fg);
    font-size: 15px;
    cursor: pointer;
  }
  .play:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .play:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .loop {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--fg-dim);
    cursor: pointer;
  }
  .loop input {
    accent-color: var(--accent);
  }
  .time {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-dim);
  }
  .middle {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .seek {
    width: 100%;
    accent-color: var(--accent);
    height: 18px;
  }
  .spectrum {
    flex: 1;
    width: 100%;
    min-height: 0;
    border-radius: 8px;
    background: var(--panel-2);
  }
  .meta {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-end;
    gap: 6px;
    width: 220px;
    flex-shrink: 0;
    padding: 4px 0;
  }
  .meta .asset {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
  }
  .meta .idle {
    font-size: 11px;
    color: var(--fg-dim);
  }
  .meta .err {
    font-size: 11px;
    color: var(--bad);
  }
  .meta select {
    background: var(--panel-2);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 4px 8px;
    font-size: 12px;
  }
</style>
