import { describe, expect, it } from "vitest";

import {
  API_PROVIDER_PRESETS,
  apiProviderPreset,
  apiProviderPresetForUrl,
} from "./llmPresets";

describe("API provider presets", () => {
  it("contains the seven requested convenience endpoints", () => {
    expect(API_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "openai",
      "claude",
      "kimi",
      "qwen",
      "deepseek",
      "zhipu",
      "grok",
    ]);
    expect(API_PROVIDER_PRESETS.map((preset) => preset.baseUrl)).toEqual([
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "https://api.moonshot.cn/v1",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://api.deepseek.com/v1",
      "https://open.bigmodel.cn/api/paas/v4",
      "https://api.x.ai/v1",
    ]);
  });

  it("uses Responses for OpenAI and Chat Completions for compatibility presets", () => {
    expect(apiProviderPreset("openai")?.apiProtocol).toBe("responses");
    for (const preset of API_PROVIDER_PRESETS.slice(1)) {
      expect(preset.apiProtocol).toBe("chat_completions");
    }
  });

  it("matches edited URLs without caring about whitespace or trailing slashes", () => {
    expect(
      apiProviderPresetForUrl("  https://api.anthropic.com/v1/// ")?.id,
    ).toBe("claude");
    expect(apiProviderPresetForUrl("https://proxy.example/v1")).toBeNull();
  });
});
