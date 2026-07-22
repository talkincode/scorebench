import { describe, expect, it } from "vitest";
import { nextThreeStyleToPreload, visualStyles } from "./index";

describe("visualStyles", () => {
  it("uses concise English picker labels", () => {
    expect(visualStyles.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "bars", label: "Bars" },
      { id: "mood", label: "Mood" },
      { id: "voyage", label: "Voyage" },
    ]);
  });

  it("offers the shared in-canvas HUD on every mood-aware imagery", () => {
    for (const style of visualStyles.filter((entry) => entry.moodAware)) {
      expect(style.options?.find((option) => option.key === "moodHud")?.defaultValue).toBe(1);
    }
  });

  it("enables Voyage line effects by default", () => {
    const voyage = visualStyles.find((entry) => entry.id === "voyage");
    expect(voyage?.options?.find((option) => option.key === "wireframe")?.defaultValue).toBe(1);
  });

  it("selects at most one not-yet-loaded Three style for idle preload", () => {
    expect(nextThreeStyleToPreload(null)?.id).toBe("mood");
    expect(nextThreeStyleToPreload("mood")?.id).toBe("voyage");
    expect(nextThreeStyleToPreload("voyage", new Set(["mood"]))).toBeUndefined();
  });
});
