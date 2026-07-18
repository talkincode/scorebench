import type { SpectrumFrame, SpectrumStyle } from "./types";

export function drawWithFallback(
  style: SpectrumStyle,
  fallback: SpectrumStyle,
  frame: SpectrumFrame,
  failedStyles: Set<string>,
  report: (error: unknown) => void = console.error,
): SpectrumStyle {
  try {
    style.draw(frame);
    return style;
  } catch (error) {
    if (!failedStyles.has(style.id)) {
      failedStyles.add(style.id);
      report(error);
    }
    fallback.draw(frame);
    return fallback;
  }
}
