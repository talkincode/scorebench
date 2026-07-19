import { describe, expect, it } from "vitest";

import { errorText } from "./api";

describe("errorText", () => {
  it("includes the Responses API error body for actionable HTTP failures", () => {
    expect(
      errorText({
        kind: "llm",
        message: "LLM endpoint returned HTTP 400",
        status: 400,
        body_excerpt: '{"error":{"message":"tools[0].strict is unsupported"}}',
      }),
    ).toBe(
      'LLM endpoint returned HTTP 400\n{"error":{"message":"tools[0].strict is unsupported"}}',
    );
  });
});
