<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    drawWithFallback,
    FrameBudgetMeter,
    spectrumStyles,
    ThreeInstanceCache,
    nextThreeStyleToPreload,
    visualStyleById,
    visualStyles,
    type SpectrumFrame,
    type ThreeStyleModule,
    type VisualStyleEntry,
  } from "../spectrum";
  import { idleSpectrum } from "../spectrum/dynamics";
  import { MoodEngine, type MoodState } from "../spectrum/mood";

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
  let glCanvases = $state<Record<string, HTMLCanvasElement | undefined>>({});
  let prefersReducedMotion = $state(false);
  let threeFailed = $state<Record<string, boolean>>({});
  let loadedModules = $state<Record<string, ThreeStyleModule | undefined>>({});
  let readyStyles = $state<Record<string, boolean>>({});
  let canvasGenerations = $state<Record<string, number>>({});

  const fallback2d = spectrumStyles[0];
  const failed2d = new Set<string>();
  type ThreeStyleEntry = Extract<VisualStyleEntry, { kind: "three" }>;
  const threeStyles = visualStyles.filter(
    (candidate): candidate is ThreeStyleEntry => candidate.kind === "three",
  );
  const loadingModules = new Set<string>();
  const glSizes = new Map<string, { width: number; height: number; dpr: number }>();
  const glElapsed = new Map<string, number>();
  const frameBudgets = new Map<string, FrameBudgetMeter>();
  let freqData: Uint8Array | null = null;
  let timeData: Uint8Array | null = null;
  const emptyFreq = new Uint8Array(1024);
  const emptyTime = new Uint8Array(2048).fill(128);
  /** Perception substrate — one engine per view, run only for mood-aware styles. */
  let moodEngine: MoodEngine | null = null;
  let destroyed = false;

  function forgetReadyStyle(styleId: string): void {
    if (readyStyles[styleId]) {
      const next = { ...readyStyles };
      delete next[styleId];
      readyStyles = next;
    }
    glSizes.delete(styleId);
    glElapsed.delete(styleId);
    frameBudgets.delete(styleId);
    // A canvas whose WebGL context was explicitly lost is not reused. Remount
    // just this style's canvas so an evicted LRU entry can be selected again.
    canvasGenerations = {
      ...canvasGenerations,
      [styleId]: (canvasGenerations[styleId] ?? 0) + 1,
    };
  }

  const instanceCache = new ThreeInstanceCache(2, (styleId, error) => {
    if (error) console.error(`spectrum style ${styleId} failed to dispose`, error);
    if (!destroyed) forgetReadyStyle(styleId);
  });

  function failThreeStyle(styleId: string, error: unknown): void {
    if (destroyed || threeFailed[styleId]) return;
    console.error(`spectrum style ${styleId} failed`, error);
    threeFailed = { ...threeFailed, [styleId]: true };
    const removed = instanceCache.remove(styleId, (failedStyleId, disposeError) =>
      console.error(`spectrum style ${failedStyleId} failed to dispose`, disposeError),
    );
    if (!removed) forgetReadyStyle(styleId);
  }

  function recordFrameCost(styleId: string, startedAt: number): void {
    let meter = frameBudgets.get(styleId);
    if (!meter) {
      meter = new FrameBudgetMeter();
      frameBudgets.set(styleId, meter);
    }
    const summary = meter.record(performance.now() - startedAt);
    if (!summary) return;
    window.dispatchEvent(
      new CustomEvent("scorebench:spectrum-performance", {
        detail: {
          styleId,
          ...summary,
          budgetMs: 8,
          overBudget: summary.averageMs > 8,
        },
      }),
    );
  }

  let entry = $derived.by(() => {
    const found = visualStyleById(styleId);
    if (!found) return visualStyleById("bars")!;
    if (found.kind === "three" && threeFailed[found.id]) return visualStyleById("bars")!;
    return found;
  });

  function registerGlCanvas(node: HTMLCanvasElement, styleId: string) {
    const onContextLost = (event: Event) => {
      // `dispose()` intentionally loses the context after first removing the
      // instance from the cache. Only unexpected loss of a live entry fails a
      // style for the session.
      if (!instanceCache.get(styleId)) return;
      event.preventDefault();
      failThreeStyle(styleId, new Error("WebGL context lost"));
    };
    node.addEventListener("webglcontextlost", onContextLost);
    glCanvases = { ...glCanvases, [styleId]: node };
    return {
      destroy() {
        node.removeEventListener("webglcontextlost", onContextLost);
        if (glCanvases[styleId] !== node) return;
        const next = { ...glCanvases };
        delete next[styleId];
        glCanvases = next;
      },
    };
  }

  function loadThreeModule(style: ThreeStyleEntry): void {
    if (loadedModules[style.id] || loadingModules.has(style.id) || threeFailed[style.id]) return;
    loadingModules.add(style.id);
    void style
      .load()
      .then((module) => {
        if (!destroyed) loadedModules = { ...loadedModules, [style.id]: module };
      })
      .catch((error) => {
        if (destroyed) return;
        failThreeStyle(style.id, error);
      })
      .finally(() => loadingModules.delete(style.id));
  }

  onMount(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => (prefersReducedMotion = query.matches);
    update();
    query.addEventListener("change", update);

    const host = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    // Warm at most one likely-next module. Loading every future imagery here
    // would turn code-splitting into an unconditional post-startup cost.
    const preload = () => {
      if (document.visibilityState === "hidden") return;
      const currentId = entry.kind === "three" ? entry.id : null;
      const unavailable = new Set([
        ...Object.keys(loadedModules),
        ...Object.keys(threeFailed),
      ]);
      const candidate = nextThreeStyleToPreload(currentId, unavailable);
      if (candidate) loadThreeModule(candidate);
    };
    const idleHandle = host.requestIdleCallback?.(preload, { timeout: 1800 });
    const timeoutHandle =
      idleHandle === undefined ? window.setTimeout(preload, 1800) : undefined;

    return () => {
      query.removeEventListener("change", update);
      if (idleHandle !== undefined) host.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
    };
  });

  onDestroy(() => {
    destroyed = true;
    instanceCache.disposeAll((styleId, error) =>
      console.error(`spectrum style ${styleId} failed to dispose`, error),
    );
    glSizes.clear();
    glElapsed.clear();
    frameBudgets.clear();
  });

  // WebGL scenes are created on first use, then retained for instant switching.
  $effect(() => {
    const current = entry;
    if (current.kind !== "three" || !active || threeFailed[current.id]) return;
    const target = glCanvases[current.id];
    const module = loadedModules[current.id];
    if (!target || instanceCache.get(current.id)) return;
    if (!module) {
      loadThreeModule(current);
      return;
    }
    try {
      instanceCache.getOrCreate(current.id, () => module.create(target));
      readyStyles = { ...readyStyles, [current.id]: true };
    } catch (error) {
      failThreeStyle(current.id, error);
    }
  });

  $effect(() => {
    const current = entry;
    const currentStyleId = current.kind === "three" ? current.id : null;
    const currentInstance =
      currentStyleId && readyStyles[currentStyleId]
        ? instanceCache.get(currentStyleId)
        : undefined;
    const elGl = currentStyleId ? glCanvases[currentStyleId] : undefined;
    if (!active) return;
    const el2d = canvas2d;
    if (!el2d) return;
    const ctx = el2d.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastTick = performance.now();
    let lastIdleFrame = 0;
    const startedAt = lastTick;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (document.visibilityState === "hidden") {
        lastTick = now;
        return;
      }
      // The synthetic idle stage does not need a 60 Hz analyser/render loop.
      if (!analyser && now - lastIdleFrame < 1000 / 30) return;
      const dt = Math.min(0.1, (now - lastTick) / 1000);
      lastTick = now;
      if (!analyser) lastIdleFrame = now;
      const frameStartedAt = performance.now();

      let freq: Uint8Array = idleSpectrum(emptyFreq, (now - startedAt) / 1000);
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

      // Emotion coordinates enter the frame contract here: computed once per
      // frame, only while the active style declares itself mood-aware.
      let mood: MoodState | undefined;
      if (current.moodAware) {
        moodEngine ??= new MoodEngine();
        const intentMode = options.intentMode;
        mood = moodEngine.update(freq, dt, {
          binHz: (options.sampleRate ?? 48000) / Math.max(2, freq.length * 2),
          intent: intentMode === undefined ? undefined : { modeMajor: intentMode },
        });
      } else {
        moodEngine = null;
      }

      const dpr = window.devicePixelRatio || 1;
      if (current.kind === "2d" || !currentInstance || !currentStyleId) {
        const w = el2d.clientWidth;
        const h = el2d.clientHeight;
        if (w <= 0 || h <= 0) return;
        if (el2d.width !== w * dpr || el2d.height !== h * dpr) {
          el2d.width = w * dpr;
          el2d.height = h * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const style = current.kind === "2d" ? current.style : fallback2d;
        const frame: SpectrumFrame = {
          ctx,
          width: w,
          height: h,
          freq,
          time,
          positionFraction: getPosition(),
          prefersReducedMotion,
          options,
          mood,
        };
        drawWithFallback(style, fallback2d, frame, failed2d, (error) =>
          console.error(`spectrum style ${style.id} failed`, error),
        );
        recordFrameCost(style.id, frameStartedAt);
      } else {
        if (!elGl) return;
        try {
          const w = elGl.clientWidth;
          const h = elGl.clientHeight;
          if (w <= 0 || h <= 0) return;
          const previousSize = glSizes.get(currentStyleId);
          if (
            !previousSize ||
            w !== previousSize.width ||
            h !== previousSize.height ||
            dpr !== previousSize.dpr
          ) {
            glSizes.set(currentStyleId, { width: w, height: h, dpr });
            currentInstance.resize(w, h, dpr);
          }
          const elapsed = (glElapsed.get(currentStyleId) ?? 0) + dt;
          glElapsed.set(currentStyleId, elapsed);
          currentInstance.render({
            freq,
            time,
            positionFraction: getPosition(),
            dt,
            elapsed,
            prefersReducedMotion,
            options,
            mood,
          });
          recordFrameCost(currentStyleId, frameStartedAt);
        } catch (error) {
          failThreeStyle(currentStyleId, error);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  let activeGlStyleId = $derived(
    active && entry.kind === "three" && readyStyles[entry.id] ? entry.id : null,
  );
  let showGl = $derived(activeGlStyleId !== null);

  /** Canvas currently on screen — the element video export captures. */
  export function getActiveCanvas(): HTMLCanvasElement | null {
    return (activeGlStyleId ? glCanvases[activeGlStyleId] : canvas2d) ?? null;
  }
</script>

<div class="spectrum-view">
  <canvas bind:this={canvas2d} class="layer" class:hidden={showGl}></canvas>
  {#each threeStyles as threeStyle (threeStyle.id)}
    {#key canvasGenerations[threeStyle.id] ?? 0}
      <canvas
        use:registerGlCanvas={threeStyle.id}
        class="layer"
        class:hidden={activeGlStyleId !== threeStyle.id}
      ></canvas>
    {/key}
  {/each}
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
