<script lang="ts">
  // Derivative of the project's cat trademark: bolt-browed cat in an orbit ring,
  // redrawn as accent-colored line art. Inherits color via currentColor.
  // Brand asset — not covered by the MIT license; see TRADEMARKS.md.
  let { size = 32, ring = true }: { size?: number; ring?: boolean } = $props();
</script>

<svg
  viewBox="0 0 120 120"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if ring}
    <circle cx="60" cy="60" r="55" stroke-width="4.5" opacity=".9" />
    <circle cx="96" cy="35" r="4.5" fill="currentColor" stroke="none" />
    <path d="M99 46q2 6.5-.5 13" stroke-width="3.5" />
  {/if}
  <path d="M31 52 L33 17 L50.5 33.5" stroke-width="4.5" />
  <path d="M89 52 L87 17 L69.5 33.5" stroke-width="4.5" />
  <circle cx="60" cy="65" r="33" stroke-width="4.5" />
  <path
    d="M60 33.5 L61.8 38.2 L66.5 40 L61.8 41.8 L60 46.5 L58.2 41.8 L53.5 40 L58.2 38.2 Z"
    fill="currentColor"
    stroke="none"
  />
  <path d="M63 48 L54.5 59 L59.5 59 L56.5 68.5 L65.5 57 L60.5 57 Z" fill="currentColor" stroke-width="1.5" />
  <circle cx="45" cy="64" r="6.5" fill="currentColor" stroke="none" />
  <circle cx="75" cy="64" r="6.5" fill="currentColor" stroke="none" />
  <circle cx="47.3" cy="61.7" r="2" class="glint" stroke="none" />
  <circle cx="77.3" cy="61.7" r="2" class="glint" stroke="none" />
  <path d="M54 76 L66 76 L60 83.5 Z" fill="currentColor" stroke-width="2" />
  <path d="M49.5 87 Q54.5 93 60 87.5 Q65.5 93 70.5 87" stroke-width="3.5" />
  <path d="M20 69.5 L35 71" stroke-width="3.2" />
  <path d="M19 78 L34.5 78.2" stroke-width="3.2" />
  <path d="M20 86.5 L35 85" stroke-width="3.2" />
  <path d="M100 69.5 L85 71" stroke-width="3.2" />
  <path d="M101 78 L85.5 78.2" stroke-width="3.2" />
  <path d="M100 86.5 L85 85" stroke-width="3.2" />
</svg>

<style>
  svg { display: block; }
  .glint { fill: var(--panel-deep, #050b09); }
</style>
