import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDING_RESOLUTION_ID,
  RECORDING_RESOLUTIONS,
  containRecordingFrame,
  pickRecordingMime,
  recordingFileName,
  recordingResolution,
} from "./recording";

describe("recording resolutions", () => {
  it("offers standard 16:9 sizes with increasing bitrates", () => {
    expect(RECORDING_RESOLUTIONS.map(({ id, width, height }) => ({ id, width, height }))).toEqual([
      { id: "720p", width: 1280, height: 720 },
      { id: "1080p", width: 1920, height: 1080 },
      { id: "1440p", width: 2560, height: 1440 },
      { id: "2160p", width: 3840, height: 2160 },
    ]);
    expect(recordingResolution(DEFAULT_RECORDING_RESOLUTION_ID).width).toBe(1920);
    expect(RECORDING_RESOLUTIONS.map((preset) => preset.videoBitsPerSecond)).toEqual([
      6_000_000, 12_000_000, 20_000_000, 35_000_000,
    ]);
  });

  it("letterboxes frames without stretching or cropping", () => {
    expect(containRecordingFrame(4, 3, 1920, 1080)).toEqual({
      x: 240,
      y: 0,
      width: 1440,
      height: 1080,
    });
    expect(containRecordingFrame(2560, 1080, 1920, 1080)).toEqual({
      x: 0,
      y: 135,
      width: 1920,
      height: 810,
    });
  });
});

describe("pickRecordingMime", () => {
  it("prefers mp4 with explicit codecs when supported", () => {
    const choice = pickRecordingMime(() => true);
    expect(choice).toEqual({
      mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      extension: "mp4",
    });
  });

  it("falls back to plain mp4, then webm", () => {
    const mp4Only = pickRecordingMime((m) => m === "video/mp4");
    expect(mp4Only?.mimeType).toBe("video/mp4");
    expect(mp4Only?.extension).toBe("mp4");

    const webmOnly = pickRecordingMime((m) => m.startsWith("video/webm"));
    expect(webmOnly?.mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(webmOnly?.extension).toBe("webm");
  });

  it("returns null when nothing is supported", () => {
    expect(pickRecordingMime(() => false)).toBeNull();
  });
});

describe("recordingFileName", () => {
  const at = new Date(2026, 6, 20, 20, 58);

  it("derives the stem from the loaded asset path", () => {
    expect(recordingFileName("build/piece.final.ogg", "mp4", at)).toBe(
      "piece.final-visualizer-20260720-2058.mp4",
    );
  });

  it("falls back to a generic stem without an asset", () => {
    expect(recordingFileName(null, "webm", at)).toBe("spectrum-visualizer-20260720-2058.webm");
  });

  it("sanitizes filesystem-hostile characters and keeps dotfiles whole", () => {
    expect(recordingFileName('out/a:b?"c.wav', "mp4", at)).toBe(
      "a_b__c-visualizer-20260720-2058.mp4",
    );
    expect(recordingFileName("out/.hidden", "mp4", at)).toBe(
      ".hidden-visualizer-20260720-2058.mp4",
    );
  });

  it("zero-pads the timestamp", () => {
    expect(recordingFileName(null, "mp4", new Date(2026, 0, 5, 9, 7))).toBe(
      "spectrum-visualizer-20260105-0907.mp4",
    );
  });

  it("includes the selected resolution when supplied", () => {
    expect(recordingFileName("build/piece.ogg", "mp4", at, "2160p")).toBe(
      "piece-visualizer-2160p-20260720-2058.mp4",
    );
  });
});
