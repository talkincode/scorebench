import { describe, expect, it } from "vitest";
import { ASSIST_CATEGORIES, assistTag, recommendedFor } from "./assist";

describe("assist tag library", () => {
  const allTags = ASSIST_CATEGORIES.flatMap((category) => category.tags);

  it("has globally unique tag ids", () => {
    const ids = allTags.map((tag) => tag.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every recommends entry points at an existing tag", () => {
    for (const tag of allTags) {
      for (const rec of tag.recommends ?? []) {
        expect(assistTag(rec), `${tag.id} recommends missing ${rec}`).toBeDefined();
      }
    }
  });

  it("no tag recommends itself", () => {
    for (const tag of allTags) {
      expect(tag.recommends ?? []).not.toContain(tag.id);
    }
  });

  it("every tag carries bilingual label and insert text", () => {
    for (const tag of allTags) {
      expect(tag.label.en.trim()).not.toBe("");
      expect(tag.label.zh.trim()).not.toBe("");
      expect(tag.text.en.trim()).not.toBe("");
      expect(tag.text.zh.trim()).not.toBe("");
    }
  });

  it("recommendedFor unions recommendations and excludes the selection", () => {
    const selected = new Set(["mood.sad"]);
    const recommended = recommendedFor(selected);
    expect(recommended.has("inst.piano-strings")).toBe(true);
    expect(recommended.has("perf.legato")).toBe(true);
    expect(recommended.has("mood.sad")).toBe(false);
    expect(recommendedFor(new Set()).size).toBe(0);
  });
});
