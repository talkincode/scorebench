import { invoke, Channel } from "@tauri-apps/api/core";

export interface SceneEntry {
  rel_path: string;
  name: string;
}

export interface AssetEntry {
  rel_path: string;
  name: string;
  kind: "audio" | "meta";
  size_bytes: number;
  modified_ms: number | null;
}

export interface ProjectInfo {
  root: string;
  name: string;
  scenes: SceneEntry[];
  assets: AssetEntry[];
}

export interface BenchError {
  kind:
    | "scorekit_missing"
    | "scorekit"
    | "io"
    | "invalid_project"
    | "llm"
    | "cancelled"
    | "settings";
  message: string;
  code?: string;
  exit_code?: number;
  field?: string | null;
  location?: string | null;
  status?: number | null;
  retry_after?: string | null;
  body_excerpt?: string | null;
}

export interface Settings {
  base_url: string;
  model: string;
  context_budget_tokens: number;
  max_turns: number;
  spectrum_style: string;
  spectrum_bars: number;
  theme_hue: number;
}

export interface SettingsView {
  settings: Settings;
  api_key_set: boolean;
  warning?: string | null;
}

export interface SectionDisplay {
  name?: string | null;
  bars?: number | null;
  tempo?: number | null;
  loop_enabled?: boolean | null;
  intensity?: number | null;
  mute: number[];
}

export interface TrackDisplay {
  instrument?: string | null;
  pattern?: string | null;
  motif?: string | null;
  intensity?: number | null;
  articulation?: string | null;
}

export interface SceneDisplay {
  title?: string | null;
  tempo?: number | null;
  key?: string | null;
  time_signature?: string | null;
  bars?: number | null;
  loop_enabled?: boolean | null;
  harmony: string[];
  sections: SectionDisplay[];
  tracks: TrackDisplay[];
  has_performance: boolean;
}

export interface SceneInspection {
  scene?: SceneDisplay | null;
  parse_error?: string | null;
  validation: { status: "valid" | "invalid" | "unavailable"; error?: BenchError | null };
  last_diff?: unknown;
}

export interface ScorekitHandshake {
  found: boolean;
  ready: boolean;
  path?: string | null;
  version?: string | null;
  tested_range: string;
  compatible?: boolean | null;
  doctor?: Record<string, unknown> | null;
  hints: string[];
  warning?: string | null;
}

export interface VersionInfo {
  scorebench_version: string;
  scorekit: ScorekitHandshake;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "warning"; text: string }
  | { type: "compacted"; turns: number }
  | { type: "tool_start"; name: string; detail: string }
  | { type: "tool_ok"; name: string; summary: string; detail?: string | null }
  | { type: "tool_err"; name: string; error: BenchError }
  | { type: "done" };

export interface BuildResult {
  output: string;
  meta_path: string;
  meta: Record<string, unknown>;
}

export type BuildEvent =
  | { type: "started"; command: string }
  | { type: "finished"; result: BuildResult }
  | { type: "failed"; error: BenchError };

/** Field names match the Rust `BuildParams` serde shape (snake_case). */
export interface BuildParams {
  renderer?: string;
  sample_rate?: number;
  gain?: number;
  quality?: number;
  stems?: boolean;
  soundfont?: string;
  profile?: string;
}

export function errorText(err: unknown): string {
  const e = err as BenchError;
  if (e && typeof e === "object" && "message" in e) {
    const message = e.code ? `${e.code}: ${e.message}` : e.message;
    return e.body_excerpt ? `${message}\n${e.body_excerpt}` : message;
  }
  return String(err);
}

export const api = {
  scorekitStatus: () => invoke<string>("scorekit_status"),

  versionInfo: () => invoke<VersionInfo>("version_info"),

  scorekitDoctor: () => invoke<Record<string, unknown>>("scorekit_doctor"),

  getSettings: () => invoke<SettingsView>("get_settings"),

  saveSettings: (value: Settings) => invoke<void>("save_settings", { value }),

  setApiKey: (apiKey: string, allowInsecureStorage: boolean) =>
    invoke<void>("set_api_key", { apiKey, allowInsecureStorage }),

  testConnection: () => invoke<string>("test_connection"),

  openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),

  refreshProject: (path: string) => invoke<ProjectInfo>("refresh_project", { path }),

  inspectScene: (root: string, relPath: string) =>
    invoke<SceneInspection>("inspect_scene", { root, relPath }),

  readMeta: (root: string, relPath: string) =>
    invoke<Record<string, unknown>>("read_meta", { root, relPath }),

  sendChat(root: string, message: string, onEvent: (e: AgentEvent) => void) {
    const events = new Channel<AgentEvent>();
    events.onmessage = onEvent;
    return invoke<void>("send_chat", { root, message, events });
  },

  cancelAgent: (root: string) => invoke<boolean>("cancel_agent", { root }),

  runBuild(
    root: string,
    sceneRel: string,
    params: BuildParams,
    format: "ogg" | "wav",
    onEvent: (e: BuildEvent) => void,
  ) {
    const events = new Channel<BuildEvent>();
    events.onmessage = onEvent;
    return invoke<void>("run_build", { root, sceneRel, params, format, events });
  },

  readAsset: (root: string, relPath: string) =>
    invoke<ArrayBuffer>("read_asset", { root, relPath }),
};
