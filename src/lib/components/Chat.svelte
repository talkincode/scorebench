<script lang="ts">
  import { api, errorText, type AgentEvent } from "../api";
  import { bench } from "../state.svelte";

  let input = $state("");
  let scroller: HTMLDivElement | undefined = $state();
  let ready = $derived(Boolean(bench.project && bench.settings && bench.apiKeySet));
  const prompts = [
    ["✦", "Nostalgic piano", "in G major, 3/4, 8 bars"],
    ["▮▮▮", "Cinematic strings", "with a slow build, 4/4"],
    ["◆", "Chiptune boss theme", "in D minor, 16 bars"],
  ];

  $effect(() => {
    void bench.messages.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

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
    if (!message || !bench.project || !ready || bench.agentBusy) return;
    input = "";
    bench.messages.push({ role: "user", text: message });
    bench.agentBusy = true;
    try {
      await api.sendChat(bench.project.root, message, onAgentEvent);
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
    if (!bench.project || !bench.agentBusy) return;
    await api.cancelAgent(bench.project.root).catch(() => {});
  }
</script>

<div class="chat">
  <div class="messages" bind:this={scroller}>
    {#if bench.messages.length === 0}
      <div class="empty-state">
        <div class="signal-orbit" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
          <i>▮ ▮▮ ▮</i>
        </div>
        <div class="empty-copy">
          <h1>Compose with Agent</h1>
          <p>{bench.apiKeySet ? "Describe the music or refine the selected scene." : "Connect the Responses API in Settings to begin composing."}</p>
          <small>scorebench handles scene YAML, scorekit validation, and rendering.</small>
        </div>
        <div class="prompt-grid">
          {#each prompts as prompt}
            <button onclick={() => (input = `${prompt[1]} ${prompt[2]}`)} disabled={!ready}>
              <i>{prompt[0]}</i><span><strong>{prompt[1]}</strong><small>{prompt[2]}</small></span>
            </button>
          {/each}
        </div>
      </div>
    {:else}
      <div class="message-stream">
        {#each bench.messages as message}
          <div class="msg {message.role} {message.tone ?? ''}">
            {#if message.role === "tool"}
              <span class="dot" aria-hidden="true"></span>
              <span class="tool-line">{message.text}</span>
              {#if message.detail}<details><summary>output</summary><pre>{message.detail}</pre></details>{/if}
            {:else}
              {message.text}
            {/if}
          </div>
        {/each}
        {#if bench.agentBusy}<div class="msg agent thinking"><i></i><i></i><i></i></div>{/if}
      </div>
    {/if}
  </div>

  <div class="composer-wrap">
    <div class="composer" class:ready>
      <span class="mic" aria-hidden="true">⌁</span>
      <textarea
        rows="2"
        placeholder={!bench.project ? "Open a project first" : !bench.apiKeySet ? "Set an API key in Settings" : "Ask scorebench to create, edit, or refine your composition…"}
        disabled={!ready || bench.agentBusy}
        bind:value={input}
        onkeydown={onKeydown}
      ></textarea>
      {#if bench.agentBusy}
        <button class="stop" onclick={stop} aria-label="Stop agent">■</button>
      {:else}
        <button class="send" onclick={send} disabled={!ready || !input.trim()} aria-label="Send message">➤</button>
      {/if}
    </div>
    <p class="tip"><span>♧</span> Tip: select a scene on the left to inspect, refine, and render it.</p>
  </div>
</div>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .messages { flex: 1; min-height: 0; overflow-y: auto; }
  .empty-state { display: grid; place-items: center; align-content: center; min-height: 100%; padding: 24px; text-align: center; }
  .signal-orbit { position: relative; display: grid; place-items: center; width: 176px; height: 122px; margin-bottom: 12px; }
  .signal-orbit span { position: absolute; width: 98px; height: 98px; border: 1px solid var(--accent-line-strong); border-radius: 50%; box-shadow: 0 0 22px var(--accent-soft), inset 0 0 20px var(--accent-soft); animation: orbit-pulse 3.2s ease-in-out infinite alternate; }
  .signal-orbit span:nth-child(2) { width: 132px; height: 58px; border-style: dashed; opacity: .45; animation-delay: -.8s; }
  .signal-orbit span:nth-child(3) { width: 164px; height: 28px; opacity: .27; animation-delay: -1.5s; }
  .signal-orbit span:nth-child(4) { width: 1px; height: 118px; border: 0; border-left: 1px solid var(--accent-line); border-radius: 0; box-shadow: 40px 0 0 hsl(var(--theme-hue) 70% 55% / .08), -40px 0 0 hsl(var(--theme-hue) 70% 55% / .08); }
  .signal-orbit::before, .signal-orbit::after { content: ""; position: absolute; width: 100%; height: 1px; background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: .35; }
  .signal-orbit::after { width: 134px; transform: rotate(90deg); opacity: .18; }
  .signal-orbit i { z-index: 2; display: grid; place-items: center; width: 57px; height: 57px; color: var(--accent); border: 1px solid var(--accent); border-radius: 50%; background: radial-gradient(circle, var(--accent-soft), var(--panel-deep)); box-shadow: 0 0 28px var(--accent-glow), inset 0 0 18px var(--accent-soft); font: normal 10px var(--mono); letter-spacing: 2px; text-shadow: 0 0 10px var(--accent); }
  .empty-copy h1 { margin: 0 0 7px; color: var(--fg); font-size: clamp(22px, 2.5vw, 32px); font-weight: 430; letter-spacing: .04em; }
  .empty-copy p { margin: 0; color: var(--fg-dim); font-size: 12px; }
  .empty-copy small { display: block; margin-top: 5px; color: var(--fg-muted); font-size: 9px; }
  .prompt-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; width: min(570px, 100%); margin-top: 25px; }
  .prompt-grid button { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 10px; color: var(--fg); text-align: left; border: 1px solid var(--line-strong); border-radius: 7px; background: linear-gradient(135deg, rgba(255,255,255,.018), transparent); cursor: pointer; transition: border-color .18s ease, transform .18s ease, background .18s ease; }
  .prompt-grid button:hover:not(:disabled) { transform: translateY(-2px); border-color: var(--accent-line-strong); background: var(--accent-soft); }
  .prompt-grid button:disabled { opacity: .42; cursor: default; }
  .prompt-grid i { color: var(--warning); font-style: normal; font-size: 19px; text-shadow: 0 0 12px color-mix(in srgb, var(--warning) 45%, transparent); }
  .prompt-grid span { display: grid; min-width: 0; gap: 2px; }
  .prompt-grid strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; font-weight: 600; }
  .prompt-grid small { overflow: hidden; color: var(--fg-muted); text-overflow: ellipsis; white-space: nowrap; font-size: 7.5px; }
  .message-stream { display: flex; flex-direction: column; gap: 9px; padding: 16px; }
  .msg { max-width: 82%; padding: 9px 12px; border-radius: 9px; font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: var(--accent-soft); border: 1px solid var(--accent-line); }
  .msg.agent { align-self: flex-start; background: var(--panel-raised); border: 1px solid var(--line); }
  .msg.tool { align-self: stretch; max-width: 100%; color: var(--fg-dim); background: var(--control-bg); border: 1px solid var(--line); border-radius: 5px; font: 9px var(--mono); }
  .msg.tool .dot { display: inline-block; width: 5px; height: 5px; margin-right: 7px; border-radius: 50%; background: var(--fg-muted); vertical-align: 1px; }
  .msg.tool.run .dot { background: var(--warning); box-shadow: 0 0 7px var(--warning); }
  .msg.tool.ok .dot { background: var(--good); }
  .msg.tool.err { color: var(--bad); }
  .msg.tool.err .dot { background: var(--bad); }
  .msg.tool details { margin-top: 5px; }
  .msg.tool summary { cursor: pointer; }
  .msg.tool pre { max-height: 220px; overflow: auto; white-space: pre-wrap; font: 8px var(--mono); }
  .thinking { display: flex; gap: 3px; }
  .thinking i { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); animation: blink .8s ease-in-out infinite alternate; }
  .thinking i:nth-child(2) { animation-delay: .16s; }
  .thinking i:nth-child(3) { animation-delay: .32s; }
  .composer-wrap { padding: 8px 16px 10px; }
  .composer { display: flex; align-items: center; gap: 9px; min-height: 65px; padding: 7px 8px 7px 12px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--control-bg); box-shadow: inset 0 0 25px rgba(0,0,0,.18); }
  .composer.ready:focus-within { border-color: var(--accent-line-strong); box-shadow: 0 0 18px var(--accent-soft), inset 0 0 25px rgba(0,0,0,.18); }
  .mic { color: var(--fg-muted); font-size: 17px; }
  textarea { flex: 1; min-height: 46px; resize: none; color: var(--fg); background: transparent; border: 0; outline: none; font-size: 11px; line-height: 1.5; }
  textarea::placeholder { color: var(--fg-muted); }
  .send, .stop { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 6px; cursor: pointer; }
  .send { color: var(--bg); background: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 75%, white); box-shadow: 0 0 17px var(--accent-glow), inset 0 0 0 2px rgba(255,255,255,.12); font-size: 17px; }
  .send:disabled { color: var(--fg-muted); background: var(--panel-raised); border-color: var(--line); box-shadow: none; cursor: default; }
  .stop { color: var(--bad); background: color-mix(in srgb, var(--bad) 9%, transparent); border: 1px solid color-mix(in srgb, var(--bad) 45%, transparent); }
  .tip { margin: 7px 0 0; color: var(--fg-muted); text-align: center; font-size: 8px; }
  .tip span { color: var(--accent); }
  @keyframes orbit-pulse { from { opacity: .35; transform: scale(.96); } to { opacity: 1; transform: scale(1.04); } }
  @keyframes blink { from { opacity: .2; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .signal-orbit span, .thinking i { animation: none; } }
  @media (max-height: 700px) { .signal-orbit { width: 130px; height: 86px; transform: scale(.74); margin-bottom: 0; } .prompt-grid { margin-top: 14px; } }
</style>
