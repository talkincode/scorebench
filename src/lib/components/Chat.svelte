<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { api, errorText, type AgentEvent } from "../api";
  import { t } from "../i18n.svelte";
  import { bench } from "../state.svelte";
  import BrandMark from "./BrandMark.svelte";
  import AssistPanel from "./AssistPanel.svelte";

  let input = $state("");
  let scroller: HTMLDivElement | undefined = $state();
  let pendingAttachments = $state<string[]>([]);
  let newOpen = $state(false);
  let newTitle = $state("");
  let newLinkScene = $state(true);
  let transcriptLoading = $state(false);
  let ready = $derived(Boolean(bench.project && bench.settings && bench.apiKeySet));
  let sessionScene = $derived(bench.sessions.find((session) => session.id === bench.activeSession)?.scene ?? null);
  const prompts = [
    ["✦", "Nostalgic piano", "in G major, 3/4, 8 bars"],
    ["▮▮▮", "Cinematic strings", "with a slow build, 4/4"],
    ["◆", "Chiptune boss theme", "in D minor, 16 bars"],
  ];

  $effect(() => {
    void bench.messages.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  // Consume a chat draft handed over from the review panel ("hand to Agent").
  $effect(() => {
    if (bench.chatDraft !== null) {
      input = bench.chatDraft;
      bench.chatDraft = null;
    }
  });

  // Append assist-panel insertions as new lines (draft above is replace-style).
  $effect(() => {
    const insert = bench.chatInsert;
    if (insert === null) return;
    bench.chatInsert = null;
    input = input.trim() ? `${input.replace(/\s*$/, "")}\n${insert.text}` : insert.text;
  });

  // Load the session index once per project root.
  let loadedRoot: string | null = null;
  $effect(() => {
    const root = bench.project?.root ?? null;
    if (root === loadedRoot) return;
    loadedRoot = root;
    bench.sessions = [];
    bench.activeSession = null;
    bench.messages = [];
    if (!root) return;
    void api.listSessions(root).then(
      (index) => {
        if (bench.project?.root !== root) return;
        bench.sessions = index.sessions;
        bench.activeSession = index.active;
        void loadTranscript(root, index.active);
      },
      (error) => bench.messages.push({ role: "tool", tone: "err", text: errorText(error) }),
    );
  });

  async function loadTranscript(root: string, session: string) {
    transcriptLoading = true;
    try {
      const transcript = await api.sessionTranscript(root, session);
      if (bench.project?.root !== root || bench.activeSession !== session) return;
      bench.messages = transcript.map((entry) => ({ role: entry.role, text: entry.text }));
    } catch (error) {
      bench.messages = [{ role: "tool", tone: "err", text: errorText(error) }];
    } finally {
      transcriptLoading = false;
    }
  }

  async function switchSession(id: string) {
    const root = bench.project?.root;
    if (!root || bench.agentBusy || id === bench.activeSession) return;
    try {
      await api.selectSession(root, id);
      bench.activeSession = id;
      const meta = bench.sessions.find((session) => session.id === id);
      if (meta?.scene) bench.selectedScene = meta.scene;
      await loadTranscript(root, id);
    } catch (error) {
      bench.messages.push({ role: "tool", tone: "err", text: errorText(error) });
    }
  }

  async function createSession() {
    const root = bench.project?.root;
    if (!root || bench.agentBusy) return;
    const scene = newLinkScene ? (bench.selectedScene ?? null) : null;
    try {
      const meta = await api.createSession(root, newTitle.trim() || null, scene);
      bench.sessions = [...bench.sessions, meta];
      bench.activeSession = meta.id;
      bench.messages = [];
      newOpen = false;
      newTitle = "";
    } catch (error) {
      bench.messages.push({ role: "tool", tone: "err", text: errorText(error) });
    }
  }

  async function attach() {
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        { name: "Documents", extensions: ["pdf", "txt", "md", "yaml", "yml", "json"] },
      ],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    pendingAttachments = [...new Set([...pendingAttachments, ...paths])];
  }

  function removeAttachment(path: string) {
    pendingAttachments = pendingAttachments.filter((entry) => entry !== path);
  }

  function fileName(path: string): string {
    return path.split("/").at(-1) ?? path;
  }

  function onAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "text":
        if (bench.messages.at(-1)?.role === "agent") bench.messages[bench.messages.length - 1].text += event.text;
        else bench.messages.push({ role: "agent", text: event.text });
        break;
      case "warning":
        bench.messages.push({ role: "tool", tone: "err", text: event.text });
        break;
      case "compacted":
        bench.messages.push({ role: "tool", tone: "ok", text: `Compacted ${event.turns} turn${event.turns === 1 ? "" : "s"} into project memory` });
        break;
      case "tool_start":
        bench.messages.push({ role: "tool", tone: "run", text: event.detail });
        break;
      case "tool_ok":
        bench.messages.push({ role: "tool", tone: "ok", text: `${event.name} ✓ ${event.summary}`, detail: event.detail ?? undefined });
        break;
      case "tool_err":
        bench.messages.push({ role: "tool", tone: "err", text: `${event.name} ✗ ${errorText(event.error)}` });
        break;
      case "done":
        bench.agentBusy = false;
        break;
    }
  }

  async function send() {
    const message = input.trim();
    const session = bench.activeSession;
    if (!message || !bench.project || !session || !ready || bench.agentBusy) return;
    const attachments = pendingAttachments;
    input = "";
    pendingAttachments = [];
    bench.messages.push({
      role: "user",
      text: message,
      attachments: attachments.length ? attachments.map(fileName) : undefined,
    });
    bench.agentBusy = true;
    try {
      await api.sendChat(bench.project.root, session, message, attachments, onAgentEvent);
    } catch (error) {
      bench.messages.push({ role: "tool", tone: "err", text: errorText(error) });
      bench.agentBusy = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  async function stop() {
    if (!bench.project || !bench.activeSession || !bench.agentBusy) return;
    await api.cancelAgent(bench.project.root, bench.activeSession).catch(() => {});
  }
</script>

<div class="chat">
  {#if bench.project && bench.sessions.length}
    <div class="session-bar">
      <span class="session-label">{t("chat.session")}</span>
      <select
        value={bench.activeSession}
        disabled={bench.agentBusy}
        onchange={(event) => void switchSession(event.currentTarget.value)}
      >
        {#each bench.sessions as session (session.id)}
          <option value={session.id}>{session.title}{session.scene ? ` · ${fileName(session.scene)}` : ""}</option>
        {/each}
      </select>
      <button class="session-new" onclick={() => (newOpen = !newOpen)} disabled={bench.agentBusy}>
        ＋ {t("chat.newSession")}
      </button>
      {#if newOpen}
        <div class="new-popover">
          <input
            type="text"
            placeholder={t("chat.newSessionTitle")}
            bind:value={newTitle}
            onkeydown={(event) => event.key === "Enter" && void createSession()}
          />
          <label class="link-scene">
            <input type="checkbox" bind:checked={newLinkScene} disabled={!bench.selectedScene} />
            <span>{t("chat.newSessionScene")}{bench.selectedScene ? ` (${fileName(bench.selectedScene)})` : ""}</span>
          </label>
          <div class="new-actions">
            <button class="mini-ghost" onclick={() => (newOpen = false)}>{t("chat.newSessionCancel")}</button>
            <button class="mini-primary" onclick={createSession}>{t("chat.newSessionCreate")}</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <div class="messages" bind:this={scroller}>
    {#if transcriptLoading}
      <p class="transcript-loading">{t("chat.loadingTranscript")}</p>
    {:else if bench.messages.length === 0}
      <div class="empty-state">
        <div class="signal-orbit" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
          <i><BrandMark size={40} ring={false} /></i>
        </div>
        <div class="empty-copy">
          <h1>{t("chat.emptyTitle")}</h1>
          <p>{bench.apiKeySet ? t("chat.emptyReady") : t("chat.emptyNoKey")}</p>
          <small>{t("chat.emptyHint")}</small>
        </div>
        {#if !sessionScene}
          <div class="prompt-grid">
            {#each prompts as prompt}
              <button onclick={() => (input = `${prompt[1]} ${prompt[2]}`)} disabled={!ready}>
                <i>{prompt[0]}</i><span><strong>{prompt[1]}</strong><small>{prompt[2]}</small></span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {:else}
      <div class="message-stream">
        {#each bench.messages as message}
          <div class="msg {message.role} {message.tone ?? ''}">
            {#if message.role === "tool"}
              <span class="dot" aria-hidden="true"></span>
              <span class="tool-line">{message.text}</span>
              {#if message.detail}<details><summary>{t("chat.output")}</summary><pre>{message.detail}</pre></details>{/if}
            {:else}
              {message.text}
              {#if message.attachments?.length}
                <span class="msg-files">
                  {#each message.attachments as name}<em>⎘ {name}</em>{/each}
                </span>
              {/if}
            {/if}
          </div>
        {/each}
        {#if bench.agentBusy}<div class="msg agent thinking"><i></i><i></i><i></i></div>{/if}
      </div>
    {/if}
  </div>

  <div class="composer-wrap">
    {#if bench.assistOpen}
      <AssistPanel />
    {/if}
    {#if pendingAttachments.length}
      <div class="attach-chips">
        {#each pendingAttachments as path (path)}
          <span class="chip" title={path}>
            ⎘ {fileName(path)}
            <button onclick={() => removeAttachment(path)} aria-label={t("chat.removeAttachment")}>×</button>
          </span>
        {/each}
      </div>
    {/if}
    <div class="composer" class:ready>
      <button class="attach" onclick={attach} disabled={!ready || bench.agentBusy} aria-label={t("chat.attach")} title={t("chat.attach")}>⎘</button>
      <button
        class="attach assist-toggle"
        class:on={bench.assistOpen}
        onclick={() => (bench.assistOpen = !bench.assistOpen)}
        disabled={!ready || bench.agentBusy}
        aria-pressed={bench.assistOpen}
        aria-label={t("chat.assist")}
        title={t("chat.assist")}>✦</button
      >
      <textarea
        rows="2"
        placeholder={!bench.project ? t("chat.placeholderNoProject") : !bench.apiKeySet ? t("chat.placeholderNoKey") : t("chat.placeholder")}
        disabled={!ready || bench.agentBusy}
        bind:value={input}
        onkeydown={onKeydown}
      ></textarea>
      {#if bench.agentBusy}
        <button class="stop" onclick={stop} aria-label={t("chat.stop")}>■</button>
      {:else}
        <button class="send" onclick={send} disabled={!ready || !input.trim()} aria-label={t("chat.send")}>➤</button>
      {/if}
    </div>
    <p class="tip"><span>♧</span> {t("chat.tip")}</p>
  </div>
</div>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .session-bar { position: relative; display: flex; flex-shrink: 0; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel-deep) 72%, transparent); }
  .session-label { color: var(--fg-label); font-size: var(--ui-label-size); font-weight: var(--ui-label-weight); letter-spacing: var(--ui-label-tracking); text-transform: uppercase; }
  .session-bar select { max-width: 260px; height: 26px; padding: 0 8px; color: var(--fg); border: 1px solid var(--line-strong); border-radius: 6px; background-color: var(--control-bg); font: 11px var(--mono); }
  .session-new { display: flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; color: var(--accent); border: 1px solid var(--accent-line); border-radius: 6px; background: transparent; font-size: 11.5px; font-weight: 600; cursor: pointer; transition: background .15s ease, border-color .15s ease; }
  .session-new:hover:not(:disabled) { border-color: var(--accent-line-strong); background: var(--accent-soft); }
  .session-new:disabled { opacity: .45; cursor: default; }
  .new-popover { position: absolute; z-index: 30; top: calc(100% + 6px); left: 12px; display: grid; gap: 9px; width: 290px; padding: 12px; border: 1px solid var(--accent-line); border-radius: 9px; background: var(--panel-raised); box-shadow: 0 18px 40px rgba(0,0,0,.5), 0 0 22px var(--accent-soft); }
  .new-popover input[type="text"] { height: 28px; padding: 0 9px; color: var(--fg); border: 1px solid var(--line-strong); border-radius: 6px; background: var(--control-bg); font-size: 12.5px; }
  .new-popover input[type="text"]:focus { outline: none; border-color: var(--accent-line-strong); }
  .link-scene { display: flex; align-items: center; gap: 7px; color: var(--fg-label); font-size: 12px; cursor: pointer; }
  .link-scene input { accent-color: var(--accent); }
  .new-actions { display: flex; justify-content: flex-end; gap: 6px; }
  .mini-ghost, .mini-primary { height: 25px; padding: 0 11px; border-radius: 5px; font-size: 11.5px; font-weight: 600; cursor: pointer; }
  .mini-ghost { color: var(--fg-dim); border: 1px solid var(--line-strong); background: transparent; }
  .mini-ghost:hover { color: var(--fg); border-color: var(--accent-line-strong); }
  .mini-primary { color: var(--bg); border: 1px solid color-mix(in srgb, var(--accent) 75%, white); background: var(--accent); box-shadow: 0 0 12px var(--accent-glow); }
  .mini-primary:hover { filter: brightness(1.1); }
  .messages { flex: 1; min-height: 0; overflow-y: auto; }
  .transcript-loading { margin: 40px auto; color: var(--fg-dim); text-align: center; font: 11px var(--mono); }
  .msg-files { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .msg-files em { padding: 2px 7px; color: var(--fg-dim); border: 1px solid var(--line-strong); border-radius: 999px; font: normal 9.5px var(--mono); }
  .attach-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
  .attach-chips .chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 5px 3px 9px; color: var(--fg-dim); border: 1px solid var(--accent-line); border-radius: 999px; background: var(--accent-soft); font: 10px var(--mono); }
  .attach-chips .chip button { display: grid; place-items: center; width: 15px; height: 15px; color: var(--fg-label); border: 0; border-radius: 50%; background: transparent; font-size: 12px; cursor: pointer; }
  .attach-chips .chip button:hover { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
  .attach { display: grid; flex-shrink: 0; place-items: center; width: 30px; height: 30px; color: var(--fg-label); border: 1px solid var(--line-strong); border-radius: 6px; background: transparent; font-size: 14px; cursor: pointer; transition: color .15s ease, border-color .15s ease; }
  .assist-toggle.on { color: var(--accent); border-color: var(--accent-line-strong); background: var(--accent-soft); box-shadow: 0 0 8px var(--accent-glow); }
  .attach:hover:not(:disabled) { color: var(--accent); border-color: var(--accent-line-strong); }
  .attach:disabled { opacity: .4; cursor: default; }
  .empty-state { display: grid; place-items: center; align-content: center; min-height: 100%; padding: 24px; text-align: center; }
  .signal-orbit { position: relative; display: grid; place-items: center; width: 176px; height: 122px; margin-bottom: 12px; }
  .signal-orbit span { position: absolute; width: 98px; height: 98px; border: 1px solid var(--accent-line-strong); border-radius: 50%; box-shadow: 0 0 22px var(--accent-soft), inset 0 0 20px var(--accent-soft); animation: orbit-pulse 3.2s ease-in-out infinite alternate; }
  .signal-orbit span:nth-child(2) { width: 132px; height: 58px; border-style: dashed; opacity: .45; animation-delay: -.8s; }
  .signal-orbit span:nth-child(3) { width: 164px; height: 28px; opacity: .27; animation-delay: -1.5s; }
  .signal-orbit span:nth-child(4) { width: 1px; height: 118px; border: 0; border-left: 1px solid var(--accent-line); border-radius: 0; box-shadow: 40px 0 0 hsl(var(--theme-hue) 70% 55% / .08), -40px 0 0 hsl(var(--theme-hue) 70% 55% / .08); }
  .signal-orbit::before, .signal-orbit::after { content: ""; position: absolute; width: 100%; height: 1px; background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: .35; }
  .signal-orbit::after { width: 134px; transform: rotate(90deg); opacity: .18; }
  .signal-orbit i { z-index: 2; display: grid; place-items: center; width: 57px; height: 57px; color: var(--accent); border: 1px solid var(--accent); border-radius: 50%; background: radial-gradient(circle, var(--accent-soft), var(--panel-deep)); box-shadow: 0 0 28px var(--accent-glow), inset 0 0 18px var(--accent-soft); }
  .empty-copy h1 { margin: 0 0 7px; color: var(--fg); font-size: clamp(22px, 2.5vw, 32px); font-weight: 430; letter-spacing: .04em; }
  .empty-copy p { margin: 0; color: var(--fg-dim); font-size: 13px; }
  .empty-copy small { display: block; margin-top: 5px; color: var(--fg-dim); font-size: 12px; }
  .prompt-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; width: min(570px, 100%); margin-top: 25px; }
  .prompt-grid button { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 10px; color: var(--fg); text-align: left; border: 1px solid var(--line-strong); border-radius: 7px; background: linear-gradient(135deg, rgba(255,255,255,.018), transparent); cursor: pointer; transition: border-color .18s ease, transform .18s ease, background .18s ease; }
  .prompt-grid button:hover:not(:disabled) { transform: translateY(-2px); border-color: var(--accent-line-strong); background: var(--accent-soft); }
  .prompt-grid button:disabled { opacity: .42; cursor: default; }
  .prompt-grid i { color: var(--warning); font-style: normal; font-size: 20px; text-shadow: 0 0 12px color-mix(in srgb, var(--warning) 45%, transparent); }
  .prompt-grid span { display: grid; min-width: 0; gap: 2px; }
  .prompt-grid strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
  .prompt-grid small { overflow: hidden; color: var(--fg-dim); text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .message-stream { display: flex; flex-direction: column; gap: 9px; padding: 16px; }
  .msg { max-width: 82%; padding: 9px 12px; border-radius: 9px; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: var(--accent-soft); border: 1px solid var(--accent-line); }
  .msg.agent { align-self: flex-start; background: var(--panel-raised); border: 1px solid var(--line); }
  .msg.tool { align-self: stretch; max-width: 100%; color: var(--fg-dim); background: var(--control-bg); border: 1px solid var(--line); border-radius: 5px; font: 11px var(--mono); }
  .msg.tool .dot { display: inline-block; width: 5px; height: 5px; margin-right: 7px; border-radius: 50%; background: var(--fg-muted); vertical-align: 1px; }
  .msg.tool.run .dot { background: var(--warning); box-shadow: 0 0 7px var(--warning); }
  .msg.tool.ok .dot { background: var(--good); }
  .msg.tool.err { color: var(--bad); }
  .msg.tool.err .dot { background: var(--bad); }
  .msg.tool details { margin-top: 5px; }
  .msg.tool summary { cursor: pointer; }
  .msg.tool pre { max-height: 220px; overflow: auto; white-space: pre-wrap; font: 10px var(--mono); }
  .thinking { display: flex; gap: 3px; }
  .thinking i { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); animation: blink .8s ease-in-out infinite alternate; }
  .thinking i:nth-child(2) { animation-delay: .16s; }
  .thinking i:nth-child(3) { animation-delay: .32s; }
  .composer-wrap { position: relative; padding: 8px 16px 10px; }
  .composer { display: flex; align-items: center; gap: 9px; min-height: 65px; padding: 7px 8px 7px 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--control-bg); box-shadow: inset 0 0 25px rgba(0,0,0,.18); }
  .composer.ready:focus-within { border-color: var(--accent-line-strong); box-shadow: 0 0 18px var(--accent-soft), inset 0 0 25px rgba(0,0,0,.18); }
  textarea { flex: 1; min-height: 46px; resize: none; color: var(--fg); background: transparent; border: 0; outline: none; font-size: 12px; line-height: 1.5; }
  textarea::placeholder { color: var(--fg-dim); }
  .send, .stop { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 6px; cursor: pointer; }
  .send { color: var(--bg); background: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 75%, white); box-shadow: 0 0 17px var(--accent-glow), inset 0 0 0 2px rgba(255,255,255,.12); font-size: 18px; }
  .send:disabled { color: var(--fg-muted); background: var(--panel-raised); border-color: var(--line); box-shadow: none; cursor: default; }
  .stop { color: var(--bad); background: color-mix(in srgb, var(--bad) 9%, transparent); border: 1px solid color-mix(in srgb, var(--bad) 45%, transparent); }
  .tip { margin: 7px 0 0; color: var(--fg-dim); text-align: center; font-size: 11px; }
  .tip span { color: var(--accent); }
  @keyframes orbit-pulse { from { opacity: .35; transform: scale(.96); } to { opacity: 1; transform: scale(1.04); } }
  @keyframes blink { from { opacity: .2; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .signal-orbit span, .thinking i { animation: none; } }
  @media (max-height: 700px) { .signal-orbit { width: 130px; height: 86px; transform: scale(.74); margin-bottom: 0; } .prompt-grid { margin-top: 14px; } }
</style>
