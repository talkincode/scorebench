import type { ProjectInfo } from "./api";

export interface ChatMessage {
  role: "user" | "agent" | "tool";
  text: string;
  tone?: "ok" | "err" | "run";
  detail?: string;
}

class BenchState {
  project = $state<ProjectInfo | null>(null);
  scorekitPath = $state<string | null>(null);
  scorekitError = $state<string | null>(null);

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
