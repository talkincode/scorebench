import { describe, expect, it } from "vitest";
import { visualStyles } from "./index";

describe("visualStyles", () => {
  it("uses concise English picker labels", () => {
    expect(visualStyles.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "bars", label: "Bars" },
      { id: "mood", label: "Mood" },
      { id: "voyage", label: "Voyage" },
    ]);
  });
});
