import type { Settings } from "./api";

export type ApiProviderPresetId =
  | "openai"
  | "claude"
  | "kimi"
  | "qwen"
  | "deepseek"
  | "zhipu"
  | "grok";

export interface ApiProviderPreset {
  id: ApiProviderPresetId;
  label: string;
  apiProtocol: Settings["api_protocol"];
  baseUrl: string;
}

export const API_PROVIDER_PRESETS = [
  {
    id: "openai",
    label: "OpenAI",
    apiProtocol: "responses",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "claude",
    label: "Claude · Anthropic",
    apiProtocol: "chat_completions",
    baseUrl: "https://api.anthropic.com/v1",
  },
  {
    id: "kimi",
    label: "Kimi · Moonshot",
    apiProtocol: "chat_completions",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    id: "qwen",
    label: "千问 · Qwen",
    apiProtocol: "chat_completions",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    apiProtocol: "chat_completions",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    id: "zhipu",
    label: "智谱 · GLM",
    apiProtocol: "chat_completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "grok",
    label: "Grok · xAI",
    apiProtocol: "chat_completions",
    baseUrl: "https://api.x.ai/v1",
  },
] as const satisfies readonly ApiProviderPreset[];

export function apiProviderPreset(id: string): ApiProviderPreset | null {
  return API_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function apiProviderPresetForUrl(baseUrl: string): ApiProviderPreset | null {
  const normalized = normalizeBaseUrl(baseUrl);
  return (
    API_PROVIDER_PRESETS.find(
      (preset) => normalizeBaseUrl(preset.baseUrl) === normalized,
    ) ?? null
  );
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
