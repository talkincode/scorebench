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

  it("offers the shared in-canvas HUD on every mood-aware imagery", () => {
    for (const style of visualStyles.filter((entry) => entry.moodAware)) {
      expect(style.options?.find((option) => option.key === "moodHud")?.defaultValue).toBe(1);
    }
  });

  it("enables Voyage line effects by default", () => {
    const voyage = visualStyles.find((entry) => entry.id === "voyage");
    expect(voyage?.options?.find((option) => option.key === "wireframe")?.defaultValue).toBe(1);
  });
});
