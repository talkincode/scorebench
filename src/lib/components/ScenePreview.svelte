<script lang="ts">
  import { api, errorText, type SceneInspection } from "../api";
  import { t } from "../i18n.svelte";
  import { bench } from "../state.svelte";

  let inspection = $state<SceneInspection | null>(null);
  let error = $state<string | null>(null);
  let seq = 0;

  $effect(() => {
    const root = bench.project?.root;
    const path = bench.selectedScene;
    const revision = bench.projectRevision;
    const current = ++seq;
    inspection = null;
    error = null;
    if (!root || !path) return;
    void api.inspectScene(root, path, revision).then(
      (value) => {
        if (current === seq) inspection = value;
      },
      (cause) => {
        if (current === seq) error = errorText(cause);
      },
    );
  });

  const scene = $derived(inspection?.scene ?? null);

  function intensityWidth(value: number | null | undefined): string {
    return `${Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100)}%`;
  }
</script>

<div class="scene-preview">
  {#if !bench.selectedScene}
    <p class="empty">{t("preview.empty")}</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if !inspection}
    <p class="empty">{t("preview.loading")}</p>
  {:else if inspection.parse_error}
    <p class="error">{inspection.parse_error}</p>
  {:else if scene}
    <div class="scroll">
      <header class="head">
        <h2>{scene.title ?? bench.selectedScene.split("/").at(-1)}</h2>
        <div class="chips">
          {#if scene.tempo != null}<span class="chip"><b>{scene.tempo}</b> BPM</span>{/if}
          {#if scene.key}<span class="chip key">{scene.key}</span>{/if}
          {#if scene.time_signature}<span class="chip">{scene.time_signature}</span>{/if}
          {#if scene.bars != null}<span class="chip"><b>{scene.bars}</b> bars</span>{/if}
          {#if scene.loop_enabled}<span class="chip">loop</span>{/if}
          {#if scene.has_performance}<span class="chip">performance</span>{/if}
          {#if scene.textures.length}<span class="chip">{scene.textures.length} {t("preview.textures")}</span>{/if}
          <span class="chip status {inspection.validation.status}">{inspection.validation.status}</span>
        </div>
      </header>

      {#if scene.story}
        <section class="story">
          <h3>{t("preview.story")}</h3>
          <blockquote>{scene.story}</blockquote>
        </section>
      {/if}

      {#if scene.harmony.length}
        <section>
          <h3>{t("preview.harmony")}</h3>
          <div class="harmony">
            {#each scene.harmony as chord, index}
              <span class="chord" style={`--i: ${index}`}>{chord}</span>
            {/each}
          </div>
        </section>
      {/if}

      {#if scene.sections.length}
        <section>
          <h3>{t("preview.sections")} <em>{scene.sections.length}</em></h3>
          <div class="timeline">
            {#each scene.sections as section}
              <div class="segment" style={`--w: ${Math.max(1, section.bars ?? 4)}`}>
                <strong>{section.name ?? "—"}</strong>
                <span>{section.bars ?? "?"} bars{section.tempo ? ` · ${section.tempo}` : ""}</span>
                {#if section.intensity != null}
                  <i class="meter"><b style={`width: ${intensityWidth(section.intensity)}`}></b></i>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <section>
        <h3>{t("preview.tracks")} <em>{scene.tracks.length}</em></h3>
        {#if scene.tracks.length === 0}
          <p class="empty small">{t("preview.noTracks")}</p>
        {:else}
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{t("preview.instrument")}</th>
                <th>{t("preview.pattern")}</th>
                <th>{t("preview.motif")}</th>
                <th>{t("preview.articulation")}</th>
                <th class="num">{t("preview.intensity")}</th>
              </tr>
            </thead>
            <tbody>
              {#each scene.tracks as track, index}
                <tr>
                  <td class="idx">{index + 1}</td>
                  <td class="instrument">{track.instrument ?? "—"}</td>
                  <td>{track.pattern ?? "—"}</td>
                  <td>{track.motif ?? "—"}</td>
                  <td>{track.articulation ?? "—"}</td>
                  <td class="num">
                    {#if track.intensity != null}
                      <i class="meter"><b style={`width: ${intensityWidth(track.intensity)}`}></b></i>
                      <span>{track.intensity.toFixed(2)}</span>
                    {:else}—{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </section>

      {#if scene.textures.length}
        <section>
          <h3>{t("preview.textures")} <em>{scene.textures.length}</em></h3>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{t("preview.source")}</th>
                <th>{t("preview.mode")}</th>
                <th>{t("preview.schedule")}</th>
                <th class="num">{t("preview.gain")}</th>
              </tr>
            </thead>
            <tbody>
              {#each scene.textures as texture, index}
                <tr>
                  <td class="idx">{index + 1}</td>
                  <td class="instrument">{texture.source ?? "—"}</td>
                  <td>{texture.mode ?? "—"}</td>
                  <td>
                    {#if texture.mode === "loop"}
                      {t("preview.beat")} {texture.start_beat ?? 0}
                    {:else if texture.at.length}
                      {texture.at.join(", ")}
                    {:else}
                      —
                    {/if}
                  </td>
                  <td class="num">{(texture.gain ?? 1).toFixed(2)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/if}
    </div>
  {/if}
</div>

<style>
  .scene-preview {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .empty,
  .error {
    margin: auto;
    color: var(--fg-dim);
    font-size: 13px;
  }
  .empty.small {
    margin: 4px 0;
    font-size: 12px;
    text-align: left;
  }
  .error {
    color: var(--bad);
    font-family: var(--mono);
    font-size: 12px;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    padding: 20px 24px 28px;
    overflow-y: auto;
  }
  .head {
    position: relative;
    padding-bottom: 16px;
  }
  .head::after {
    content: "";
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 1px;
    background: linear-gradient(90deg, var(--accent-line-strong), var(--line) 55%, transparent);
  }
  .head h2 {
    margin: 0 0 10px;
    font-size: 21px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 3px 9px;
    color: var(--fg-dim);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    font: 10px var(--mono);
  }
  .chip b {
    color: var(--fg);
    font-weight: 650;
  }
  .chip.key {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
  }
  .chip.status.valid {
    color: var(--good);
    border-color: color-mix(in srgb, var(--good) 55%, transparent);
  }
  .chip.status.invalid {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 55%, transparent);
  }
  section {
    margin-top: 22px;
  }
  h3 {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin: 0 0 9px;
    color: var(--fg-label);
    font-size: var(--ui-label-size);
    font-weight: var(--ui-label-weight);
    letter-spacing: var(--ui-label-tracking);
    text-transform: uppercase;
  }
  h3 em {
    color: var(--fg-dim);
    font: 10px var(--mono);
  }
  .story blockquote {
    margin: 0;
    padding: 12px 16px;
    color: var(--fg);
    border: 1px solid var(--accent-line);
    border-radius: 10px;
    background: linear-gradient(160deg, var(--accent-soft), transparent 75%);
    font-size: 13px;
    line-height: 1.7;
    white-space: pre-wrap;
    opacity: 0.92;
  }
  .harmony {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .chord {
    padding: 5px 11px;
    color: var(--accent);
    border: 1px solid var(--accent-line);
    border-radius: 6px;
    background: linear-gradient(180deg, var(--accent-soft), transparent);
    font: 12px var(--mono);
    font-weight: 550;
    animation: chord-in 0.32s ease both;
    animation-delay: calc(var(--i) * 16ms);
  }
  .timeline {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .segment {
    display: flex;
    flex: var(--w) 1 0;
    flex-direction: column;
    gap: 3px;
    min-width: 86px;
    padding: 8px 10px;
    border: 1px solid var(--line-strong);
    border-radius: 7px;
    background: color-mix(in srgb, var(--panel-raised) 88%, transparent);
  }
  .segment strong {
    overflow: hidden;
    font-size: 12.5px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .segment span {
    color: var(--fg-dim);
    font: 9.5px var(--mono);
  }
  .meter {
    display: block;
    width: 100%;
    height: 3px;
    margin-top: 3px;
    overflow: hidden;
    border-radius: 3px;
    background: var(--line);
  }
  .meter b {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    box-shadow: 0 0 6px var(--accent-glow);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }
  th {
    padding: 6px 8px;
    color: var(--fg-label);
    border-bottom: 1px solid var(--line-strong);
    font-size: var(--ui-label-size);
    font-weight: 700;
    letter-spacing: var(--ui-label-tracking);
    text-align: left;
    text-transform: uppercase;
  }
  td {
    padding: 7px 8px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  tbody tr {
    transition: background 0.12s ease;
  }
  tbody tr:hover {
    background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
  }
  td.idx {
    color: var(--fg-dim);
    font: 10px var(--mono);
  }
  td.instrument {
    color: var(--fg);
    font-weight: 550;
  }
  th.num,
  td.num {
    width: 120px;
  }
  td.num {
    font: 10px var(--mono);
  }
  td.num .meter {
    display: inline-block;
    width: 64px;
    margin: 0 6px 1px 0;
    vertical-align: middle;
  }
  td.num span {
    color: var(--fg-dim);
  }
  @keyframes chord-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chord {
      animation: none;
    }
  }
</style>
