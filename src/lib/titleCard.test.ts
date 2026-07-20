import { describe, expect, it } from "vitest";
import { sceneSignature, wrapText } from "./titleCard";

const perChar = (line: string) => line.length * 10;

describe("wrapText", () => {
  it("wraps latin text on word boundaries", () => {
    expect(wrapText("hello world foo", 60, perChar, 5)).toEqual(["hello", "world", "foo"]);
  });

  it("keeps words together when they fit", () => {
    expect(wrapText("ab cd", 50, perChar, 5)).toEqual(["ab cd"]);
  });

  it("wraps CJK text per glyph", () => {
    expect(wrapText("音乐可视化", 30, perChar, 5)).toEqual(["音乐可", "视化"]);
  });

  it("honors explicit newlines", () => {
    expect(wrapText("a\nb", 100, perChar, 5)).toEqual(["a", "b"]);
  });

  it("ellipsizes when lines run out", () => {
    expect(wrapText("hello world foo", 60, perChar, 2)).toEqual(["hello", "world…"]);
  });

  it("does not ellipsize exact fits", () => {
    expect(wrapText("abc", 30, perChar, 1)).toEqual(["abc"]);
  });
});

describe("sceneSignature", () => {
  it("joins declared facts with middots", () => {
    expect(sceneSignature({ tempo: 128, key: "A minor", time_signature: "4/4", bars: 16 })).toBe(
      "128 BPM · A minor · 4/4 · 16 bars",
    );
  });

  it("skips missing fields", () => {
    expect(sceneSignature({ key: "D dorian" })).toBe("D dorian");
    expect(sceneSignature(null)).toBe("");
  });
});
