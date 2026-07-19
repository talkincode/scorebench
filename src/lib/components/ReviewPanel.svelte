<script lang="ts">
  import { api, errorText, type ReviewReport, type ReviewSuggestion } from "../api";
  import { t, type MessageKey } from "../i18n.svelte";
  import { bench } from "../state.svelte";

  const ROLES = ["composer", "arranger", "producer", "scoring", "child"] as const;

  let rawView: HTMLPreElement | undefined = $state();

  const report = $derived(bench.reviewReport);
  const staleScene = $derived(
    bench.reviewReport !== null && bench.reviewScene !== bench.selectedScene,
  );

  function roleName(role: string): string {
    const key = `review.role.${role}` as MessageKey;
    const text = t(key);
    return text === key ? role : text;
  }

  function levelName(level: string): string {
    const key = `review.level.${level}` as MessageKey;
    const text = t(key);
    return text === key ? level : text;
  }

  function togglePerspective(id: string) {
    if (bench.reviewBusy) return;
    bench.reviewPerspectives = bench.reviewPerspectives.includes(id)
      ? bench.reviewPerspectives.filter((p) => p !== id)
      : [...bench.reviewPerspectives, id];
  }

  async function run() {
    const root = bench.project?.root;
    const session = bench.activeSession;
    const scene = bench.selectedScene;
    if (!root || !session || !scene || bench.reviewBusy) return;
    if (bench.reviewPerspectives.length === 0) return;
    bench.reviewBusy = true;
    bench.reviewRaw = "";
    bench.reviewReport = null;
    bench.reviewError = null;
    try {
      const result = await api.runReview(root, session, scene, bench.reviewPerspectives, (e) => {
        if (e.type === "delta") {
          bench.reviewRaw += e.text;
          if (rawView) rawView.scrollTop = rawView.scrollHeight;
        }
      });
      bench.reviewReport = result;
      bench.reviewScene = scene;
    } catch (cause) {
      const kind = (cause as { kind?: string })?.kind;
      bench.reviewError = kind === "cancelled" ? t("review.cancelled") : errorText(cause);
    } finally {
      bench.reviewBusy = false;
    }
  }

  function cancel() {
    const root = bench.project?.root;
    if (root) void api.cancelReview(root);
  }

  function toAgent(suggestion: ReviewSuggestion) {
    const lines = [suggestion.text];
    if (suggestion.rationale) lines.push(`${t("review.rationale")}: ${suggestion.rationale}`);
    const tags = [
      suggestion.priority && `${t("review.priority")}: ${levelName(suggestion.priority)}`,
      suggestion.severity && `${t("review.severity")}: ${levelName(suggestion.severity)}`,
    ].filter(Boolean);
    if (tags.length) lines.push(tags.join(" · "));
    bench.chatDraft = `${t("review.toAgentPrefix")}\n${lines.join("\n")}`;
    bench.workspaceTab = "agent";
  }

  function suggestionCount(r: ReviewReport): number {
    return r.suggestions.length;
  }
</script>

<div class="review">
  <header class="controls">
    <div class="roles" role="group" aria-label={t("review.perspectives")}>
      {#each ROLES as id}
        <button
          class="role"
          class:on={bench.reviewPerspectives.includes(id)}
          onclick={() => togglePerspective(id)}
          disabled={bench.reviewBusy}
          aria-pressed={bench.reviewPerspectives.includes(id)}
        >
          {roleName(id)}
        </button>
      {/each}
    </div>
    {#if bench.reviewBusy}
      <button class="run stop" onclick={cancel}>{t("review.stop")}</button>
    {:else}
      <button
        class="run"
        onclick={run}
        disabled={!bench.selectedScene || !bench.activeSession || bench.reviewPerspectives.length === 0 || !bench.apiKeySet}
      >
        {t("review.run")}
      </button>
    {/if}
  </header>
  <p class="basis">{t("review.basis")}</p>

  <div class="body">
    {#if bench.reviewBusy}
      <pre class="raw" bind:this={rawView}>{bench.reviewRaw || t("review.running")}</pre>
    {:else if bench.reviewError}
      <p class="error">{bench.reviewError}</p>
    {:else if report}
      <div class="scroll">
        {#if staleScene}
          <p class="stale">{t("review.stale", { scene: bench.reviewScene ?? "" })}</p>
        {/if}

        <div class="cards">
          {#each report.perspectives as p}
            <article class="card sev-{p.severity}">
              <header>
                <strong>{roleName(p.role)}</strong>
                <span class="badges">
                  <span class="badge sev">{t("review.severity")} {levelName(p.severity)}</span>
                  <span class="badge conf">{t("review.confidence")} {levelName(p.confidence)}</span>
                </span>
              </header>
              {#if p.headline}<p class="headline">{p.headline}</p>{/if}
              {#if p.strengths.length}
                <h4>{t("review.strengths")}</h4>
                <ul>{#each p.strengths as item}<li>{item}</li>{/each}</ul>
              {/if}
              {#if p.issues.length}
                <h4 class="issues">{t("review.issues")}</h4>
                <ul>{#each p.issues as item}<li>{item}</li>{/each}</ul>
              {/if}
            </article>
          {/each}
        </div>

        {#if report.tensions.length}
          <section>
            <h3>{t("review.tensions")}</h3>
            {#each report.tensions as tension}
              <div class="tension">
                <span class="parties">{tension.between.map(roleName).join(" · ")}</span>
                <p>{tension.point}</p>
              </div>
            {/each}
          </section>
        {/if}

        {#if report.consensus.length}
          <section>
            <h3>{t("review.consensus")}</h3>
            <ul class="consensus">
              {#each report.consensus as item}<li>{item}</li>{/each}
            </ul>
          </section>
        {/if}

        {#if suggestionCount(report)}
          <section>
            <h3>{t("review.suggestions")}</h3>
            {#each report.suggestions as suggestion}
              <div class="suggestion">
                <div class="text">
                  {#if suggestion.priority || suggestion.severity}
                    <span class="tags">
                      {#if suggestion.priority}
                        <span class="badge lvl-{suggestion.priority}">{t("review.priority")} {levelName(suggestion.priority)}</span>
                      {/if}
                      {#if suggestion.severity}
                        <span class="badge lvl-{suggestion.severity}">{t("review.severity")} {levelName(suggestion.severity)}</span>
                      {/if}
                    </span>
                  {/if}
                  <p>{suggestion.text}</p>
                  {#if suggestion.rationale}<span class="why">{suggestion.rationale}</span>{/if}
                </div>
                <button class="hand" onclick={() => toAgent(suggestion)}>
                  {t("review.toAgent")}
                </button>
              </div>
            {/each}
          </section>
        {/if}
      </div>
    {:else}
      <p class="empty">{t("review.empty")}</p>
    {/if}
  </div>
</div>

<style>
  .review {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .controls {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 8px;
  }
  .roles {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .role {
    padding: 5px 11px;
    color: var(--fg-dim);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: transparent;
    font: 11px var(--mono);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .role:hover:not(:disabled) {
    color: var(--fg);
    border-color: var(--accent-line);
  }
  .role.on {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
  }
  .role:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .run {
    flex-shrink: 0;
    padding: 6px 16px;
    color: var(--accent);
    border: 1px solid var(--accent-line-strong);
    border-radius: 7px;
    background: var(--accent-soft);
    font: 600 11.5px var(--mono);
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: background 0.15s, box-shadow 0.15s;
  }
  .run:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    box-shadow: 0 0 12px var(--accent-glow);
  }
  .run:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .run.stop {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 55%, transparent);
    background: color-mix(in srgb, var(--bad) 8%, transparent);
  }
  .basis {
    margin: 0;
    padding: 0 16px 10px;
    color: var(--fg-muted);
    font: 10px var(--mono);
  }
  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid var(--line);
  }
  .empty,
  .error {
    margin: auto;
    color: var(--fg-dim);
    font-size: 12px;
    padding: 0 24px;
    text-align: center;
  }
  .error {
    color: var(--bad);
    font-family: var(--mono);
    font-size: 11px;
    white-space: pre-wrap;
  }
  .raw {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 16px 20px;
    overflow-y: auto;
    color: var(--fg-dim);
    font: 11px/1.6 var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    padding: 16px 20px 28px;
    overflow-y: auto;
  }
  .stale {
    margin: 0 0 12px;
    padding: 7px 11px;
    color: var(--warning);
    border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
    border-radius: 7px;
    font: 10.5px var(--mono);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
  }
  .card {
    padding: 12px 14px;
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    background: color-mix(in srgb, var(--panel-raised) 88%, transparent);
  }
  .card.sev-high {
    border-color: color-mix(in srgb, var(--bad) 45%, transparent);
  }
  .card.sev-medium {
    border-color: color-mix(in srgb, var(--warning) 38%, transparent);
  }
  .card header {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
    justify-content: space-between;
  }
  .card header strong {
    font-size: 12.5px;
    font-weight: 650;
  }
  .badges {
    display: flex;
    gap: 5px;
  }
  .badge {
    padding: 2px 7px;
    color: var(--fg-dim);
    border: 1px solid var(--line);
    border-radius: 999px;
    font: 9px var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .sev-high .badge.sev {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 50%, transparent);
  }
  .sev-medium .badge.sev {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 45%, transparent);
  }
  .headline {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.5;
  }
  .card h4 {
    margin: 10px 0 4px;
    color: var(--good);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .card h4.issues {
    color: var(--warning);
  }
  .card ul {
    margin: 0;
    padding-left: 16px;
  }
  .card li {
    margin: 3px 0;
    color: var(--fg-dim);
    font-size: 11.5px;
    line-height: 1.5;
  }
  section {
    margin-top: 20px;
  }
  h3 {
    margin: 0 0 8px;
    color: var(--fg-label);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .tension {
    margin-bottom: 8px;
    padding: 9px 12px;
    border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--warning) 4%, transparent);
  }
  .tension .parties {
    color: var(--warning);
    font: 600 10px var(--mono);
  }
  .tension p {
    margin: 4px 0 0;
    color: var(--fg);
    font-size: 11.5px;
    line-height: 1.5;
  }
  .consensus {
    margin: 0;
    padding-left: 16px;
  }
  .consensus li {
    margin: 4px 0;
    color: var(--fg);
    font-size: 11.5px;
    line-height: 1.5;
  }
  .suggestion {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 8px;
    padding: 10px 12px;
    border: 1px solid var(--accent-line);
    border-radius: 8px;
    background: var(--accent-soft);
  }
  .suggestion .text p {
    margin: 0;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 6px;
  }
  .badge.lvl-high {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 50%, transparent);
  }
  .badge.lvl-medium {
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 45%, transparent);
  }
  .suggestion .why {
    display: block;
    margin-top: 3px;
    color: var(--fg-dim);
    font-size: 10.5px;
    line-height: 1.45;
  }
  .hand {
    flex-shrink: 0;
    padding: 5px 11px;
    color: var(--accent);
    border: 1px solid var(--accent-line-strong);
    border-radius: 6px;
    background: transparent;
    font: 600 10px var(--mono);
    cursor: pointer;
    transition: background 0.15s;
  }
  .hand:hover {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
</style>
