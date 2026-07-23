/**
 * Visualizer video export: capture the active spectrum canvas plus the
 * playback audio into a video file using the webview's MediaRecorder.
 *
 * Boundary note: encoding happens inside the webview's media stack (the
 * system H.264/AAC encoder on macOS). The Rust core never touches audio or
 * video samples — it only writes the finished bytes to a user-chosen path.
 */

export interface RecordingMime {
  mimeType: string;
  extension: "mp4" | "webm";
}

export type RecordingResolutionId = "720p" | "1080p" | "1440p" | "2160p";

export interface RecordingResolution {
  id: RecordingResolutionId;
  label: string;
  width: number;
  height: number;
  videoBitsPerSecond: number;
}

export const RECORDING_RESOLUTIONS: readonly RecordingResolution[] = [
  { id: "720p", label: "720p", width: 1280, height: 720, videoBitsPerSecond: 6_000_000 },
  { id: "1080p", label: "1080p", width: 1920, height: 1080, videoBitsPerSecond: 12_000_000 },
  { id: "1440p", label: "1440p", width: 2560, height: 1440, videoBitsPerSecond: 20_000_000 },
  { id: "2160p", label: "4K", width: 3840, height: 2160, videoBitsPerSecond: 35_000_000 },
];

export const DEFAULT_RECORDING_RESOLUTION_ID: RecordingResolutionId = "1080p";

export function recordingResolution(id: RecordingResolutionId): RecordingResolution {
  const resolution = RECORDING_RESOLUTIONS.find((candidate) => candidate.id === id);
  if (!resolution) throw new Error(`unknown recording resolution: ${id}`);
  return resolution;
}

const MIME_CANDIDATES: RecordingMime[] = [
  { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

/** First container/codec pair the current recorder supports (mp4 preferred). */
export function pickRecordingMime(
  isTypeSupported: (mime: string) => boolean,
): RecordingMime | null {
  for (const candidate of MIME_CANDIDATES) {
    if (isTypeSupported(candidate.mimeType)) return candidate;
  }
  return null;
}

/** `piece-visualizer-20260720-2058.mp4`, stem taken from the loaded asset. */
export function recordingFileName(
  assetPath: string | null,
  extension: string,
  now: Date,
  resolutionId?: RecordingResolutionId,
): string {
  const base = assetPath?.split("/").at(-1) ?? "spectrum";
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base) || "spectrum";
  const safe = stem.replace(/[\\/:*?"<>|]/g, "_");
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}`;
  const resolution = resolutionId ? `-${resolutionId}` : "";
  return `${safe}-visualizer${resolution}-${stamp}.${extension}`;
}

export interface RecordingFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Letterbox a source frame into the output without stretching or cropping it. */
export function containRecordingFrame(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
): RecordingFrameRect {
  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    outputWidth <= 0 ||
    outputHeight <= 0
  ) {
    throw new Error("recording frame dimensions must be positive");
  }
  const scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (outputWidth - width) / 2,
    y: (outputHeight - height) / 2,
    width,
    height,
  };
}

export interface CanvasRecorderInit {
  canvas: HTMLCanvasElement;
  audioContext: AudioContext;
  /** Node carrying the mixed playback signal; tapped, never rerouted. */
  tap: AudioNode;
  mime: RecordingMime;
  fps?: number;
  videoBitsPerSecond?: number;
  /** Exact encoded frame size and its tuned default bitrate. */
  resolution?: RecordingResolution;
  /**
   * Paints chrome (the title card) over each frame. When present, capture
   * switches to an offscreen canvas composited per frame: source canvas
   * first, then this callback on top.
   */
  overlayDraw?: (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    dpr: number,
  ) => void;
}

/**
 * One recording session over the live spectrum canvas and playback audio.
 *
 * `start()` resolves once the encoder produced its first chunk (or after a
 * short grace period): WebKit's first-run encoder spin-up otherwise swallows
 * roughly the first second of the take, so callers should begin playback
 * after awaiting it.
 */
export class CanvasRecorder {
  readonly extension: "mp4" | "webm";
  private readonly recorder: MediaRecorder;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly tap: AudioNode;
  private readonly stream: MediaStream;
  private readonly chunks: Blob[] = [];
  private composite: HTMLCanvasElement | null = null;
  private compositeRaf: number | null = null;
  private torndown = false;

  constructor(init: CanvasRecorderInit) {
    this.tap = init.tap;
    this.destination = init.audioContext.createMediaStreamDestination();
    this.tap.connect(this.destination);
    const fps = init.fps ?? 30;
    const captureSource = init.overlayDraw || init.resolution
      ? this.startComposite(init.canvas, init.overlayDraw, fps, init.resolution)
      : init.canvas;
    const video = captureSource.captureStream(fps);
    this.stream = new MediaStream([
      ...video.getVideoTracks(),
      ...this.destination.stream.getAudioTracks(),
    ]);
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: init.mime.mimeType,
      videoBitsPerSecond:
        init.videoBitsPerSecond ?? init.resolution?.videoBitsPerSecond ?? 12_000_000,
    });
    this.extension = init.mime.extension;
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
  }

  /**
   * Mirror the source canvas into an offscreen composite at ~fps and let
   * `overlayDraw` paint on top. The composite lives off-viewport in the DOM
   * so WebKit keeps feeding its captureStream. Redraws are scheduled after
   * the visualizer's own rAF loop, so WebGL frames are still intact when
   * copied (no preserveDrawingBuffer needed).
   */
  private startComposite(
    source: HTMLCanvasElement,
    overlayDraw: CanvasRecorderInit["overlayDraw"],
    fps: number,
    resolution?: RecordingResolution,
  ): HTMLCanvasElement {
    const composite = document.createElement("canvas");
    composite.width = resolution?.width ?? Math.max(2, source.width);
    composite.height = resolution?.height ?? Math.max(2, source.height);
    composite.style.cssText = "position: fixed; left: -10000px; top: 0; pointer-events: none;";
    document.body.appendChild(composite);
    const ctx = composite.getContext("2d");
    if (!ctx) {
      composite.remove();
      throw new Error("could not create recording canvas");
    }
    this.composite = composite;
    const interval = 1000 / fps;
    let last = 0;
    const loop = (now: number) => {
      this.compositeRaf = requestAnimationFrame(loop);
      if (now - last < interval - 4) return;
      last = now;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#010403";
      ctx.fillRect(0, 0, composite.width, composite.height);
      if (source.width > 0 && source.height > 0) {
        const frame = containRecordingFrame(
          source.width,
          source.height,
          composite.width,
          composite.height,
        );
        ctx.drawImage(source, frame.x, frame.y, frame.width, frame.height);
      }
      const dpr =
        source.clientWidth > 0 ? composite.width / source.clientWidth : composite.width / 1920;
      overlayDraw?.(ctx, composite.width, composite.height, dpr);
    };
    this.compositeRaf = requestAnimationFrame(loop);
    return composite;
  }

  /**
   * Begin recording; resolves once the encoder produced its first chunk or
   * after a short grace period. WebKit ignores the `start()` timeslice and
   * may only flush on `requestData()`/`stop()`, so we prod it — but never
   * fail the take over a quiet warm-up: engines that buffer everything
   * until `stop()` still deliver the full take in the final blob.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearInterval(prod);
        clearTimeout(grace);
        this.recorder.removeEventListener("dataavailable", onChunk);
        this.recorder.removeEventListener("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onChunk = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) finish();
      };
      const onError = () => {
        finish(new Error("media recorder failed to start"));
      };
      // WebKit's first-run encoder swallows roughly the first second; prod
      // for a flush until it proves warm, then hand control to playback.
      const prod = setInterval(() => {
        if (this.recorder.state !== "recording") return;
        try {
          this.recorder.requestData();
        } catch {
          // flush-on-demand unsupported; the grace timer takes over
        }
      }, 300);
      const grace = setTimeout(() => finish(), 2500);
      this.recorder.addEventListener("dataavailable", onChunk);
      this.recorder.addEventListener("error", onError);
      try {
        this.recorder.start(500);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Stop and finalize; resolves with the finished container bytes. */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.recorder.addEventListener(
        "stop",
        () => {
          const type = this.recorder.mimeType || "application/octet-stream";
          this.teardown();
          const blob = new Blob(this.chunks, { type });
          if (blob.size === 0) reject(new Error("recorder produced no data"));
          else resolve(blob);
        },
        { once: true },
      );
      try {
        this.recorder.stop();
      } catch (error) {
        this.teardown();
        reject(error);
      }
    });
  }

  /** Release the audio tap and capture tracks; safe to call twice. */
  dispose() {
    if (this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // already stopping
      }
    }
    this.teardown();
  }

  private teardown() {
    if (this.torndown) return;
    this.torndown = true;
    if (this.compositeRaf !== null) cancelAnimationFrame(this.compositeRaf);
    this.composite?.remove();
    this.composite = null;
    try {
      this.tap.disconnect(this.destination);
    } catch {
      // tap already disconnected by graph teardown
    }
    for (const track of this.stream.getTracks()) track.stop();
  }
}
