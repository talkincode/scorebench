import type { ProjectInfo, ReviewReport, SessionMeta, Settings, StylePack, VersionInfo } from "./api";

export interface ChatMessage {
  role: "user" | "agent" | "tool";
  text: string;
  tone?: "ok" | "err" | "run";
  detail?: string;
  attachments?: string[];
}

export type WorkspaceTab = "agent" | "scene" | "preview" | "review" | "styles";

class BenchState {
  project = $state<ProjectInfo | null>(null);
  scorekitPath = $state<string | null>(null);
  scorekitError = $state<string | null>(null);
  versionInfo = $state<VersionInfo | null>(null);

  settings = $state<Settings | null>(null);
  settingsWarning = $state<string | null>(null);
  apiKeySet = $state(false);
  settingsOpen = $state(false);
  themeHuePreview = $state<number | null>(null);
  projectRevision = $state(0);

  selectedScene = $state<string | null>(null);
  workspaceTab = $state<WorkspaceTab>("agent");

  sessions = $state<SessionMeta[]>([]);
  activeSession = $state<string | null>(null);

  messages = $state<ChatMessage[]>([]);
  agentBusy = $state(false);

  building = $state(false);
  buildStatus = $state<string | null>(null);
  buildFailed = $state(false);

  reviewBusy = $state(false);
  /** Raw streamed model text, shown while the report is in flight. */
  reviewRaw = $state("");
  reviewReport = $state<ReviewReport | null>(null);
  reviewError = $state<string | null>(null);
  /** Scene the current report was produced for. */
  reviewScene = $state<string | null>(null);
  reviewPerspectives = $state<string[]>(["composer", "arranger", "producer"]);
  /** Prefill for the chat input ("hand to Agent"); consumed by Chat once. */
  chatDraft = $state<string | null>(null);

  /** Creative assist panel visibility (toggled from the chat composer). */
  assistOpen = $state(false);
  /** One-shot append into the chat input; new object per request. */
  chatInsert = $state<{ text: string } | null>(null);

  /** Style pack library (built-ins + user packs) and load warnings. */
  stylePacks = $state<StylePack[]>([]);
  styleWarnings = $state<string[]>([]);
  /** Active style pack id for the open project (bench.json `style.id`). */
  activeStyleId = $state<string | null>(null);

  requestChatInsert(text: string) {
    this.chatInsert = { text };
  }

  /** rel_path of the asset currently loaded in the player. */
  loadedAsset = $state<string | null>(null);
  /** Bumped on every load request so re-loading the same path re-triggers. */
  loadSeq = $state(0);

  requestLoad(relPath: string) {
    this.loadedAsset = relPath;
    this.loadSeq++;
  }
}

export const bench = new BenchState();
