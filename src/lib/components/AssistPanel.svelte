<script lang="ts">
  /**
   * Creative assist panel: categorized prompt tags the user clicks into the
   * chat input, plus the preset style selector. Tags are prompt tooling;
   * the style selector persists a structured style pack id to bench.json,
   * which the agent injects with conflict detection on every run. The agent
   * stays the only writer of scene YAML.
   */
  import { ASSIST_CATEGORIES, recommendedFor } from "../assist";
  import { api, stylePackName } from "../api";
  import { i18n, t } from "../i18n.svelte";
  import { bench } from "../state.svelte";

  let activeCategory = $state(ASSIST_CATEGORIES[0].id);
  let selected = $state<Set<string>>(new Set());

  const locale = $derived(i18n.locale);
  const recommended = $derived(recommendedFor(selected));
  const category = $derived(
    ASSIST_CATEGORIES.find((entry) => entry.id === activeCategory) ?? ASSIST_CATEGORIES[0],
  );

  /** Persist the project's style pack; revert optimistic state on failure. */
  async function setStyle(id: string | null) {
    const root = bench.project?.root;
    if (!root) return;
    const previous = bench.activeStyleId;
    const next = id === previous ? null : id;
    bench.activeStyleId = next;
    try {
      await api.saveStyleConfig(root, next ? { id: next } : null);
    } catch {
      bench.activeStyleId = previous;
    }
  }

  function openStyleManager() {
    bench.workspaceTab = "styles";
    bench.assistOpen = false;
  }

  function categoryHasRecommendation(id: string): boolean {
    const entry = ASSIST_CATEGORIES.find((candidate) => candidate.id === id);
    return Boolean(entry?.tags.some((tag) => recommended.has(tag.id)));
  }

  function toggle(tagId: string, text: { en: string; zh: string }) {
    const next = new Set(selected);
    if (next.has(tagId)) {
      // Deselect only: the inserted line stays in the input for the user to edit.
      next.delete(tagId);
    } else {
      next.add(tagId);
      bench.requestChatInsert(text[locale]);
    }
    selected = next;
  }

  function clearSelection() {
    selected = new Set();
  }

  function close() {
    bench.assistOpen = false;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<section class="assist" aria-label={t("assist.title")}>
  <header class="assist-head">
    <h2>✦ {t("assist.title")}</h2>
    {#if selected.size}
      <button class="clear" onclick={clearSelection}>{t("assist.clear")} ({selected.size})</button>
    {/if}
    <button class="close" onclick={close} aria-label={t("assist.close")}>×</button>
  </header>

  <div class="style-row" title={t("assist.styleHint")}>
    <span class="style-label">◈ {t("assist.styleLabel")}</span>
    <div class="style-chips">
      <button class="style-chip" class:on={!bench.activeStyleId} onclick={() => setStyle(null)}>
        {t("assist.styleNone")}
      </button>
      {#each bench.stylePacks as pack (pack.id)}
        <button
          class="style-chip"
          class:on={pack.id === bench.activeStyleId}
          onclick={() => setStyle(pack.id)}
          title={pack.id}
        >
          {stylePackName(pack, locale)}
        </button>
      {/each}
    </div>
    <button class="style-manage" onclick={openStyleManager}>{t("assist.styleManage")} ›</button>
  </div>

  <nav class="cats" aria-label={t("assist.title")}>
    {#each ASSIST_CATEGORIES as entry}
      <button
        class:active={entry.id === activeCategory}
        onclick={() => (activeCategory = entry.id)}
        aria-pressed={entry.id === activeCategory}
      >
        {entry.label[locale]}
        {#if categoryHasRecommendation(entry.id)}<i class="rec-dot" aria-hidden="true"></i>{/if}
      </button>
    {/each}
  </nav>

  <div class="tags">
    {#each category.tags as tag (tag.id)}
      <button
        class="tag"
        class:selected={selected.has(tag.id)}
        class:hinted={recommended.has(tag.id)}
        onclick={() => toggle(tag.id, tag.text)}
        title={tag.text[locale]}
      >
        {#if recommended.has(tag.id)}<i aria-hidden="true">◆</i>{/if}
        {tag.label[locale]}
      </button>
    {/each}
  </div>

  <p class="assist-tip">
    {#if recommended.size}
      <span class="rec-swatch" aria-hidden="true">◆</span> {t("assist.recommended")}
    {:else}
      {t("assist.hint")}
    {/if}
  </p>
</section>

<style>
  .assist {
    position: absolute;
    z-index: 40;
    right: 12px;
    bottom: calc(100% + 8px);
    left: 12px;
    display: flex;
    flex-direction: column;
    max-height: 340px;
    border: 1px solid var(--accent-line);
    border-radius: 10px;
    background: var(--panel-raised);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55), 0 0 26px var(--accent-soft);
  }
  .assist-head { display: flex; flex-shrink: 0; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--line); }
  .assist-head h2 { flex: 1; margin: 0; color: var(--accent); font-size: var(--ui-label-size); font-weight: var(--ui-label-weight); letter-spacing: var(--ui-label-tracking); text-transform: uppercase; }
  .clear { height: 22px; padding: 0 9px; color: var(--fg-dim); border: 1px solid var(--line-strong); border-radius: 999px; background: transparent; font-size: 11px; cursor: pointer; }
  .clear:hover { color: var(--fg); border-color: var(--accent-line-strong); }
  .close { display: grid; place-items: center; width: 22px; height: 22px; color: var(--fg-label); border: 0; border-radius: 5px; background: transparent; font-size: 16px; cursor: pointer; }
  .close:hover { color: var(--fg); background: var(--accent-soft); }

  .style-row { display: flex; flex-shrink: 0; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  .style-label { flex-shrink: 0; color: var(--accent); font-size: var(--ui-label-size); font-weight: var(--ui-label-weight); letter-spacing: var(--ui-label-tracking); text-transform: uppercase; }
  .style-chips { display: flex; flex: 1; gap: 5px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .style-chips::-webkit-scrollbar { display: none; }
  .style-chip { flex-shrink: 0; height: 24px; padding: 0 10px; color: var(--fg-dim); border: 1px solid var(--line-strong); border-radius: 999px; background: var(--control-bg); font-size: 12px; white-space: nowrap; cursor: pointer; transition: color 0.13s ease, border-color 0.13s ease, box-shadow 0.13s ease; }
  .style-chip:hover { color: var(--fg); border-color: var(--accent-line-strong); }
  .style-chip.on { color: var(--bg); border-color: color-mix(in srgb, var(--accent) 75%, white); background: var(--accent); box-shadow: 0 0 10px var(--accent-glow); }
  .style-manage { flex-shrink: 0; height: 24px; padding: 0 9px; color: var(--fg-label); border: 0; border-radius: 5px; background: transparent; font-size: 11px; letter-spacing: .04em; cursor: pointer; }
  .style-manage:hover { color: var(--accent); background: var(--accent-soft); }

  .cats { display: flex; flex-shrink: 0; gap: 2px; padding: 7px 10px 0; overflow-x: auto; }
  .cats button { position: relative; display: flex; align-items: center; gap: 5px; height: 26px; padding: 0 11px; color: var(--fg-dim); border: 1px solid transparent; border-radius: 7px 7px 0 0; background: transparent; font-size: 12px; white-space: nowrap; cursor: pointer; }
  .cats button:hover { color: var(--fg); }
  .cats button.active { color: var(--accent); border-color: var(--line-strong); border-bottom-color: var(--panel-raised); background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .rec-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--good, var(--accent)); box-shadow: 0 0 6px var(--good, var(--accent)); }

  .tags { display: flex; flex: 1; flex-wrap: wrap; align-content: flex-start; gap: 6px; min-height: 0; padding: 11px 12px; overflow-y: auto; border-top: 1px solid var(--line); }
  .tag { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 11px; color: var(--fg-dim); border: 1px solid var(--line-strong); border-radius: 999px; background: var(--control-bg); font-size: 12px; cursor: pointer; transition: color 0.13s ease, border-color 0.13s ease, box-shadow 0.13s ease; }
  .tag:hover { color: var(--fg); border-color: var(--accent-line-strong); }
  .tag.selected { color: var(--bg); border-color: color-mix(in srgb, var(--accent) 75%, white); background: var(--accent); box-shadow: 0 0 10px var(--accent-glow); }
  .tag.hinted:not(.selected) { color: var(--good, var(--accent)); border-color: color-mix(in srgb, var(--good, var(--accent)) 55%, transparent); background: color-mix(in srgb, var(--good, var(--accent)) 10%, transparent); box-shadow: 0 0 8px color-mix(in srgb, var(--good, var(--accent)) 30%, transparent); }
  .tag i { font-size: 9px; font-style: normal; }

  .assist-tip { display: flex; flex-shrink: 0; align-items: center; gap: 6px; margin: 0; padding: 7px 12px 9px; color: var(--fg-label); font-size: 11px; line-height: 1.4; border-top: 1px solid var(--line); }
  .rec-swatch { color: var(--good, var(--accent)); font-size: 10px; }
</style>
