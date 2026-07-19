<script lang="ts">
  import { api, errorText } from "../api";
  import { t } from "../i18n.svelte";
  import { bench } from "../state.svelte";

  let source = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let seq = 0;

  let editing = $state(false);
  let draft = $state("");
  let dirty = $derived(editing && source != null && draft !== source);
  let validating = $state(false);
  let saving = $state(false);
  let notice = $state<{ tone: "ok" | "err"; text: string } | null>(null);

  /** Unsaved drafts survive scene switches; keyed by root + rel path. */
  const drafts = new Map<string, string>();
  let currentKey: string | null = null;

  $effect(() => {
    const root = bench.project?.root;
    const path = bench.selectedScene;
    const revision = bench.projectRevision;
    void revision;
    const current = ++seq;
    const key = root && path ? `${root}::${path}` : null;
    if (key !== currentKey) {
      currentKey = key;
      editing = false;
      notice = null;
    }
    source = null;
    error = null;
    if (!root || !path) return;
    loading = true;
    void api.readSceneSource(root, path).then(
      (text) => {
        if (current !== seq) return;
        source = text;
        loading = false;
        const stored = key ? drafts.get(key) : undefined;
        if (stored !== undefined) {
          draft = stored;
          editing = true;
        }
      },
      (cause) => {
        if (current !== seq) return;
        error = errorText(cause);
        loading = false;
      },
    );
  });

  function startEdit() {
    if (source == null) return;
    draft = source;
    editing = true;
    notice = null;
  }

  function onDraftInput() {
    if (currentKey) drafts.set(currentKey, draft);
    notice = null;
  }

  function discard() {
    if (currentKey) drafts.delete(currentKey);
    editing = false;
    notice = null;
  }

  async function validate() {
    const root = bench.project?.root;
    if (!root || validating) return;
    validating = true;
    notice = null;
    try {
      const result = await api.validateSceneContent(root, draft);
      notice =
        result.status === "valid"
          ? { tone: "ok", text: t("source.valid") }
          : { tone: "err", text: result.error ? errorText(result.error) : result.status };
    } catch (cause) {
      notice = { tone: "err", text: errorText(cause) };
    } finally {
      validating = false;
    }
  }

  async function save() {
    const root = bench.project?.root;
    const path = bench.selectedScene;
    if (!root || !path || saving) return;
    saving = true;
    try {
      const warnings = await api.saveSceneSource(root, path, draft);
      if (currentKey) drafts.delete(currentKey);
      source = draft;
      notice = warnings.length
        ? { tone: "err", text: warnings.join("\n") }
        : { tone: "ok", text: t("source.saved") };
    } catch (cause) {
      notice = { tone: "err", text: errorText(cause) };
    } finally {
      saving = false;
    }
  }

  interface Token {
    text: string;
    cls: string;
  }

  /** Minimal YAML token pass, line oriented — enough for read-only display. */
  function tokenizeLine(line: string): Token[] {
    const tokens: Token[] = [];
    const commentAt = findComment(line);
    const body = commentAt >= 0 ? line.slice(0, commentAt) : line;
    const comment = commentAt >= 0 ? line.slice(commentAt) : null;

    const keyMatch = /^(\s*(?:-\s+)?)([^:#'"]+?)(:)(\s|$)/.exec(body);
    if (keyMatch) {
      tokens.push({ text: keyMatch[1], cls: "plain" });
      tokens.push({ text: keyMatch[2], cls: "key" });
      tokens.push({ text: keyMatch[3], cls: "punct" });
      pushValue(tokens, body.slice(keyMatch[0].length - keyMatch[4].length));
    } else {
      pushValue(tokens, body);
    }
    if (comment != null) tokens.push({ text: comment, cls: "comment" });
    return tokens;
  }

  function findComment(line: string): number {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "#" && (i === 0 || line[i - 1] === " ")) {
        return i;
      }
    }
    return -1;
  }

  function pushValue(tokens: Token[], text: string) {
    if (!text) return;
    const trimmed = text.trim();
    let cls = "plain";
    if (/^["'].*["']$/.test(trimmed)) cls = "string";
    else if (/^-?\d+(\.\d+)?$/.test(trimmed)) cls = "number";
    else if (/^(true|false|null|~|yes|no)$/i.test(trimmed)) cls = "bool";
    else if (trimmed.startsWith("- ")) cls = "plain";
    else if (trimmed.length) cls = "value";
    tokens.push({ text, cls });
  }

  const lines = $derived(source == null ? [] : source.replace(/\n$/, "").split("\n"));
  const editLines = $derived(draft.split("\n"));

  // Overlay highlighting: the textarea's text is transparent (caret stays
  // visible) and a tokenized mirror renders beneath with identical metrics.
  let highlightEl: HTMLDivElement | undefined = $state();
  let gutterEl: HTMLDivElement | undefined = $state();

  function syncScroll(event: Event) {
    const area = event.currentTarget as HTMLTextAreaElement;
    if (highlightEl) {
      highlightEl.scrollTop = area.scrollTop;
      highlightEl.scrollLeft = area.scrollLeft;
    }
    if (gutterEl) gutterEl.scrollTop = area.scrollTop;
  }
</script>

<div class="scene-source">
  {#if !bench.selectedScene}
    <p class="empty">{t("source.empty")}</p>
  {:else if loading}
    <p class="empty">{t("source.loading")}</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if source != null}
    <div class="banner">
      {#if editing}
        <span class="lock edit-mark" aria-hidden="true">✎</span>
        <span>{t("source.editing")}</span>
        {#if dirty}<i class="dirty" title={t("source.unsaved")}></i>{/if}
        <code>{bench.selectedScene}</code>
        <div class="actions">
          <button class="mini-ghost" onclick={discard} disabled={saving}>{t("source.discard")}</button>
          <button class="mini-ghost" onclick={validate} disabled={validating || saving}>
            {validating ? t("source.validating") : t("source.validate")}
          </button>
          <button class="mini-save" onclick={save} disabled={!dirty || saving}>
            {saving ? t("source.saving") : t("source.save")}
          </button>
        </div>
      {:else}
        <span class="lock" aria-hidden="true">◈</span>
        <span>{t("source.readOnly")}</span>
        <code>{bench.selectedScene}</code>
        <div class="actions">
          <button class="mini-ghost" onclick={startEdit}>{t("source.edit")}</button>
        </div>
      {/if}
    </div>
    {#if notice}
      <div class="notice {notice.tone}"><pre>{notice.text}</pre></div>
    {/if}
    {#if editing}
      <div class="editor-wrap">
        <div class="editor-gutter" bind:this={gutterEl} aria-hidden="true">
          <div class="gutter-inner">{#each editLines as _, index}{#if index > 0}{"\n"}{/if}{index + 1}{/each}{"\n"}</div>
        </div>
        <div class="editor-highlight" bind:this={highlightEl} aria-hidden="true">
          <div class="editor-metrics">{#each editLines as line, index}{#if index > 0}{"\n"}{/if}{#each tokenizeLine(line) as token}<span class={token.cls}>{token.text}</span>{/each}{/each}{"\n"}</div>
        </div>
        <textarea
          class="editor editor-metrics"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          wrap="off"
          bind:value={draft}
          oninput={onDraftInput}
          onscroll={syncScroll}
          aria-label="Scene YAML editor"
        ></textarea>
      </div>
    {:else}
      <div class="code" role="figure" aria-label="Scene YAML source">
        {#each lines as line, index}
          <div class="line">
            <span class="ln">{index + 1}</span>
            <span class="lc">
              {#each tokenizeLine(line) as token}<span class={token.cls}>{token.text}</span>{/each}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .scene-source {
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
  .error {
    color: var(--bad);
    font-family: var(--mono);
    font-size: 12px;
  }
  .banner {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    color: var(--fg-label);
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel-deep) 82%, transparent);
    font-size: var(--ui-label-size);
    font-weight: var(--ui-label-weight);
    letter-spacing: var(--ui-label-tracking);
    text-transform: uppercase;
  }
  .banner .lock {
    color: var(--accent);
  }
  .banner code {
    margin-left: auto;
    overflow: hidden;
    color: var(--fg-dim);
    font: 10px var(--mono);
    text-overflow: ellipsis;
    text-transform: none;
    white-space: nowrap;
  }
  .banner .edit-mark {
    color: var(--warning, #e8b45a);
  }
  .banner .dirty {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warning, #e8b45a);
    box-shadow: 0 0 8px color-mix(in srgb, var(--warning, #e8b45a) 55%, transparent);
  }
  .actions {
    display: flex;
    flex-shrink: 0;
    gap: 6px;
    margin-left: 10px;
  }
  .actions .mini-ghost {
    padding: 3px 10px;
    color: var(--fg-dim);
    border: 1px solid var(--line-strong);
    border-radius: 5px;
    background: transparent;
    font-size: 10.5px;
    letter-spacing: normal;
    text-transform: none;
    cursor: pointer;
    transition: color .15s ease, border-color .15s ease;
  }
  .actions .mini-ghost:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent-line-strong);
  }
  .actions .mini-save {
    padding: 3px 12px;
    color: var(--bg);
    border: 1px solid var(--accent-line-strong);
    border-radius: 5px;
    background: var(--accent);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: normal;
    text-transform: none;
    cursor: pointer;
  }
  .actions .mini-save:hover:not(:disabled) {
    filter: brightness(1.12);
  }
  .actions button:disabled {
    opacity: .45;
    cursor: default;
  }
  .notice {
    flex-shrink: 0;
    max-height: 130px;
    overflow: auto;
    padding: 7px 14px;
    border-bottom: 1px solid var(--line);
  }
  .notice pre {
    margin: 0;
    font: 11px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .notice.ok {
    color: var(--ok, var(--accent));
    background: color-mix(in srgb, var(--ok, var(--accent)) 7%, transparent);
  }
  .notice.err {
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 8%, transparent);
  }
  .editor-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .editor-wrap:focus-within {
    box-shadow: inset 0 2px 0 var(--accent-line-strong);
  }
  .editor-metrics {
    margin: 0;
    padding: 10px 14px 18px 58px;
    font: 11.5px/1.62 var(--mono);
    white-space: pre;
    tab-size: 2;
  }
  .editor-gutter {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 1;
    width: 44px;
    overflow: hidden;
    pointer-events: none;
    border-right: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel-deep) 55%, transparent);
  }
  .gutter-inner {
    padding: 10px 14px 18px 0;
    color: var(--fg-muted);
    font: 11.5px/1.62 var(--mono);
    text-align: right;
    white-space: pre;
    opacity: .55;
  }
  .editor-highlight {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    color: var(--fg-dim);
  }
  .editor {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: auto;
    color: transparent;
    caret-color: var(--fg);
    border: 0;
    background: transparent;
    resize: none;
  }
  .editor::selection {
    color: transparent;
    background: color-mix(in srgb, var(--accent) 26%, transparent);
  }
  .editor:focus {
    outline: none;
  }
  .code {
    flex: 1;
    min-height: 0;
    padding: 10px 0 18px;
    overflow: auto;
    font: 11.5px/1.62 var(--mono);
  }
  .line {
    display: flex;
    padding: 0 14px 0 0;
  }
  .line:hover {
    background: rgba(255, 255, 255, 0.018);
  }
  .ln {
    flex-shrink: 0;
    width: 44px;
    padding-right: 14px;
    color: var(--fg-muted);
    text-align: right;
    user-select: none;
    opacity: 0.55;
  }
  .lc {
    flex: 1;
    white-space: pre;
  }
  .lc .key,
  .editor-highlight .key {
    color: var(--accent);
  }
  .lc .punct,
  .editor-highlight .punct {
    color: var(--fg-muted);
  }
  .lc .string,
  .editor-highlight .string {
    color: var(--warning);
  }
  .lc .number,
  .editor-highlight .number {
    color: #b8a5f5;
  }
  .lc .bool,
  .editor-highlight .bool {
    color: #f08fb8;
  }
  .lc .value,
  .editor-highlight .value {
    color: var(--fg);
  }
  .lc .comment,
  .editor-highlight .comment {
    color: var(--fg-muted);
    font-style: italic;
  }
  .lc .plain,
  .editor-highlight .plain {
    color: var(--fg-dim);
  }
</style>
