import type { ProjectInfo, SessionMeta, Settings, VersionInfo } from "./api";

export interface ChatMessage {
  role: "user" | "agent" | "tool";
  text: string;
  tone?: "ok" | "err" | "run";
  detail?: string;
  attachments?: string[];
}

export type WorkspaceTab = "agent" | "scene" | "preview";

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
