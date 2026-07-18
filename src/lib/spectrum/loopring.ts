import type { SpectrumStyle } from "./types";

export const loopring: SpectrumStyle = {
  id: "loopring",
  label: "Loop ring",
  options: [{ key: "bars", label: "Bars", min: 24, max: 128, step: 8, defaultValue: 64 }],
  draw({ ctx, width, height, freq, positionFraction, prefersReducedMotion, options }) {
    ctx.clearRect(0, 0, width, height);
    const count = Math.max(24, Math.min(128, Math.round(options.bars ?? 64)));
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.max(8, Math.min(width, height) * 0.22);
    const maxLength = Math.min(width, height) * 0.25;
    const step = Math.max(1, Math.floor(freq.length / count));

    ctx.lineCap = "round";
    for (let index = 0; index < count; index++) {
      const value = (freq[index * step] ?? 0) / 255;
      const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
      const length = 2 + value * maxLength;
      ctx.strokeStyle = `hsl(${(options.themeHue ?? 171) + value * 65} 82% ${42 + value * 20}%)`;
      ctx.lineWidth = Math.max(1, (Math.PI * 2 * radius) / count - 1);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      ctx.lineTo(
        cx + Math.cos(angle) * (radius + length),
        cy + Math.sin(angle) * (radius + length),
      );
      ctx.stroke();
    }

    const fraction = prefersReducedMotion
      ? Math.round(positionFraction * 16) / 16
      : positionFraction;
    const marker = -Math.PI / 2 + fraction * Math.PI * 2;
    ctx.fillStyle = "#f4f1ea";
    ctx.beginPath();
    ctx.arc(
      cx + Math.cos(marker) * (radius - 7),
      cy + Math.sin(marker) * (radius - 7),
      2.5,
      0,
      Math.PI * 2,
    );
    ctx.fill();

    // The loop seam is always the fixed 12 o'clock tick.
    ctx.strokeStyle = `hsl(${options.themeHue ?? 171} 82% 60%)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius - maxLength - 4);
    ctx.lineTo(cx, cy - radius - maxLength + 4);
    ctx.stroke();
  },
};
