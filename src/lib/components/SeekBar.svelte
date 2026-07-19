<script lang="ts">
  let {
    value = 0,
    max = 0,
    disabled = false,
    onscrub,
    oncommit,
    fmt = (t: number) => t.toFixed(1),
  }: {
    value?: number;
    max?: number;
    disabled?: boolean;
    onscrub?: (value: number) => void;
    oncommit?: (value: number) => void;
    fmt?: (t: number) => string;
  } = $props();

  let track: HTMLDivElement | undefined = $state();
  let dragging = $state(false);
  let hoverAt = $state<number | null>(null);

  let fraction = $derived(max > 0 ? Math.min(1, Math.max(0, value / max)) : 0);

  function timeAt(clientX: number): number {
    if (!track || max <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * max;
  }

  function onPointerDown(event: PointerEvent) {
    if (disabled || max <= 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = true;
    onscrub?.(timeAt(event.clientX));
  }

  function onPointerMove(event: PointerEvent) {
    if (!disabled && max > 0) hoverAt = timeAt(event.clientX);
    if (dragging) onscrub?.(timeAt(event.clientX));
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    oncommit?.(timeAt(event.clientX));
  }

  function onKeydown(event: KeyboardEvent) {
    if (disabled || max <= 0) return;
    const step = event.shiftKey ? 5 : 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = value - step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = value + step;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = max;
    if (next == null) return;
    event.preventDefault();
    oncommit?.(Math.min(max, Math.max(0, next)));
  }
</script>

<div
  class="seekbar"
  class:disabled
  class:dragging
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-label="Seek"
  aria-valuemin={0}
  aria-valuemax={max}
  aria-valuenow={value}
  aria-valuetext={fmt(value)}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={() => (dragging = false)}
  onpointerleave={() => (hoverAt = null)}
  onkeydown={onKeydown}
>
  <div class="track" bind:this={track}>
    <div class="ticks" aria-hidden="true"></div>
    <div class="fill" style={`width: ${fraction * 100}%`}></div>
    {#if hoverAt != null && !disabled}
      <div class="ghost" style={`width: ${(hoverAt / Math.max(max, 0.001)) * 100}%`} aria-hidden="true"></div>
    {/if}
    <div class="thumb" style={`left: ${fraction * 100}%`} aria-hidden="true"><i></i></div>
  </div>
  {#if hoverAt != null && !disabled}
    <span class="tip" style={`left: ${(hoverAt / Math.max(max, 0.001)) * 100}%`}>{fmt(hoverAt)}</span>
  {/if}
</div>

<style>
  .seekbar {
    position: relative;
    height: 16px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .seekbar:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 3px;
    border-radius: 4px;
  }
  .seekbar.disabled {
    cursor: default;
    opacity: 0.42;
  }
  .track {
    position: relative;
    width: 100%;
    height: 4px;
    border-radius: 4px;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0.55), rgba(255, 255, 255, 0.035));
    box-shadow:
      inset 0 1px 2px rgba(0, 0, 0, 0.6),
      0 1px 0 rgba(255, 255, 255, 0.03);
  }
  .ticks {
    position: absolute;
    inset: -3px 0;
    background: repeating-linear-gradient(
      90deg,
      transparent 0,
      transparent calc(10% - 1px),
      hsl(var(--theme-hue) 60% 60% / 0.16) calc(10% - 1px),
      hsl(var(--theme-hue) 60% 60% / 0.16) 10%
    );
    mask-image: linear-gradient(180deg, #000 0 2px, transparent 2px calc(100% - 2px), #000 calc(100% - 2px));
  }
  .ghost {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 4px;
    background: hsl(var(--theme-hue) 70% 60% / 0.14);
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    box-shadow: 0 0 8px var(--accent-glow);
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--accent) 80%, white);
    background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--accent) 45%, white), var(--accent) 62%);
    box-shadow:
      0 0 10px var(--accent-glow),
      0 1px 3px rgba(0, 0, 0, 0.5);
    transform: translate(-50%, -50%);
    transition: transform 0.12s ease;
    display: grid;
    place-items: center;
  }
  .thumb i {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.85);
  }
  .seekbar:hover:not(.disabled) .thumb,
  .seekbar.dragging .thumb {
    transform: translate(-50%, -50%) scale(1.28);
  }
  .seekbar.disabled .thumb {
    display: none;
  }
  .tip {
    position: absolute;
    bottom: calc(100% + 3px);
    padding: 2px 6px;
    color: var(--fg);
    border: 1px solid var(--accent-line);
    border-radius: 4px;
    background: var(--panel-raised);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    font: 10px var(--mono);
    transform: translateX(-50%);
    pointer-events: none;
    white-space: nowrap;
  }
</style>
