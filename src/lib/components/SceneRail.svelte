<script lang="ts">
  import { api, errorText } from "../api";
  import { t } from "../i18n.svelte";
  import { bench } from "../state.svelte";

  let menu = $state<{ x: number; y: number; scene: string } | null>(null);
  let confirming = $state<string | null>(null);
  let deleteError = $state<string | null>(null);

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
    bench.selectedScene = path;
    const asset = matchingAsset(path);
    if (asset) bench.requestLoad(asset);
  }

  function openMenu(event: MouseEvent, scene: string) {
    event.preventDefault();
    const pad = 8;
    const x = Math.min(event.clientX, window.innerWidth - 180 - pad);
    const y = Math.min(event.clientY, window.innerHeight - 60 - pad);
    menu = { x, y, scene };
  }

  function requestDelete() {
    if (!menu) return;
    confirming = menu.scene;
    deleteError = null;
    menu = null;
  }

  async function confirmDelete() {
    const root = bench.project?.root;
    const scene = confirming;
    if (!root || !scene) return;
    try {
      await api.deleteScene(root, scene);
      confirming = null;
      bench.project = await api.refreshProject(root);
      bench.projectRevision++;
    } catch (error) {
      deleteError = errorText(error);
    }
  }
</script>

<svelte:window
  onclick={() => (menu = null)}
  onkeydown={(event) => {
    if (event.key === "Escape") {
      menu = null;
      confirming = null;
    }
  }}
/>

<aside class="scene-rail" aria-label="Project scenes">
  <header>
    <div>
      <span>{t("rail.scenes")}</span>
      <b>{bench.project?.scenes.length ?? 0}</b>
    </div>
    <span class="rail-signal" aria-hidden="true"></span>
  </header>

  <div class="scene-scroll">
    {#if !(bench.project?.scenes.length)}
      <p class="empty">{t("rail.empty")}</p>
    {:else}
      {#each bench.project.scenes as scene, index}
        {@const asset = matchingAsset(scene.rel_path)}
        <button
          class="scene-card"
          class:selected={bench.selectedScene === scene.rel_path}
          onclick={() => (bench.selectedScene = scene.rel_path)}
          oncontextmenu={(event) => openMenu(event, scene.rel_path)}
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
            aria-label={asset ? `${t("rail.play")} ${titleFor(scene.rel_path)}` : t("rail.noAudio")}
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
    <span>{bench.project?.root ?? t("rail.noProject")}</span>
  </footer>
</aside>

{#if menu}
  <div class="context-menu" role="menu" style={`left: ${menu.x}px; top: ${menu.y}px`}>
    <button role="menuitem" class="danger" onclick={requestDelete}>
      <span aria-hidden="true">⌫</span> {t("rail.menu.delete")}
    </button>
  </div>
{/if}

{#if confirming}
  <div class="confirm-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && (confirming = null)}>
    <div class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <h3 id="confirm-title">{t("rail.confirm.title")}</h3>
      <p>{t("rail.confirm.body", { name: confirming.split("/").at(-1) ?? confirming })}</p>
      {#if deleteError}<p class="confirm-error">{deleteError}</p>{/if}
      <div class="confirm-actions">
        <button class="ghost" onclick={() => (confirming = null)}>{t("rail.confirm.cancel")}</button>
        <button class="delete" onclick={confirmDelete}>{t("rail.confirm.delete")}</button>
      </div>
    </div>
  </div>
{/if}

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
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .13em;
    text-transform: uppercase;
  }
  header b {
    color: var(--accent);
    font: 11px var(--mono);
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
  .scene-copy small { overflow: hidden; color: var(--fg-muted); font: 10px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
  .scene-tags { display: flex; gap: 4px; }
  .scene-tags i { padding: 1px 4px; color: var(--fg-dim); background: var(--panel-raised); border-radius: 2px; font: normal 9px var(--mono); }
  .scene-play {
    display: grid;
    place-items: center;
    width: 23px;
    height: 23px;
    color: var(--fg-muted);
    border: 1px solid var(--line-strong);
    border-radius: 50%;
    font-size: 10px;
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
    font: 10px var(--mono);
  }
  footer span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pin { color: var(--accent); }
  .context-menu {
    position: fixed;
    z-index: 120;
    min-width: 170px;
    padding: 4px;
    border: 1px solid var(--accent-line);
    border-radius: 8px;
    background: var(--panel-raised);
    box-shadow: 0 16px 38px rgba(0,0,0,.55), 0 0 18px var(--accent-soft);
  }
  .context-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    color: var(--fg);
    border: 0;
    border-radius: 5px;
    background: transparent;
    font-size: 11.5px;
    text-align: left;
    cursor: pointer;
  }
  .context-menu button.danger { color: var(--bad); }
  .context-menu button.danger:hover { background: color-mix(in srgb, var(--bad) 12%, transparent); }
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 130;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(4, 5, 7, .62);
    backdrop-filter: blur(3px);
  }
  .confirm {
    width: min(360px, 100%);
    padding: 18px 20px;
    border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--line));
    border-radius: 11px;
    background: var(--panel-deep);
    box-shadow: 0 24px 70px rgba(0,0,0,.6);
  }
  .confirm h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
  .confirm p { margin: 0 0 6px; color: var(--fg-dim); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
  .confirm-error { color: var(--bad); font: 11px var(--mono); }
  .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .confirm-actions .ghost { padding: 7px 12px; color: var(--fg-dim); border: 1px solid var(--line-strong); border-radius: 6px; background: transparent; font-size: 11px; cursor: pointer; }
  .confirm-actions .ghost:hover { color: var(--fg); border-color: var(--accent-line-strong); }
  .confirm-actions .delete { padding: 7px 14px; color: #fff; border: 1px solid color-mix(in srgb, var(--bad) 80%, white); border-radius: 6px; background: color-mix(in srgb, var(--bad) 82%, black); box-shadow: 0 0 14px color-mix(in srgb, var(--bad) 26%, transparent); font-size: 11px; font-weight: 700; cursor: pointer; }
  .confirm-actions .delete:hover { filter: brightness(1.12); }
</style>
