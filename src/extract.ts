import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import ffmpeg from "fluent-ffmpeg";
import { logger } from "./logger.js";

export const MAX_DURATION_SECONDS = 3600; // 60 min
export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB
/** Video mode: 720p mp4 runs bigger than 128kbps mp3, so it gets its own cap. */
/** Video mode: 480p mp4 keeps tokens/size down while staying legible. */
export const DEFAULT_VIDEO_MAX_HEIGHT = 480;
export const MAX_VIDEO_FILE_BYTES = 300 * 1024 * 1024; // 300MB
export const YTDLP_EXTRACT_TIMEOUT_MS = 240_000; // 240s
/** Video mode needs longer than audio (bigger download + ffmpeg merge). */
export const YTDLP_VIDEO_TIMEOUT_MS = 600_000; // 600s

/** What the caller wants out of a job: audio-only (default) or a video file. */
export type MediaKind = "audio" | "video";

export class RejectedError extends Error {
  code = "rejected" as const;
  status = 400;
  reason: string;
  constructor(reason: string) {
    super(`rejected: ${reason}`);
    this.name = "RejectedError";
    this.reason = reason;
  }
}

export class BlockedError extends Error {
  code = "blocked_429" as const;
  status = 502;
  hint: string;
  constructor(hint = "YouTube returned 429/403. Refresh YTDLP_COOKIES_B64 (export fresh cookies from a logged-in browser) or redeploy with a newer pinned yt-dlp (see Dockerfile).") {
    super("YouTube blocked the request (429/403)");
    this.name = "BlockedError";
    this.hint = hint;
  }
}

export class TooLargeError extends Error {
  code = "too_large" as const;
  status = 413;
  constructor(message = "Audio exceeds 100MB limit") {
    super(message);
    this.name = "TooLargeError";
  }
}

export class TimeoutError extends Error {
  code = "timeout" as const;
  status = 504;
  constructor(message = "yt-dlp timed out after 240s") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** yt-dlp merge/re-encode failed (usually needs ffmpeg, or an unsupported codec). */
export class VideoMergeError extends Error {
  code = "video_merge_failed" as const;
  status = 502;
  constructor(message: string) {
    super(message);
    this.name = "VideoMergeError";
  }
}

export interface OembedInfo {
  title: string | null;
  author: string | null;
}

export async function getOembed(videoId: string, timeoutMs = 10_000): Promise<OembedInfo> {
  const started = Date.now();
  const canonical = `https://www.youtube.com/watch?v=${videoId}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "ielts-youtube-extractor/1.0" },
    });
    if (!res.ok) {
      logger.debug(`[oembed] miss videoId=${videoId} http=${res.status} elapsedMs=${Date.now() - started}`);
      return { title: null, author: null };
    }
    const json = (await res.json()) as { title?: string; author_name?: string };
    const info = {
      title: typeof json.title === "string" ? json.title : null,
      author: typeof json.author_name === "string" ? json.author_name : null,
    };
    logger.debug(
      `[oembed] hit videoId=${videoId} elapsedMs=${Date.now() - started} ` +
        `title=${info.title ? JSON.stringify(info.title.slice(0, 100)) : "null"} author=${info.author ?? "null"}`
    );
    return info;
  } catch (err) {
    logger.debug(`[oembed] error videoId=${videoId} elapsedMs=${Date.now() - started} err=${String(err).slice(0, 150)}`);
    return { title: null, author: null };
  } finally {
    clearTimeout(t);
  }
}

export interface YtDlpMetadata {
  title: string | null;
  duration: number | null;
  isLive: boolean;
  liveStatus: string | null;
  availability: string | null;
  ageLimit: number;
  uploader: string | null;
}

function runCmd(
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxBytes = 500_000
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    logger.debug(`[yt-dlp] spawn: ${cmd} ${args.join(" ")} timeoutMs=${timeoutMs}`);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    const kill = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > maxBytes) {
        stdout = stdout.slice(-maxBytes);
        truncated = true;
      }
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > maxBytes) {
        stderr = stderr.slice(-maxBytes);
        truncated = true;
      }
    });
    child.on("error", (err) => {
      clearTimeout(kill);
      logger.debug(`[yt-dlp] spawn error: ${cmd} elapsedMs=${Date.now() - started} err=${String(err).slice(0, 200)}`);
      resolve({ code: 1, stdout, stderr: stderr + `\nspawn error: ${String(err)}`, timedOut, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      logger.debug(
        `[yt-dlp] exit: ${cmd} code=${code} elapsedMs=${Date.now() - started} timedOut=${timedOut} ` +
          `stdoutBytes=${stdout.length} stderrBytes=${stderr.length} truncated=${truncated}`
      );
      resolve({ code, stdout, stderr, timedOut, truncated });
    });
  });
}

export function isBlockedOutput(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("http error 429") ||
    t.includes("error 429") ||
    t.includes(" 429 ") ||
    t.includes("too many requests") ||
    t.includes("http error 403") ||
    t.includes("error 403") ||
    t.includes("sign in to confirm") ||
    (t.includes("forbidden") && t.includes("youtube"))
  );
}

export function isTooLargeOutput(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes("larger than max-filesize") || t.includes("max-filesize") || t.includes("file is larger than");
}

/**
 * Bound yt-dlp's own retry behaviour.
 *
 * yt-dlp defaults to ~10 extraction retries and ~10 fragment retries with
 * exponential backoff. When YouTube blocks the host IP (429/403 — routine
 * for a datacentre IP with no cookies), every one of those retries is a
 * guaranteed failure, so a request that is dead in one second instead hangs
 * until our own timeout expires: the admin waits 4 minutes to be told
 * "timed out" instead of "blocked". Two quick retries plus a short socket
 * timeout surface the real 429 in seconds.
 */
const BOUNDED_RETRY_ARGS = [
  "--socket-timeout",
  "15",
  "--retries",
  "2",
  "--fragment-retries",
  "2",
  "--retry-sleep",
  "linear",
] as const;

/** Field order for the `--print` metadata fetch. Must match the args below. */
const META_PRINT_ORDER = [
  "title",
  "duration",
  "is_live",
  "live_status",
  "availability",
  "age_limit",
  "uploader",
  "channel",
] as const;

function nullIfNA(v: string): string | null {
  return v === "NA" ? null : v;
}

function numberIfPresent(v: string): number | null {
  if (v === "NA") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the 8-line `--print` metadata output in field order. Only `title`
 * is free text and may itself contain newlines: surplus lines are folded
 * back into it, the last 7 lines are always the scalar fields.
 * Throws a detailed error (byte counts + excerpt) when the shape is wrong.
 */
export function parseMetadataPrint(stdout: string, stderr: string): YtDlpMetadata {
  const rawLines = stdout.split(/\r?\n/);
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (rawLines.length < META_PRINT_ORDER.length) {
    const tail = stderr.slice(-400).trim();
    throw new Error(
      `yt-dlp metadata print returned ${rawLines.length} lines, expected ${META_PRINT_ORDER.length} ` +
        `(stdout ${stdout.length} bytes). Output: ${JSON.stringify(stdout.slice(0, 500))}` +
        (tail ? ` Stderr tail: ${JSON.stringify(tail)}` : " (stderr empty)")
    );
  }
  const scalar = rawLines.slice(-7);
  const titleRaw = rawLines.slice(0, rawLines.length - 7).join("\n");
  const [durationRaw, isLiveRaw, liveStatusRaw, availabilityRaw, ageLimitRaw, uploaderRaw, channelRaw] = scalar as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (rawLines.length > META_PRINT_ORDER.length) {
    logger.debug(`[meta] folded ${rawLines.length - META_PRINT_ORDER.length} extra newline(s) into title`);
  }
  const uploader = nullIfNA(uploaderRaw);
  return {
    title: titleRaw === "NA" || titleRaw === "" ? null : titleRaw,
    duration: numberIfPresent(durationRaw),
    isLive: isLiveRaw === "True",
    liveStatus: nullIfNA(liveStatusRaw),
    availability: nullIfNA(availabilityRaw),
    ageLimit: ageLimitRaw === "NA" ? 0 : (numberIfPresent(ageLimitRaw) ?? 0),
    uploader: uploader ?? nullIfNA(channelRaw),
  };
}

export async function getYtDlpMetadata(
  canonicalUrl: string,
  cookiesFile: string | null,
  timeoutMs = 60_000
): Promise<YtDlpMetadata> {
  // Field printing instead of --dump-single-json: caption/format-heavy
  // videos produce multi-MB dumps that break JSON parsing. Output size here
  // is bounded (~8 short lines) regardless of video. Order must match
  // META_PRINT_ORDER.
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout",
    "15",
    "--print",
    "%(title)s",
    "--print",
    "%(duration)s",
    "--print",
    "%(is_live)s",
    "--print",
    "%(live_status)s",
    "--print",
    "%(availability)s",
    "--print",
    "%(age_limit)s",
    "--print",
    "%(uploader)s",
    "--print",
    "%(channel)s",
  ];
  if (cookiesFile) args.push("--cookies", cookiesFile);
  args.push(canonicalUrl);
  logger.debug(`[meta] fetch url=${canonicalUrl} cookies=${cookiesFile ? "yes(path only)" : "no"}`);
  const started = Date.now();
  const { code, stdout, stderr, timedOut } = await runCmd("yt-dlp", args, timeoutMs);
  logger.debug(
    `[meta] raw elapsedMs=${Date.now() - started} code=${code} timedOut=${timedOut} stdoutBytes=${stdout.length}`
  );
  const combined = `${stdout}\n${stderr}`;
  if (timedOut) throw new TimeoutError("metadata fetch timed out");
  if (code !== 0) {
    if (isBlockedOutput(combined)) throw new BlockedError();
    throw new Error(`yt-dlp metadata failed: ${stderr.slice(-2000) || stdout.slice(-2000) || `exit ${code}`}`);
  }
  const meta = parseMetadataPrint(stdout, stderr);
  logger.debug(
    `[meta] parsed duration=${meta.duration} isLive=${meta.isLive} liveStatus=${meta.liveStatus} ` +
      `availability=${meta.availability} ageLimit=${meta.ageLimit} uploader=${meta.uploader ?? "null"} ` +
      `title=${meta.title ? JSON.stringify(meta.title.slice(0, 100)) : "null"}`
  );
  return meta;
}

export function assertMetadataAllowed(meta: YtDlpMetadata): void {
  // Live / upcoming
  if (meta.isLive) throw new RejectedError("video is a live stream");
  const ls = (meta.liveStatus || "").toLowerCase();
  // Note: && binds tighter than ||, so parenthesize explicitly.
  // Reject live/upcoming outright; reject was_live only when duration is
  // unknown (no VOD manifest yet — not downloadable).
  if (ls === "is_live" || ls === "is_upcoming" || (ls === "was_live" && meta.duration == null)) {
    throw new RejectedError(`live_status=${meta.liveStatus}`);
  }
  // Private / needs auth
  const avail = (meta.availability || "").toLowerCase();
  if (avail === "private" || avail === "needs_auth" || avail === "subscriber_only" || avail === "premium_only") {
    throw new RejectedError(`availability=${meta.availability}`);
  }
  // Age-restricted
  if (meta.ageLimit > 0) throw new RejectedError(`age-restricted (age_limit=${meta.ageLimit})`);
  // Duration cap
  if (meta.duration != null && meta.duration > MAX_DURATION_SECONDS) {
    throw new RejectedError(`duration ${Math.round(meta.duration)}s exceeds 3600s (60min) limit`);
  }
  logger.debug(`[meta] allowed duration=${meta.duration} liveStatus=${meta.liveStatus} availability=${meta.availability}`);
}

/**
 * Run the audio extraction. Returns the absolute mp3 path on success.
 * Throws BlockedError / TooLargeError / TimeoutError / Error.
 */
/**
 * Build the yt-dlp audio-extraction argv (pure — unit tested).
 * Trimming requires the ffmpeg downloader: yt-dlp aborts with
 * "This format cannot be partially downloaded" for section requests on
 * the native HTTP downloader. `--force-keyframes-at-cuts` is also only
 * honored by that downloader (it drops `-c copy` so ffmpeg re-encodes
 * around the boundaries), which is what makes the cut exact. Still a
 * single yt-dlp call — no separate ffmpeg step in our code.
 */
export function buildExtractArgs(
  canonicalUrl: string,
  outTemplate: string,
  cookiesFile: string | null,
  sectionArg: string | null
): string[] {
  const args = [
    "-f",
    "bestaudio/best",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "128K",
    "--no-playlist",
    "--max-filesize",
    "100M",
    "--no-warnings",
    ...BOUNDED_RETRY_ARGS,
  ];
  if (sectionArg) {
    args.push(
      "--downloader",
      "ffmpeg",
      "--download-sections",
      sectionArg,
      "--force-keyframes-at-cuts"
    );
  }
  if (cookiesFile) args.push("--cookies", cookiesFile);
  args.push("-o", outTemplate, canonicalUrl);
  return args;
}

/**
 * Build the yt-dlp video-extraction argv (pure — unit tested).
 *
 * Model-agnostic video for LLM input: only Gemini can be handed a YouTube
 * URL, so every other video model needs a plain HTTPS .mp4 file.
 *
 * The codec MUST be pinned with `vcodec^=avc1`, not just `[ext=mp4]`:
 * `[ext=mp4]` constrains the *container*, and when no mp4 video-only stream
 * exists at the requested height yt-dlp silently falls through to YouTube's
 * default codec — VP9 or AV1. Those decode fine in a browser but several
 * cheap video models only accept H.264, so the run fails at the provider
 * with no clue why. H.264 + AAC is the widest-common-denominator pair.
 *
 * Every branch keeps both the height cap and the codec pin. Single yt-dlp
 * call: ffmpeg is invoked by yt-dlp itself.
 *
 * Video is always full length: the API rejects start_time/end_time for
 * kind=video, so there is no --download-sections here (which would also force
 * the ffmpeg downloader and a slower re-encode for no benefit).
 */
export function buildVideoExtractArgs(
  canonicalUrl: string,
  outTemplate: string,
  cookiesFile: string | null,
  maxHeight = DEFAULT_VIDEO_MAX_HEIGHT
): string[] {
  const h = Math.round(maxHeight);
  const args = [
    "-f",
    `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]` +
      `/best[height<=${h}][vcodec^=avc1]`,
    "--merge-output-format",
    "mp4",
    "--no-playlist",
    "--max-filesize",
    "300M",
    "--no-warnings",
    ...BOUNDED_RETRY_ARGS,
  ];
  if (cookiesFile) args.push("--cookies", cookiesFile);
  args.push("-o", outTemplate, canonicalUrl);
  return args;
}

/**
 * Download + merge a height-capped mp4. Returns the absolute mp4 path.
 * Throws BlockedError / TooLargeError / TimeoutError / VideoMergeError / Error.
 */
export async function runYtDlpVideoExtract(
  canonicalUrl: string,
  tmpDir: string,
  cookiesFile: string | null,
  maxHeight = DEFAULT_VIDEO_MAX_HEIGHT,
  timeoutMs = YTDLP_VIDEO_TIMEOUT_MS
): Promise<{ filepath: string; stdout: string; stderr: string }> {
  const outTemplate = `${tmpDir}/%(id)s.%(ext)s`;
  const args = buildVideoExtractArgs(canonicalUrl, outTemplate, cookiesFile, maxHeight);
  logger.debug(
    `[extract:video] start url=${canonicalUrl} tmpDir=${tmpDir} maxHeight=${maxHeight} cookies=${cookiesFile ? "yes(path only)" : "no"}`
  );
  const started = Date.now();
  const { code, stdout, stderr, timedOut } = await runCmd("yt-dlp", args, timeoutMs);
  logger.debug(`[extract:video] yt-dlp done code=${code} timedOut=${timedOut} elapsedMs=${Date.now() - started}`);
  const combined = `${stdout}\n${stderr}`;

  if (timedOut) throw new TimeoutError(`video extract timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (isBlockedOutput(combined)) throw new BlockedError();
  if (isTooLargeOutput(combined)) throw new TooLargeError("Video exceeds 300MB limit");
  if (code !== 0) {
    const low = combined.toLowerCase();
    if (
      low.includes("ffmpeg") ||
      low.includes("merge") ||
      low.includes("you have requested merging of multiple formats")
    ) {
      throw new VideoMergeError(
        `yt-dlp could not produce an mp4: ${(stderr || stdout).slice(-800)}. The image must have ffmpeg installed.`
      );
    }
    throw new Error(`yt-dlp video extract failed (exit ${code}): ${stderr.slice(-3000) || stdout.slice(-3000)}`);
  }

  const entries = await fs.readdir(tmpDir);
  const mp4 = entries.filter((f) => f.toLowerCase().endsWith(".mp4")).sort();
  logger.debug(
    `[extract:video] tmp listing count=${entries.length} mp4=${mp4.length} files=${entries.slice(0, 10).join(",") || "none"}`
  );
  if (mp4.length === 0) {
    throw new VideoMergeError(
      `yt-dlp finished but no .mp4 found in tmp dir (files: ${entries.join(", ") || "none"}). ` +
        `The source likely has no H.264 stream at ${Math.round(maxHeight)}p.`
    );
  }
  // Take the largest mp4: that is the merged video+audio output, never a
  // leftover single-stream fragment.
  let filepath = `${tmpDir}/${mp4[0]}`;
  {
    let biggest = filepath;
    let biggestSize = -1;
    for (const f of mp4) {
      const st = await fs.stat(`${tmpDir}/${f}`);
      if (st.size > biggestSize) {
        biggestSize = st.size;
        biggest = `${tmpDir}/${f}`;
      }
    }
    filepath = biggest;
  }

  // Guard the codec promise. The -f selector pins avc1, but a re-mux or an
  // unexpected stream must never ship as "h264" — several cheap video models
  // reject VP9/AV1 outright and the failure surfaces at the provider with no
  // useful context. Fail here, where the cause is obvious.
  // ffprobe reports H.264 as codec_name "h264" ("avc1" is the container
  // fourcc), so accept either spelling.
  const codecs = await probeVideoCodec(filepath);
  if (codecs.video && !/^(h264|avc1)$/i.test(codecs.video)) {
    throw new VideoMergeError(
      `Expected H.264 video for model compatibility but got "${codecs.video}". ` +
        `VP9/AV1 are rejected by several video models.`
    );
  }
  const finalStat = await fs.stat(filepath);
  logger.debug(`[extract:video] picked file=${filepath} sizeBytes=${finalStat.size} elapsedMs=${Date.now() - started}`);
  return { filepath, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) };
}

export async function runYtDlpExtract(
  canonicalUrl: string,
  tmpDir: string,
  cookiesFile: string | null,
  timeoutMs = YTDLP_EXTRACT_TIMEOUT_MS,
  sectionArg: string | null = null
): Promise<{ filepath: string; stdout: string; stderr: string }> {
  const outTemplate = `${tmpDir}/%(id)s.%(ext)s`;
  const args = buildExtractArgs(canonicalUrl, outTemplate, cookiesFile, sectionArg);

  logger.debug(
    `[extract] start url=${canonicalUrl} tmpDir=${tmpDir} cookies=${cookiesFile ? "yes(path only)" : "no"} sections=${sectionArg ?? "none"}`
  );
  const started = Date.now();
  const { code, stdout, stderr, timedOut } = await runCmd("yt-dlp", args, timeoutMs);
  logger.debug(`[extract] yt-dlp done code=${code} timedOut=${timedOut} elapsedMs=${Date.now() - started}`);
  const combined = `${stdout}\n${stderr}`;

  if (timedOut) throw new TimeoutError();
  if (code !== 0) {
    if (isBlockedOutput(combined)) throw new BlockedError();
    if (isTooLargeOutput(combined)) throw new TooLargeError();
    // yt-dlp sometimes exits non-zero for max-filesize with a clear message
    throw new Error(`yt-dlp extract failed (exit ${code}): ${stderr.slice(-3000) || stdout.slice(-3000)}`);
  }
  if (isBlockedOutput(combined)) throw new BlockedError();

  const entries = await fs.readdir(tmpDir);
  const mp3 = entries.filter((f) => f.toLowerCase().endsWith(".mp3")).sort();
  logger.debug(`[extract] tmp listing count=${entries.length} mp3=${mp3.length} files=${entries.slice(0, 10).join(",") || "none"}`);
  if (mp3.length === 0) {
    // Include listing to help debug (no secrets)
    throw new Error(`yt-dlp finished but no .mp3 found in tmp dir (files: ${entries.join(", ") || "none"})`);
  }
  // Prefer exact video-id match; otherwise take the largest mp3
  let filepath = `${tmpDir}/${mp3[0]}`;
  if (mp3.length > 1) {
    let biggest = filepath;
    let biggestSize = -1;
    for (const f of mp3) {
      const st = await fs.stat(`${tmpDir}/${f}`);
      if (st.size > biggestSize) {
        biggestSize = st.size;
        biggest = `${tmpDir}/${f}`;
      }
    }
    filepath = biggest;
  }
  const finalStat = await fs.stat(filepath);
  logger.debug(`[extract] picked file=${filepath} sizeBytes=${finalStat.size} elapsedMs=${Date.now() - started}`);
  return { filepath, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) };
}

export interface MediaInfo {
  durationSeconds: number | null;
  sizeBytes: number;
}

export function probeDuration(filepath: string): Promise<number | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err) {
        logger.debug(`[ffprobe] error file=${filepath} err=${String(err).slice(0, 200)}`);
        return resolve(null);
      }
      const d = metadata?.format?.duration as unknown;
      if (typeof d === "number" && Number.isFinite(d)) return resolve(d);
      if (typeof d === "string" && d.trim() !== "" && Number.isFinite(Number(d))) return resolve(Number(d));
      return resolve(null);
    });
  });
}

export async function getMediaInfo(filepath: string): Promise<MediaInfo> {
  const stat = await fs.stat(filepath);
  const durationSeconds = await probeDuration(filepath);
  logger.debug(`[ffprobe] file=${filepath} sizeBytes=${stat.size} durationSeconds=${durationSeconds}`);
  return { durationSeconds, sizeBytes: stat.size };
}

/**
 * True when the file has at least one video stream. An audio-only source
 * (or a failed merge) would otherwise be uploaded and fed to the model as
 * a "video" it cannot see.
 */
export function hasVideoStream(filepath: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err) {
        logger.debug(`[ffprobe] video-stream probe failed file=${filepath} err=${String(err).slice(0, 200)}`);
        return resolve(false);
      }
      const streams = (metadata?.streams ?? []) as Array<{ codec_type?: string }>;
      const has = streams.some((s) => s.codec_type === "video");
      logger.debug(`[ffprobe] video-stream file=${filepath} streams=${streams.length} hasVideo=${has}`);
      resolve(has);
    });
  });
}

/** Codec names of the first video/audio stream, or null when absent. */
export function probeVideoCodec(filepath: string): Promise<{ video: string | null; audio: string | null }> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err) {
        logger.debug(`[ffprobe] codec probe failed file=${filepath} err=${String(err).slice(0, 200)}`);
        return resolve({ video: null, audio: null });
      }
      const streams = (metadata?.streams ?? []) as Array<{ codec_type?: string; codec_name?: string }>;
      const pick = (type: string) =>
        streams.find((s) => s.codec_type === type)?.codec_name ?? null;
      const out = { video: pick("video"), audio: pick("audio") };
      logger.debug(`[ffprobe] codecs file=${filepath} video=${out.video ?? "none"} audio=${out.audio ?? "none"}`);
      resolve(out);
    });
  });
}
