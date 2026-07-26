import { invoke, Channel } from "@tauri-apps/api/core";

export interface SceneEntry {
  rel_path: string;
  name: string;
  modified_ms: number | null;
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

/**
 * One track's entry in scorekit's instrument-resolution report (≥0.5). It names
 * the stable track id, the logical palette the track routed through, and the
 * leaf renderer profile that palette binds to.
 */
export interface ResolutionTrack {
  track_id?: string | null;
  palette?: string | null;
  profile?: string | null;
  requested?: string | null;
  resolved?: string | null;
  status?: string | null;
  best_candidate?: { instrument?: string | null; rejected?: string | null } | null;
}

/** `report` payload attached to scorekit `resolution` failures. */
export interface ResolutionReport {
  tracks?: ResolutionTrack[];
}

export interface BenchError {
  kind:
    | "scorekit_missing"
    | "scorekit"
    | "io"
    | "invalid_project"
    | "llm"
    | "cancelled"
    | "settings"
    | "agent";
  message: string;
  code?: string;
  exit_code?: number;
  field?: string | null;
  location?: string | null;
  status?: number | null;
  retry_after?: string | null;
  body_excerpt?: string | null;
  /** Structured diagnosis; resolution tracks are rendered specially when present. */
  report?: ResolutionReport | null;
}

export interface Settings {
  base_url: string;
  model: string;
  context_budget_tokens: number;
  max_turns: number;
  /** Absolute path pinning the scorekit binary; null = auto-discovery. */
  scorekit_path: string | null;
  spectrum_style: string;
  spectrum_bars: number;
  /** Spectrum palette hue override in degrees; null follows `theme_hue`. */
  spectrum_hue: number | null;
  theme_hue: number;
  locale: string;
}

/** Matches the Rust `styles::StylePack` serde shape. */
export interface StylePack {
  id: string;
  name: string;
  name_en?: string | null;
  category?: string | null;
  builtin: boolean;
  yaml: string;
}

/** Matches the Rust `manifest::StyleRef` serde shape. */
export interface StyleRef {
  id: string;
}

/** Locale-appropriate display name for a style pack. */
export function stylePackName(pack: StylePack, locale: string): string {
  return locale === "en" ? (pack.name_en ?? pack.name) : pack.name;
}

export interface SessionMeta {
  id: string;
  title: string;
  scene?: string | null;
  created_ms: number;
  updated_ms: number;
}

export interface SessionsIndex {
  active: string;
  sessions: SessionMeta[];
}

export interface TranscriptMessage {
  role: "user" | "agent" | "tool";
  text: string;
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
  /** Stable track IDs silenced in this section. */
  mute: string[];
}

export interface TrackDisplay {
  /** Stable scene-local track ID (routing, sections, stems). */
  id?: string | null;
  /** Logical orchestration palette; absent uses the orchestration default. */
  palette?: string | null;
  instrument?: string | null;
  pattern?: string | null;
  motif?: string | null;
  intensity?: number | null;
  articulation?: string | null;
}

export interface TextureDisplay {
  source?: string | null;
  mode?: string | null;
  gain?: number | null;
  start_beat?: number | null;
  at: number[];
}

export interface SceneDisplay {
  title?: string | null;
  story?: string | null;
  tempo?: number | null;
  key?: string | null;
  time_signature?: string | null;
  bars?: number | null;
  loop_enabled?: boolean | null;
  harmony: string[];
  sections: SectionDisplay[];
  tracks: TrackDisplay[];
  textures: TextureDisplay[];
  has_performance: boolean;
}

export interface SceneInspection {
  scene?: SceneDisplay | null;
  parse_error?: string | null;
  validation: ValidationDisplay;
  orchestration?: OrchestrationCompat | null;
  texture_profile?: TextureProfileCompat | null;
  last_diff?: unknown;
}

export interface ValidationDisplay {
  status: "valid" | "invalid" | "unavailable";
  error?: BenchError | null;
}

/** Matches the Rust `manifest::RenderConfig` serde shape. */
export interface RenderConfig {
  renderer?: string | null;
  orchestration?: string | null;
  texture_profile?: string | null;
}

/** Matches the Rust `manifest::TrackOrchestrationCompat` serde shape. */
export interface TrackOrchestrationCompat {
  track_id: string;
  palette: string;
  instrument?: string | null;
  profile?: string | null;
  profile_name?: string | null;
  error?: string | null;
}

/** Matches the Rust `manifest::OrchestrationCompat` serde shape. */
export interface OrchestrationCompat {
  orchestration: string;
  orchestration_name?: string | null;
  default_palette?: string | null;
  tracks: TrackOrchestrationCompat[];
  error?: string | null;
}

/** Resolve the palette scorekit actually routes a scene track through. */
export function resolvedPaletteForTrack(
  track: Pick<TrackDisplay, "id" | "palette">,
  orchestration: OrchestrationCompat | null | undefined,
): string | null {
  const routed = track.id
    ? orchestration?.tracks.find((candidate) => candidate.track_id === track.id)
    : null;
  return routed?.palette || track.palette || orchestration?.default_palette || null;
}

/** Matches the Rust `manifest::TextureProfileCompat` serde shape. */
export interface TextureProfileCompat {
  profile?: string | null;
  profile_name?: string | null;
  available: string[];
  missing: string[];
  mode_mismatches?: {
    source: string;
    requested: string;
    available: string[];
  }[];
  error?: string | null;
}

export interface ScorekitHandshake {
  found: boolean;
  ready: boolean;
  path?: string | null;
  /** Which discovery channel won: env pin, settings pin, PATH, or a well-known prefix. */
  source?: "env" | "settings" | "path" | "well-known" | null;
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
  | { type: "text_commit" }
  | { type: "text_discard" }
  | { type: "text_finalize" }
  | { type: "text_rollback" }
  | { type: "warning"; text: string }
  | { type: "compacted"; turns: number }
  | { type: "tool_start"; name: string; detail: string }
  | { type: "tool_ok"; name: string; summary: string; detail?: string | null }
  | { type: "tool_err"; name: string; error: BenchError }
  | { type: "done" };

export interface AgentRunIdentity {
  id: number;
  root: string;
  session: string;
}

/** Reject late Channel events after a project/session/run identity changes. */
export function isCurrentAgentRun(
  expected: AgentRunIdentity,
  active: AgentRunIdentity | null,
  projectRoot: string | null | undefined,
  session: string | null | undefined,
): boolean {
  return (
    active?.id === expected.id &&
    active.root === expected.root &&
    active.session === expected.session &&
    projectRoot === expected.root &&
    session === expected.session
  );
}

export interface AgentDraftTransition {
  pending: string;
  committed?: string;
}

/** Keep streamed model text provisional until the backend accepts the turn. */
export function advanceAgentDraft(
  pending: string,
  event: Extract<AgentEvent, { type: "text" | "text_commit" | "text_discard" }>,
): AgentDraftTransition {
  if (event.type === "text") return { pending: pending + event.text };
  if (event.type === "text_commit") {
    return pending ? { pending: "", committed: pending } : { pending: "" };
  }
  return { pending: "" };
}

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
  orchestration?: string;
  texture_profile?: string;
}

export interface PerspectiveReview {
  role: string;
  headline: string;
  strengths: string[];
  issues: string[];
  severity: string;
  confidence: string;
}

export interface ReviewTension {
  between: string[];
  point: string;
}

export interface ReviewSuggestion {
  text: string;
  rationale: string;
  priority: string;
  severity: string;
}

export interface ReviewReport {
  perspectives: PerspectiveReview[];
  tensions: ReviewTension[];
  consensus: string[];
  suggestions: ReviewSuggestion[];
}

export type ReviewEvent = { type: "delta"; text: string };

const sceneInspectionsInFlight = new Map<string, Promise<SceneInspection>>();

function inspectScene(root: string, relPath: string, revision: number): Promise<SceneInspection> {
  // Coalesce only consumers observing the same project generation. A watcher
  // revision arriving before the old request settles must start a fresh
  // inspection rather than inherit stale scene data from the prior generation.
  const key = JSON.stringify([root, relPath, revision]);
  const inFlight = sceneInspectionsInFlight.get(key);
  if (inFlight) return inFlight;

  let request: Promise<SceneInspection>;
  request = invoke<SceneInspection>("inspect_scene", { root, relPath }).finally(() => {
    if (sceneInspectionsInFlight.get(key) === request) {
      sceneInspectionsInFlight.delete(key);
    }
  });
  sceneInspectionsInFlight.set(key, request);
  return request;
}

/**
 * scorekit reports an unbuildable orchestration as a count ("2 unresolved
 * instrument(s)"); the actionable part — which track, which palette, which leaf
 * profile — lives in the attached report, so unresolved tracks are folded into
 * the displayed text instead of being dropped.
 */
function unresolvedTrackLines(report: ResolutionReport | null | undefined): string[] {
  return (report?.tracks ?? [])
    .filter((track) => track.status !== "exact" && track.status !== "alias" && track.resolved == null)
    .map((track) => {
      const where = [
        track.palette ? `palette \`${track.palette}\`` : null,
        track.profile ? `profile \`${track.profile}\`` : null,
      ].filter(Boolean);
      const candidate = track.best_candidate?.instrument
        ? ` — closest \`${track.best_candidate.instrument}\`${
            track.best_candidate.rejected ? ` rejected (${track.best_candidate.rejected})` : ""
          }`
        : "";
      return `track \`${track.track_id ?? "?"}\`${where.length ? ` (${where.join(", ")})` : ""}: \`${
        track.requested ?? "?"
      }\` unavailable${candidate}`;
    });
}

export function errorText(err: unknown): string {
  const e = err as BenchError;
  if (e && typeof e === "object" && "message" in e) {
    const message = e.code ? `${e.code}: ${e.message}` : e.message;
    const lines = [message, ...unresolvedTrackLines(e.report)];
    if (e.body_excerpt) lines.push(e.body_excerpt);
    return lines.join("\n");
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

  inspectScene,

  readMeta: (root: string, relPath: string) =>
    invoke<Record<string, unknown>>("read_meta", { root, relPath }),

  stashAttachment: (fileName: string, dataBase64: string) =>
    invoke<string>("stash_attachment", { fileName, dataBase64 }),

  sendChat(
    root: string,
    session: string,
    message: string,
    attachments: string[],
    onEvent: (e: AgentEvent) => void,
  ) {
    const events = new Channel<AgentEvent>();
    events.onmessage = onEvent;
    return invoke<void>("send_chat", { root, session, message, attachments, events });
  },

  cancelAgent: (root: string, session: string) =>
    invoke<boolean>("cancel_agent", { root, session }),

  runReview(
    root: string,
    session: string,
    sceneRel: string,
    perspectives: string[],
    onEvent: (e: ReviewEvent) => void,
  ) {
    const events = new Channel<ReviewEvent>();
    events.onmessage = onEvent;
    return invoke<ReviewReport>("run_review", { root, session, sceneRel, perspectives, events });
  },

  cancelReview: (root: string) => invoke<boolean>("cancel_review", { root }),

  listSessions: (root: string) => invoke<SessionsIndex>("list_sessions", { root }),

  createSession: (root: string, title: string | null, scene: string | null) =>
    invoke<SessionMeta>("create_session", { root, title, scene }),

  selectSession: (root: string, session: string) =>
    invoke<void>("select_session", { root, session }),

  sessionTranscript: (root: string, session: string) =>
    invoke<TranscriptMessage[]>("session_transcript", { root, session }),

  readSceneSource: (root: string, relPath: string) =>
    invoke<string>("read_scene_source", { root, relPath }),

  deleteScene: (root: string, relPath: string) =>
    invoke<void>("delete_scene", { root, relPath }),

  createScene: (root: string, relPath: string) =>
    invoke<void>("create_scene", { root, relPath }),

  saveSceneSource: (root: string, relPath: string, content: string) =>
    invoke<string[]>("save_scene_source", { root, relPath, content }),

  validateSceneContent: (root: string, content: string) =>
    invoke<ValidationDisplay>("validate_scene_content", { root, content }),

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

  chooseRecordingPath: (suggestedName: string) =>
    invoke<string | null>("choose_recording_path", { suggestedName }),

  saveRecording: (bytes: Uint8Array) => invoke<string>("save_recording", bytes),

  loadRenderConfig: (root: string) =>
    invoke<[RenderConfig | null, string | null]>("load_render_config", { root }),

  saveRenderConfig: (root: string, render: RenderConfig | null) =>
    invoke<void>("save_render_config", { root, render }),

  listStylePacks: () => invoke<[StylePack[], string[]]>("list_style_packs"),

  saveStylePack: (yaml: string, previousId: string | null) =>
    invoke<StylePack>("save_style_pack", { yaml, previousId }),

  deleteStylePack: (id: string) => invoke<void>("delete_style_pack", { id }),

  loadStyleConfig: (root: string) =>
    invoke<[StyleRef | null, string | null]>("load_style_config", { root }),

  saveStyleConfig: (root: string, style: StyleRef | null) =>
    invoke<void>("save_style_config", { root, style }),
};
