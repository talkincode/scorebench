<script lang="ts">
  import { api, errorText } from "../api";
  import { t } from "../i18n.svelte";
  import { bench } from "../state.svelte";

  let source = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let seq = 0;

  $effect(() => {
    const root = bench.project?.root;
    const path = bench.selectedScene;
    const revision = bench.projectRevision;
    void revision;
    const current = ++seq;
    source = null;
    error = null;
    if (!root || !path) return;
    loading = true;
    void api.readSceneSource(root, path).then(
      (text) => {
        if (current !== seq) return;
        source = text;
        loading = false;
      },
      (cause) => {
        if (current !== seq) return;
        error = errorText(cause);
        loading = false;
      },
    );
  });

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
      <span class="lock" aria-hidden="true">◈</span>
      <span>{t("source.readOnly")}</span>
      <code>{bench.selectedScene}</code>
    </div>
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
    font-size: 12px;
  }
  .error {
    color: var(--bad);
    font-family: var(--mono);
    font-size: 11px;
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
  .lc .key {
    color: var(--accent);
  }
  .lc .punct {
    color: var(--fg-muted);
  }
  .lc .string {
    color: var(--warning);
  }
  .lc .number {
    color: #b8a5f5;
  }
  .lc .bool {
    color: #f08fb8;
  }
  .lc .value {
    color: var(--fg);
  }
  .lc .comment {
    color: var(--fg-muted);
    font-style: italic;
  }
  .lc .plain {
    color: var(--fg-dim);
  }
</style>
