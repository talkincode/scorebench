<script lang="ts">
  import { untrack } from "svelte";
  import { api, errorText, type Settings } from "../api";
  import { bench } from "../state.svelte";

  let draft = $state<Settings>({
    base_url: "https://api.openai.com/v1",
    model: "gpt-5.6",
    context_budget_tokens: 128000,
    max_turns: 16,
    spectrum_style: "bars",
    spectrum_bars: 64,
    theme_hue: 171,
  });
  let apiKey = $state("");
  let allowInsecureStorage = $state(false);
  let busy = $state(false);
  let result = $state<string | null>(null);
  let failed = $state(false);
  let closeButton = $state<HTMLButtonElement>();

  $effect(() => {
    const open = bench.settingsOpen;
    const settings = bench.settings;
    const warning = bench.settingsWarning;
    if (!open || !settings) return;

    // Do not track the draft we initialize here. Tracking `draft.theme_hue`
    // made every preview change retrigger this effect and snap back to the
    // saved hue before the browser could paint it.
    untrack(() => {
      draft = { ...settings };
      bench.themeHuePreview = settings.theme_hue;
      apiKey = "";
      allowInsecureStorage = false;
      result = warning;
      failed = Boolean(warning);
      queueMicrotask(() => closeButton?.focus());
    });
  });

  async function persist(): Promise<boolean> {
    busy = true;
    result = null;
    failed = false;
    try {
      await api.saveSettings(draft);
      const changingApiKey = Boolean(apiKey.trim());
      if (changingApiKey) {
        await api.setApiKey(apiKey.trim(), allowInsecureStorage);
      }
      const view = await api.getSettings();
      if (changingApiKey && !view.api_key_set) {
        throw new Error("API key storage could not be verified. The key was not saved.");
      }
      bench.settings = view.settings;
      bench.apiKeySet = view.api_key_set;
      bench.settingsWarning = view.warning ?? null;
      if (changingApiKey) apiKey = "";
      result = "Settings saved.";
      return true;
    } catch (err) {
      failed = true;
      result = errorText(err);
      return false;
    } finally {
      busy = false;
    }
  }

  async function saveAndClose() {
    if (await persist()) {
      bench.settingsOpen = false;
      bench.themeHuePreview = null;
    }
  }

  async function testConnection() {
    if (!(await persist())) return;
    busy = true;
    result = "Testing connection…";
    failed = false;
    try {
      result = await api.testConnection();
    } catch (err) {
      failed = true;
      result = errorText(err);
    } finally {
      busy = false;
    }
  }

  function close() {
    bench.settingsOpen = false;
    bench.themeHuePreview = null;
  }

  function closeBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) close();
  }

  function previewHue(value: number) {
    draft.theme_hue = Math.max(0, Math.min(359, Math.round(value)));
    bench.themeHuePreview = draft.theme_hue;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (bench.settingsOpen && event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if bench.settingsOpen}
  <div class="backdrop" role="presentation" onclick={closeBackdrop}>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="modal-head">
        <div>
          <h2 id="settings-title">Agent settings</h2>
          <p>Stored outside project directories. The API key is write-only.</p>
        </div>
        <button class="close" aria-label="Close settings" onclick={close} bind:this={closeButton}>×</button>
      </header>

      <div class="modal-body">
        <section class="theme-editor" aria-labelledby="theme-title">
          <div class="theme-copy">
            <strong id="theme-title">Interface tone</strong>
            <span>Live preview · {draft.theme_hue}°</span>
          </div>
          <div class="hue-line">
            <input
              class="hue-range"
              type="range"
              min="0"
              max="359"
              value={draft.theme_hue}
              aria-label="Interface hue"
              oninput={(event) => previewHue(Number(event.currentTarget.value))}
            />
            <div class="swatches" aria-label="Tone presets">
              {#each [171, 198, 264, 326, 36] as hue}
                <button
                  type="button"
                  class:active={draft.theme_hue === hue}
                  style={`--swatch-hue: ${hue}`}
                  aria-label={`Use ${hue} degree hue`}
                  title={`${hue}°`}
                  onclick={() => previewHue(hue)}
                ></button>
              {/each}
            </div>
          </div>
        </section>

        <label>
          <span>Responses API base URL</span>
          <input bind:value={draft.base_url} spellcheck="false" />
        </label>
        <label>
          <span>Model</span>
          <input bind:value={draft.model} spellcheck="false" />
        </label>
        <div class="row">
          <label>
            <span>Context budget</span>
            <input type="number" min="1024" max="2000000" bind:value={draft.context_budget_tokens} />
          </label>
          <label>
            <span>Maximum turns</span>
            <input type="number" min="1" max="128" bind:value={draft.max_turns} />
          </label>
        </div>
        <label>
          <span>API key · {bench.apiKeySet ? "set" : "not set"}</span>
          <input type="password" autocomplete="off" bind:value={apiKey} placeholder={bench.apiKeySet ? "Leave blank to keep the stored key" : "Enter API key"} />
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={allowInsecureStorage} />
          <span>If the OS keychain is unavailable, store the key insecurely in app config with mode 0600.</span>
        </label>

        {#if bench.versionInfo}
          <div class="versions">
            <h3>Version information</h3>
            <dl>
              <dt>scorebench</dt><dd>{bench.versionInfo.scorebench_version}</dd>
              <dt>scorekit</dt><dd>{bench.versionInfo.scorekit.version ?? "not reported"}</dd>
              <dt>tested range</dt><dd>{bench.versionInfo.scorekit.tested_range}</dd>
              <dt>path</dt><dd>{bench.versionInfo.scorekit.path ?? "not found"}</dd>
              <dt>doctor</dt><dd>{bench.versionInfo.scorekit.ready ? "ready" : "unhealthy"}</dd>
            </dl>
            {#if bench.versionInfo.scorekit.warning}<p>{bench.versionInfo.scorekit.warning}</p>{/if}
            {#if bench.versionInfo.scorekit.hints.length}
              <ul>{#each bench.versionInfo.scorekit.hints as hint}<li>{hint}</li>{/each}</ul>
            {/if}
          </div>
        {/if}

        {#if result}
          <p class:failed class="result">{result}</p>
        {/if}
      </div>

      <footer class="modal-actions">
        <button class="ghost" onclick={testConnection} disabled={busy}>Test connection</button>
        <span class="spacer"></span>
        <button class="ghost" onclick={close}>Cancel</button>
        <button class="primary" onclick={saveAndClose} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    min-width: 0;
    min-height: 0;
    padding: clamp(12px, 3vw, 32px);
    overflow: hidden;
    background: rgba(5, 5, 8, 0.68);
    backdrop-filter: blur(4px);
  }
  .modal {
    position: relative;
    inset: auto;
    display: flex;
    flex-direction: column;
    width: min(620px, 100%);
    max-height: 100%;
    min-height: 0;
    margin: 0;
    overflow: hidden;
    box-sizing: border-box;
    padding: 0;
    color: var(--fg);
    border: 1px solid var(--accent-line-strong);
    border-radius: 12px;
    background: var(--panel-deep);
    box-shadow: 0 28px 90px rgba(0, 0, 0, 0.62), 0 0 32px var(--accent-soft);
  }
  .modal-head, .modal-actions, .row {
    display: flex;
    gap: 12px;
  }
  .modal-head {
    flex: 0 0 auto;
    align-items: flex-start;
    padding: 18px 20px 15px;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(115deg, var(--accent-soft), transparent 68%);
  }
  .modal-body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 18px 20px;
    overflow: auto;
    overscroll-behavior: contain;
  }
  h2 { margin: 0; font-size: 19px; }
  .modal-head p { margin: 5px 0 0; color: var(--fg-dim); font-size: 12px; }
  .theme-editor {
    display: grid;
    gap: 10px;
    margin: 0 0 18px;
    padding: 13px;
    border: 1px solid var(--accent-line);
    border-radius: 10px;
    background: linear-gradient(135deg, var(--accent-soft), transparent 70%);
  }
  .theme-copy { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .theme-copy strong { color: var(--fg); font-size: 12px; letter-spacing: .04em; }
  .theme-copy span { color: var(--accent); font: 10px var(--mono); }
  .hue-line { display: flex; align-items: center; gap: 14px; }
  .hue-range {
    flex: 1;
    height: 7px;
    padding: 0;
    border: 0;
    background: linear-gradient(90deg, hsl(0 72% 52%), hsl(60 72% 52%), hsl(120 72% 52%), hsl(180 72% 52%), hsl(240 72% 58%), hsl(300 72% 55%), hsl(359 72% 52%));
    accent-color: var(--accent);
  }
  .swatches { display: flex; gap: 6px; }
  .swatches button {
    width: 18px;
    height: 18px;
    padding: 0;
    border: 2px solid var(--panel);
    border-radius: 50%;
    background: hsl(var(--swatch-hue) 78% 57%);
    box-shadow: 0 0 0 1px var(--line);
    cursor: pointer;
  }
  .swatches button.active { box-shadow: 0 0 0 1px var(--fg), 0 0 12px hsl(var(--swatch-hue) 80% 55% / .6); }
  .close {
    margin-left: auto;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-dim);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover, .close:focus-visible {
    color: var(--accent);
    border-color: var(--accent-line-strong);
    background: var(--accent-soft);
  }
  label { display: grid; gap: 6px; margin-bottom: 14px; flex: 1; }
  label > span { color: var(--fg-dim); font-size: 12px; }
  input {
    box-sizing: border-box;
    width: 100%;
    padding: 9px 10px;
    color: var(--fg);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    font: 13px var(--mono);
  }
  input:focus { outline: none; border-color: var(--accent); }
  .check { display: flex; grid-template-columns: auto 1fr; align-items: flex-start; }
  .check input { width: auto; margin-top: 2px; }
  .check span { line-height: 1.45; }
  .result {
    padding: 9px 11px;
    color: var(--good);
    border: 1px solid color-mix(in srgb, var(--good) 35%, transparent);
    border-radius: 8px;
    font-size: 12px;
  }
  .result.failed { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 35%, transparent); }
  .versions { margin-top: 16px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
  .versions h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; color: var(--fg-dim); }
  .versions dl { display: grid; grid-template-columns: 95px 1fr; gap: 5px 8px; margin: 0; font: 11px var(--mono); }
  .versions dt { color: var(--fg-dim); }
  .versions dd { margin: 0; overflow-wrap: anywhere; }
  .versions p, .versions ul { color: var(--bad); font-size: 11px; line-height: 1.45; }
  .versions ul { color: var(--fg-dim); padding-left: 18px; }
  .modal-actions {
    flex: 0 0 auto;
    align-items: center;
    padding: 13px 20px;
    border-top: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel-deep) 92%, black);
  }
  .spacer { flex: 1; }

  @media (max-width: 620px) {
    .backdrop { padding: 8px; }
    .modal-head, .modal-body, .modal-actions { padding-right: 14px; padding-left: 14px; }
    .row, .hue-line { align-items: stretch; flex-direction: column; }
    .swatches { justify-content: flex-end; }
  }
</style>
