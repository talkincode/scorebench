<script lang="ts">
  import { bench } from "../state.svelte";

  $effect(() => {
    const scenes = bench.project?.scenes ?? [];
    if (!scenes.length) {
      bench.selectedScene = null;
    } else if (!scenes.some((scene) => scene.rel_path === bench.selectedScene)) {
      bench.selectedScene = scenes[0].rel_path;
    }
  });

  function titleFor(path: string): string {
    return path
      .split("/")
      .at(-1)!
      .replace(/\.ya?ml$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function matchingAsset(path: string): string | null {
    const stem = path.split("/").at(-1)!.replace(/\.ya?ml$/i, "");
    return (
      bench.project?.assets.find(
        (asset) => asset.kind === "audio" && asset.rel_path.split("/").at(-1)?.startsWith(`${stem}.`),
      )?.rel_path ?? null
    );
  }

  function play(event: Event, path: string) {
    event.stopPropagation();
    const asset = matchingAsset(path);
    if (asset) bench.requestLoad(asset);
  }
</script>

<aside class="scene-rail" aria-label="Project scenes">
  <header>
    <div>
      <span>Scenes</span>
      <b>{bench.project?.scenes.length ?? 0}</b>
    </div>
    <span class="rail-signal" aria-hidden="true"></span>
  </header>

  <div class="scene-scroll">
    {#if !(bench.project?.scenes.length)}
      <p class="empty">No scene YAML found.</p>
    {:else}
      {#each bench.project.scenes as scene, index}
        {@const asset = matchingAsset(scene.rel_path)}
        <button
          class="scene-card"
          class:selected={bench.selectedScene === scene.rel_path}
          onclick={() => (bench.selectedScene = scene.rel_path)}
          aria-pressed={bench.selectedScene === scene.rel_path}
        >
          <span class="scene-art art-{index % 7}" aria-hidden="true">
            <i></i><i></i><i></i>
          </span>
          <span class="scene-copy">
            <strong>{titleFor(scene.rel_path)}</strong>
            <small>{scene.rel_path}</small>
            <span class="scene-tags"><i>YAML</i><i>{index + 1}</i></span>
          </span>
          <span
            class="scene-play"
            class:available={Boolean(asset)}
            role="button"
            tabindex={asset ? 0 : -1}
            aria-label={asset ? `Play ${titleFor(scene.rel_path)}` : "No rendered audio"}
            onclick={(event) => play(event, scene.rel_path)}
            onkeydown={(event) => {
              if (event.key === "Enter" || event.key === " ") play(event, scene.rel_path);
            }}
          >{asset ? "▶" : "·"}</span>
        </button>
      {/each}
    {/if}
  </div>

  <footer>
    <span class="pin">⌖</span>
    <span>{bench.project?.root ?? "No project"}</span>
  </footer>
</aside>

<style>
  .scene-rail {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    border: 1px solid var(--accent-line);
    border-radius: var(--radius-lg);
    background: var(--panel-glass);
    box-shadow: var(--panel-shadow), inset 0 1px 0 rgba(255, 255, 255, .025);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 42px;
    padding: 0 12px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(90deg, var(--accent-soft), transparent 65%);
  }
  header div { display: flex; align-items: center; gap: 8px; }
  header span:first-child {
    color: var(--fg);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .13em;
    text-transform: uppercase;
  }
  header b {
    color: var(--accent);
    font: 9px var(--mono);
    font-weight: 500;
  }
  .rail-signal {
    width: 38px;
    height: 10px;
    opacity: .7;
    background: repeating-linear-gradient(90deg, transparent 0 3px, var(--accent) 3px 4px);
    mask-image: linear-gradient(90deg, transparent, #000 30%, #000);
  }
  .scene-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
  }
  .empty { margin: 14px 8px; color: var(--fg-dim); font-size: 11px; }
  .scene-card {
    position: relative;
    display: grid;
    grid-template-columns: 55px minmax(0, 1fr) 28px;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 66px;
    margin-bottom: 6px;
    padding: 6px;
    color: var(--fg);
    text-align: left;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    cursor: pointer;
    transition: border-color .18s ease, background .18s ease, transform .18s ease;
  }
  .scene-card:hover {
    transform: translateX(2px);
    background: color-mix(in srgb, var(--accent) 5%, transparent);
    border-color: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .scene-card.selected {
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 13%, transparent), color-mix(in srgb, var(--accent) 3%, transparent));
    border-color: color-mix(in srgb, var(--accent) 62%, transparent);
    box-shadow: inset 3px 0 0 var(--accent), 0 0 22px color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .scene-art {
    position: relative;
    display: grid;
    place-items: center;
    width: 55px;
    height: 50px;
    overflow: hidden;
    border-radius: 7px;
    background:
      radial-gradient(circle at 45% 38%, hsl(calc(var(--theme-hue) + 15) 90% 70% / .8), transparent 8%),
      linear-gradient(145deg, hsl(calc(var(--theme-hue) + var(--art-shift, 0)) 65% 30%), #030807 72%);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.11), inset 0 -16px 24px rgba(0,0,0,.44);
  }
  .scene-art::before, .scene-art::after {
    content: "";
    position: absolute;
    width: 72px;
    height: 1px;
    background: hsl(calc(var(--theme-hue) + var(--art-shift, 0)) 86% 64% / .5);
    transform: rotate(-28deg);
    box-shadow: 0 8px 0 hsl(calc(var(--theme-hue) + var(--art-shift, 0)) 86% 64% / .25), 0 -9px 0 hsl(calc(var(--theme-hue) + var(--art-shift, 0)) 86% 64% / .18);
  }
  .scene-art::after { transform: rotate(35deg); opacity: .45; }
  .scene-art i { width: 3px; height: 22px; background: var(--fg); opacity: .55; box-shadow: 7px 4px 0 var(--accent), -7px 8px 0 var(--accent); }
  .art-1 { --art-shift: 48; }
  .art-2 { --art-shift: 92; }
  .art-3 { --art-shift: 175; }
  .art-4 { --art-shift: 225; }
  .art-5 { --art-shift: 285; }
  .art-6 { --art-shift: 330; }
  .scene-copy { min-width: 0; display: grid; gap: 3px; }
  .scene-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 650; }
  .scene-copy small { overflow: hidden; color: var(--fg-muted); font: 8.5px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
  .scene-tags { display: flex; gap: 4px; }
  .scene-tags i { padding: 1px 4px; color: var(--fg-dim); background: var(--panel-raised); border-radius: 2px; font: normal 7.5px var(--mono); }
  .scene-play {
    display: grid;
    place-items: center;
    width: 23px;
    height: 23px;
    color: var(--fg-muted);
    border: 1px solid var(--line-strong);
    border-radius: 50%;
    font-size: 8px;
  }
  .scene-play.available { color: var(--accent); border-color: var(--accent-line-strong); }
  .scene-play.available:hover { color: var(--bg); background: var(--accent); box-shadow: 0 0 13px var(--accent-glow); }
  footer {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 10px;
    color: var(--fg-muted);
    border-top: 1px solid var(--line);
    font: 8px var(--mono);
  }
  footer span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pin { color: var(--accent); }
</style>
