<script lang="ts">
  import { onMount } from "svelte";
  import {
    drawWithFallback,
    spectrumStyles,
    visualStyleById,
    type SpectrumFrame,
    type ThreeInstance,
  } from "../spectrum";

  let {
    analyser = null,
    styleId,
    options,
    getPosition = () => 0,
    active = true,
  }: {
    analyser?: AnalyserNode | null;
    styleId: string;
    options: Readonly<Record<string, number>>;
    getPosition?: () => number;
    active?: boolean;
  } = $props();

  let canvas2d: HTMLCanvasElement | undefined = $state();
  let canvasGl: HTMLCanvasElement | undefined = $state();
  let prefersReducedMotion = $state(false);
  let threeFailed = $state<Record<string, boolean>>({});
  let instance = $state<ThreeInstance | null>(null);
  let instanceStyle = $state<string | null>(null);

  const fallback2d = spectrumStyles[0];
  const failed2d = new Set<string>();
  let freqData: Uint8Array | null = null;
  let timeData: Uint8Array | null = null;
  const emptyFreq = new Uint8Array(1024);
  const emptyTime = new Uint8Array(2048).fill(128);

  let entry = $derived.by(() => {
    const found = visualStyleById(styleId);
    if (!found) return visualStyleById("bars")!;
    if (found.kind === "three" && threeFailed[found.id]) return visualStyleById("bars")!;
    return found;
  });

  onMount(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => (prefersReducedMotion = query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });

  // WebGL scene lifecycle: lazy-load the module, dispose on style change.
  $effect(() => {
    const current = entry;
    const target = canvasGl;
    if (current.kind !== "three" || !target || !active) return;
    let cancelled = false;
    current
      .load()
      .then((module) => {
        if (cancelled) return;
        instance = module.create(target);
        instanceStyle = current.id;
      })
      .catch((error) => {
        console.error(`spectrum style ${current.id} failed to initialize`, error);
        threeFailed = { ...threeFailed, [current.id]: true };
      });
    return () => {
      cancelled = true;
      instance?.dispose();
      instance = null;
      instanceStyle = null;
    };
  });

  $effect(() => {
    if (!active) return;
    const kind = entry.kind;
    const el2d = canvas2d;
    const elGl = canvasGl;
    if (!el2d || !elGl) return;
    const ctx = el2d.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let glWidth = 0;
    let glHeight = 0;
    let glDpr = 0;
    let lastTick = performance.now();
    const startedAt = lastTick;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - lastTick) / 1000);
      lastTick = now;

      let freq = emptyFreq;
      let time = emptyTime;
      if (analyser) {
        if (!freqData || freqData.length !== analyser.frequencyBinCount) {
          freqData = new Uint8Array(analyser.frequencyBinCount);
          timeData = new Uint8Array(analyser.fftSize);
        }
        analyser.getByteFrequencyData(freqData);
        analyser.getByteTimeDomainData(timeData!);
        freq = freqData;
        time = timeData!;
      }

      const dpr = window.devicePixelRatio || 1;
      if (kind === "2d" || !instance || instanceStyle !== entry.id) {
        const w = el2d.clientWidth;
        const h = el2d.clientHeight;
        if (w <= 0 || h <= 0) return;
        if (el2d.width !== w * dpr || el2d.height !== h * dpr) {
          el2d.width = w * dpr;
          el2d.height = h * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const style = entry.kind === "2d" ? entry.style : fallback2d;
        const frame: SpectrumFrame = {
          ctx,
          width: w,
          height: h,
          freq,
          time,
          positionFraction: getPosition(),
          prefersReducedMotion,
          options,
        };
        drawWithFallback(style, fallback2d, frame, failed2d, (error) =>
          console.error(`spectrum style ${style.id} failed`, error),
        );
      } else {
        const w = elGl.clientWidth;
        const h = elGl.clientHeight;
        if (w <= 0 || h <= 0) return;
        if (w !== glWidth || h !== glHeight || dpr !== glDpr) {
          glWidth = w;
          glHeight = h;
          glDpr = dpr;
          instance.resize(w, h, dpr);
        }
        instance.render({
          freq,
          time,
          positionFraction: getPosition(),
          dt,
          elapsed: (now - startedAt) / 1000,
          prefersReducedMotion,
          options,
        });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  let showGl = $derived(entry.kind === "three" && instance !== null && instanceStyle === entry.id);
</script>

<div class="spectrum-view">
  <canvas bind:this={canvas2d} class="layer" class:hidden={showGl}></canvas>
  <canvas bind:this={canvasGl} class="layer" class:hidden={!showGl}></canvas>
</div>

<style>
  .spectrum-view {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .layer.hidden {
    visibility: hidden;
  }
</style>
