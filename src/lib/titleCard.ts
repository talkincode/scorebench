/**
 * Title card and watermark burned into recorded takes.
 *
 * Pure layout helpers (text wrapping, signature line) plus the canvas
 * painter the recorder composites over every captured frame: the piece's
 * metadata top-left, the app badge (logo + repo URL) bottom-right. The
 * live HUD shows the same metadata as DOM in VisualizerOverlay; this
 * module only paints into the recording's offscreen canvas.
 */

export interface TitleCardMeta {
  title?: string | null;
  story?: string | null;
  tempo?: number | null;
  key?: string | null;
  time_signature?: string | null;
  bars?: number | null;
}

/** `128 BPM · A minor · 4/4 · 16 bars` — only the facts the scene declares. */
export function sceneSignature(meta: TitleCardMeta | null | undefined): string {
  if (!meta) return "";
  return [
    meta.tempo != null ? `${meta.tempo} BPM` : null,
    meta.key ?? null,
    meta.time_signature ?? null,
    meta.bars != null ? `${meta.bars} bars` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

// CJK glyphs wrap per character; everything else wraps on whitespace.
const CJK_RANGES =
  "\\u1100-\\u11FF\\u2E80-\\uA4CF\\uA840-\\uD7AF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF";
const ATOM_PATTERN = new RegExp(`\\s+|[${CJK_RANGES}]|[^\\s${CJK_RANGES}]+`, "g");

/**
 * Greedy line wrap against a caller-supplied measure (canvas `measureText`
 * in production, character counts in tests). Newlines force breaks, runs of
 * whitespace collapse, and when `maxLines` runs out the last line is
 * trimmed to fit a terminal ellipsis.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (line: string) => number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let truncated = false;

  const push = (line: string): boolean => {
    if (lines.length === maxLines) {
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  };

  for (const paragraph of text.split("\n")) {
    if (truncated) break;
    let line = "";
    for (const atom of paragraph.match(ATOM_PATTERN) ?? []) {
      if (truncated) break;
      if (/^\s+$/.test(atom)) {
        if (line !== "") line += " ";
        continue;
      }
      const candidate = line + atom;
      if (line === "" || measure(candidate) <= maxWidth) {
        line = candidate;
      } else {
        if (!push(line.trimEnd())) break;
        line = atom;
      }
    }
    if (!truncated && line.trim() !== "") {
      if (!push(line.trimEnd())) break;
    }
  }

  if (truncated && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last !== "" && measure(`${last}…`) > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

export const REPO_WATERMARK = "github.com/talkincode/scorebench";

/** Opacity of the whole watermark layer over the spectrum. */
export const WATERMARK_ALPHA = 0.85;

export interface TitleCardFrame {
  /** Canvas size in device pixels and the device/CSS pixel ratio. */
  width: number;
  height: number;
  dpr: number;
  alpha: number;
  eyebrow?: string | null;
  title?: string | null;
  signature?: string | null;
  story?: string | null;
  /** Bottom-right badge: semi-transparent logo plus attribution line. */
  badgeText?: string | null;
  logo?: CanvasImageSource | null;
  /** Font stacks and colors lifted from the app's CSS custom properties. */
  mono: string;
  sans: string;
  fg: string;
  dim: string;
  accent: string;
}

/** Paint the persistent watermark: metadata top-left, badge bottom-right. */
export function drawTitleCard(ctx: CanvasRenderingContext2D, frame: TitleCardFrame): void {
  if (frame.alpha <= 0 || frame.width <= 0 || frame.height <= 0) return;
  const dpr = frame.dpr > 0 ? frame.dpr : 1;
  const w = frame.width / dpr;
  const h = frame.height / dpr;
  const measure = (line: string) => ctx.measureText(line).width;
  const spacing = (value: string) => {
    const style = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
    if ("letterSpacing" in style) style.letterSpacing = value;
  };

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = frame.alpha;

  // Legibility scrim, softened for permanent presence over the spectrum.
  const scrimHeight = h * 0.38;
  const scrim = ctx.createLinearGradient(0, 0, 0, scrimHeight);
  scrim.addColorStop(0, "rgba(0, 0, 0, 0.45)");
  scrim.addColorStop(0.55, "rgba(0, 0, 0, 0.2)");
  scrim.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, w, scrimHeight);

  const margin = Math.min(34, Math.max(20, w * 0.025));
  const x = margin;
  let y = margin + 4;
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
  ctx.shadowBlur = 12 * dpr;

  if (frame.eyebrow) {
    ctx.font = `10px ${frame.mono}`;
    spacing("1.6px");
    ctx.fillStyle = frame.dim;
    y += 10;
    ctx.fillText(frame.eyebrow.toUpperCase(), x, y);
    y += 10;
  }

  if (frame.title) {
    const size = Math.min(34, Math.max(21, w * 0.031));
    ctx.font = `250 ${size}px ${frame.sans}`;
    spacing("0.5px");
    ctx.fillStyle = frame.fg;
    for (const line of wrapText(frame.title, w * 0.86, measure, 2)) {
      y += size * 1.15;
      ctx.fillText(line, x, y);
    }
    y += 6;
  }

  if (frame.signature) {
    ctx.font = `11px ${frame.mono}`;
    spacing("1px");
    ctx.fillStyle = frame.accent;
    y += 15;
    ctx.fillText(frame.signature, x, y);
    y += 8;
  }

  if (frame.story) {
    const lineHeight = 22;
    ctx.font = `12.5px ${frame.sans}`;
    spacing("0px");
    const lines = wrapText(frame.story, Math.min(440, w * 0.5), measure, 4);
    if (lines.length > 0) {
      const barTop = y + 9;
      ctx.globalAlpha = frame.alpha * 0.78;
      ctx.fillStyle = frame.fg;
      for (const line of lines) {
        y += lineHeight;
        ctx.fillText(line, x + 13, y);
      }
      // The quote's accent rule, kept crisp: no shadow.
      ctx.shadowBlur = 0;
      ctx.globalAlpha = frame.alpha * 0.9;
      ctx.fillStyle = frame.accent;
      ctx.fillRect(x, barTop, 2, y - barTop + 4);
    }
  }

  if (frame.badgeText || frame.logo) {
    const logoSize = 34;
    ctx.font = `11.5px ${frame.mono}`;
    spacing("0.8px");
    ctx.shadowBlur = 10 * dpr;
    const text = frame.badgeText ?? "";
    const textWidth = text ? measure(text) : 0;
    const gap = frame.logo && text ? 10 : 0;
    const left = w - margin - (frame.logo ? logoSize : 0) - gap - textWidth;
    const logoTop = h - margin - logoSize;
    if (frame.logo) {
      ctx.globalAlpha = frame.alpha * 0.55;
      ctx.drawImage(frame.logo, left, logoTop, logoSize, logoSize);
    }
    if (text) {
      ctx.globalAlpha = frame.alpha * 0.66;
      ctx.fillStyle = frame.dim;
      // Baseline optically centered against the logo tile.
      ctx.fillText(text, left + (frame.logo ? logoSize + gap : 0), logoTop + logoSize / 2 + 4);
    }
  }

  ctx.restore();
}
