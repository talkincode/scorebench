<script lang="ts">
  import { api, errorText, type AgentEvent } from "../api";
  import { bench } from "../state.svelte";

  let input = $state("");
  let scroller: HTMLDivElement | undefined = $state();

  $effect(() => {
    void bench.messages.length;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  function onAgentEvent(e: AgentEvent) {
    switch (e.type) {
      case "text":
        bench.messages.push({ role: "agent", text: e.text });
        break;
      case "tool_start":
        bench.messages.push({ role: "tool", tone: "run", text: e.detail });
        break;
      case "tool_ok":
        bench.messages.push({ role: "tool", tone: "ok", text: `${e.name} ✓`, detail: e.summary });
        break;
      case "tool_err":
        bench.messages.push({ role: "tool", tone: "err", text: `${e.name} ✗ ${errorText(e.error)}` });
        break;
      case "done":
        bench.agentBusy = false;
        break;
    }
  }

  async function send() {
    const message = input.trim();
    if (!message || !bench.project || bench.agentBusy) return;
    input = "";
    bench.messages.push({ role: "user", text: message });
    bench.agentBusy = true;
    try {
      await api.sendChat(bench.project.root, message, onAgentEvent);
    } catch (err) {
      bench.messages.push({ role: "tool", tone: "err", text: errorText(err) });
      bench.agentBusy = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="chat">
  <div class="messages" bind:this={scroller}>
    {#if bench.messages.length === 0}
      <div class="hint">
        <p>Talk to the bench. The composing agent lands in M1 — today's stub understands:</p>
        <p><code>/doctor</code> — check the scorekit toolchain</p>
        <p><code>/build &lt;scene.yaml&gt;</code> — render a scene to <code>out/</code></p>
      </div>
    {/if}
    {#each bench.messages as msg}
      <div class="msg {msg.role} {msg.tone ?? ''}">
        {#if msg.role === "tool"}
          <span class="dot" aria-hidden="true"></span>
          <span class="tool-line">{msg.text}</span>
          {#if msg.detail}
            <details>
              <summary>output</summary>
              <pre>{msg.detail}</pre>
            </details>
          {/if}
        {:else}
          {msg.text}
        {/if}
      </div>
    {/each}
    {#if bench.agentBusy}
      <div class="msg agent thinking">…</div>
    {/if}
  </div>

  <div class="composer">
    <textarea
      rows="2"
      placeholder={bench.project ? "Message the bench (Enter to send)" : "Open a project first"}
      disabled={!bench.project || bench.agentBusy}
      bind:value={input}
      onkeydown={onKeydown}
    ></textarea>
    <button class="primary" onclick={send} disabled={!bench.project || bench.agentBusy || !input.trim()}>
      Send
    </button>
  </div>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hint {
    color: var(--fg-dim);
    font-size: 13px;
    line-height: 1.7;
    border: 1px dashed var(--line);
    border-radius: 10px;
    padding: 14px 16px;
  }
  .hint code {
    color: var(--accent);
    font-family: var(--mono);
  }
  .msg {
    max-width: 82%;
    padding: 9px 13px;
    border-radius: 12px;
    font-size: 13.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .msg.agent {
    align-self: flex-start;
    background: var(--panel-2);
    border: 1px solid var(--line);
  }
  .msg.thinking {
    color: var(--fg-dim);
  }
  .msg.tool {
    align-self: stretch;
    max-width: 100%;
    font-family: var(--mono);
    font-size: 12px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--fg-dim);
  }
  .msg.tool .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-right: 8px;
    background: var(--fg-dim);
    vertical-align: 1px;
  }
  .msg.tool.run .dot { background: var(--accent); }
  .msg.tool.ok .dot { background: var(--good); }
  .msg.tool.err .dot { background: var(--bad); }
  .msg.tool.err {
    color: var(--bad);
  }
  .msg.tool details { margin-top: 6px; }
  .msg.tool summary { cursor: pointer; color: var(--fg-dim); }
  .msg.tool pre {
    margin: 6px 0 0;
    max-height: 240px;
    overflow: auto;
    font-size: 11px;
    color: var(--fg-dim);
  }
  .composer {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  textarea {
    flex: 1;
    resize: none;
    background: var(--panel-2);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 9px 12px;
    font: inherit;
    font-size: 13.5px;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
