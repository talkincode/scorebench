<script lang="ts">
  import { api, errorText, stylePackName, type StylePack } from "../api";
  import { i18n, t } from "../i18n.svelte";
  import { bench } from "../state.svelte";

  const NEW_PACK_TEMPLATE = `id: my-style
name: 我的风格
name_en: My Style
category: custom

defaults:
  tempo_bpm: [90, 120]
  density: medium
  dynamics: moderate

harmony:
  language: tonal

melody:
  range: moderate

arrangement:
  preferred:
    - piano

review:
  criteria:
    - melodic_coherence
`;

  const locale = $derived(i18n.locale);

  let selectedId = $state<string | null>(null);
  /** id passed as previous_id on save; null means creating a new pack. */
  let editingId = $state<string | null>(null);
  let draftYaml = $state("");
  let editingBuiltin = $state(false);
  let busy = $state(false);
  let status = $state<string | null>(null);
  let error = $state<string | null>(null);

  const dirty = $derived.by(() => {
    if (editingBuiltin) return false;
    const source = bench.stylePacks.find((p) => p.id === editingId);
    return draftYaml !== (source?.yaml ?? "");
  });

  async function refresh() {
    const [packs, warnings] = await api.listStylePacks();
    bench.stylePacks = packs;
    bench.styleWarnings = warnings;
  }

  function select(pack: StylePack) {
    selectedId = pack.id;
    editingId = pack.id;
    editingBuiltin = pack.builtin;
    draftYaml = pack.yaml;
    status = null;
    error = null;
  }

  function startNew() {
    selectedId = null;
    editingId = null;
    editingBuiltin = false;
    draftYaml = NEW_PACK_TEMPLATE;
    status = null;
    error = null;
  }

  function duplicate(pack: StylePack) {
    selectedId = null;
    editingId = null;
    editingBuiltin = false;
    draftYaml = pack.yaml.replace(/^id:\s*.*$/m, `id: ${pack.id}-copy`);
    status = null;
    error = null;
  }

  async function save() {
    if (busy || editingBuiltin) return;
    busy = true;
    status = null;
    error = null;
    try {
      const saved = await api.saveStylePack(draftYaml, editingId);
      await refresh();
      selectedId = saved.id;
      editingId = saved.id;
      draftYaml = saved.yaml;
      status = t("styles.saved");
    } catch (cause) {
      error = errorText(cause);
    } finally {
      busy = false;
    }
  }

  async function remove(pack: StylePack) {
    if (busy || pack.builtin) return;
    if (!window.confirm(t("styles.deleteConfirm", { name: stylePackName(pack, locale) }))) return;
    busy = true;
    error = null;
    try {
      await api.deleteStylePack(pack.id);
      if (bench.activeStyleId === pack.id) await setActive(null);
      await refresh();
      if (selectedId === pack.id) startNew();
    } catch (cause) {
      error = errorText(cause);
    } finally {
      busy = false;
    }
  }

  /** Persist the project's active pack; revert optimistic state on failure. */
  async function setActive(id: string | null) {
    const root = bench.project?.root;
    if (!root) return;
    const previous = bench.activeStyleId;
    bench.activeStyleId = id;
    try {
      await api.saveStyleConfig(root, id ? { id } : null);
    } catch (cause) {
      bench.activeStyleId = previous;
      error = errorText(cause);
    }
  }
</script>

<div class="styles">
  <header class="head">
    <div class="head-text">
      <h2>{t("styles.title")}</h2>
      <p>{t("styles.subtitle")}</p>
    </div>
    <button class="new" onclick={startNew} disabled={busy}>+ {t("styles.new")}</button>
  </header>

  {#if bench.styleWarnings.length}
    <div class="warnings">
      {#each bench.styleWarnings as warning}<p>⚠ {warning}</p>{/each}
    </div>
  {/if}

  <div class="body">
    <nav class="list" aria-label={t("styles.title")}>
      {#each bench.stylePacks as pack (pack.id)}
        <button class="item" class:on={selectedId === pack.id} onclick={() => select(pack)}>
          <span class="item-name">{stylePackName(pack, locale)}</span>
          <span class="item-meta">
            <code>{pack.id}</code>
            {#if pack.builtin}<em class="badge">{t("styles.builtinBadge")}</em>{/if}
            {#if bench.activeStyleId === pack.id}<em class="badge active">{t("styles.activeBadge")}</em>{/if}
          </span>
        </button>
      {/each}
    </nav>

    <section class="editor">
      <div class="editor-head">
        <strong>
          {#if editingId === null}
            {t("styles.newTitle")}
          {:else}
            {editingId}
          {/if}
        </strong>
        <div class="actions">
          {#if selectedId !== null}
            {@const pack = bench.stylePacks.find((p) => p.id === selectedId)}
            {#if pack}
              {#if bench.activeStyleId === pack.id}
                <button onclick={() => setActive(null)} disabled={busy}>{t("styles.deactivate")}</button>
              {:else}
                <button class="primary" onclick={() => setActive(pack.id)} disabled={busy || !bench.project}>
                  {t("styles.activate")}
                </button>
              {/if}
              <button onclick={() => duplicate(pack)} disabled={busy}>{t("styles.duplicate")}</button>
              {#if !pack.builtin}
                <button class="danger" onclick={() => remove(pack)} disabled={busy}>{t("styles.delete")}</button>
              {/if}
            {/if}
          {/if}
          {#if !editingBuiltin}
            <button class="primary" onclick={save} disabled={busy || !draftYaml.trim() || !dirty}>
              {t("styles.save")}
            </button>
          {/if}
        </div>
      </div>

      <textarea
        class="yaml"
        bind:value={draftYaml}
        readonly={editingBuiltin}
        spellcheck="false"
        aria-label={t("styles.title")}
      ></textarea>

      <footer class="editor-foot">
        {#if error}
          <p class="error">{error}</p>
        {:else if status}
          <p class="status">{status}</p>
        {:else if editingBuiltin}
          <p class="hint">{t("styles.builtinHint")}</p>
        {:else}
          <p class="hint">{t("styles.editorHint")}</p>
        {/if}
      </footer>
    </section>
  </div>
</div>

<style>
  .styles {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .head {
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--line);
  }
  .head h2 {
    margin: 0;
    color: var(--accent);
    font-size: var(--ui-label-size);
    font-weight: var(--ui-label-weight);
    letter-spacing: var(--ui-label-tracking);
    text-transform: uppercase;
  }
  .head p {
    max-width: 60ch;
    margin: 5px 0 0;
    color: var(--fg-dim);
    font-size: 12px;
    line-height: 1.55;
  }
  .new {
    flex-shrink: 0;
    height: 26px;
    padding: 0 12px;
    color: var(--accent);
    border: 1px solid var(--accent-line-strong);
    border-radius: 6px;
    background: var(--accent-soft);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .new:hover:not(:disabled) { box-shadow: 0 0 10px var(--accent-glow); }
  .warnings {
    flex-shrink: 0;
    padding: 6px 16px;
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--warning) 8%, transparent);
  }
  .warnings p { margin: 2px 0; color: var(--warning); font-size: 12px; }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .list {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 2px;
    width: 218px;
    padding: 8px;
    overflow-y: auto;
    border-right: 1px solid var(--line);
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px 10px;
    color: var(--fg-dim);
    text-align: left;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    cursor: pointer;
    transition: color 0.13s ease, border-color 0.13s ease, background 0.13s ease;
  }
  .item:hover { color: var(--fg); background: var(--control-bg); }
  .item.on {
    color: var(--fg);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
  }
  .item-name { font-size: 13px; font-weight: 600; line-height: 1.35; }
  .item-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .item-meta code { color: var(--fg-label); font: 10px var(--mono); }
  .badge {
    padding: 1px 6px;
    color: var(--fg-label);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    font-size: 10px;
    font-style: normal;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .badge.active {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
  }
  .editor {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: 10px 14px 12px;
  }
  .editor-head {
    display: flex;
    flex-shrink: 0;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .editor-head strong { color: var(--fg); font: 600 12px var(--mono); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
  .actions button {
    height: 25px;
    padding: 0 11px;
    color: var(--fg-dim);
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--control-bg);
    font-size: 12px;
    cursor: pointer;
    transition: color 0.13s ease, border-color 0.13s ease;
  }
  .actions button:hover:not(:disabled) { color: var(--fg); border-color: var(--accent-line-strong); }
  .actions button:disabled { opacity: 0.45; cursor: default; }
  .actions button.primary {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
  }
  .actions button.danger:hover:not(:disabled) {
    color: var(--bad);
    border-color: var(--bad);
  }
  .yaml {
    box-sizing: border-box;
    flex: 1;
    width: 100%;
    min-height: 0;
    padding: 11px 12px;
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-2);
    font: 12px/1.6 var(--mono);
    resize: none;
  }
  .yaml:focus { outline: none; border-color: var(--accent); }
  .yaml[readonly] { color: var(--fg-dim); }
  .editor-foot { flex-shrink: 0; margin-top: 7px; }
  .editor-foot p { margin: 0; font-size: 12px; line-height: 1.5; }
  .hint { color: var(--fg-dim); }
  .status { color: var(--accent); }
  .error { color: var(--bad); }
</style>
