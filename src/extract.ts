import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import ffmpeg from "fluent-ffmpeg";
import { logger } from "./logger.js";

export const MAX_DURATION_SECONDS = 3600; // 60 min
export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB
export const YTDLP_EXTRACT_TIMEOUT_MS = 240_000; // 240s

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
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    logger.debug(`[yt-dlp] spawn: ${cmd} ${args.join(" ")} timeoutMs=${timeoutMs}`);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 500_000) stdout = stdout.slice(-500_000);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 500_000) stderr = stderr.slice(-500_000);
    });
    child.on("error", (err) => {
      clearTimeout(kill);
      logger.debug(`[yt-dlp] spawn error: ${cmd} elapsedMs=${Date.now() - started} err=${String(err).slice(0, 200)}`);
      resolve({ code: 1, stdout, stderr: stderr + `\nspawn error: ${String(err)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      logger.debug(
        `[yt-dlp] exit: ${cmd} code=${code} elapsedMs=${Date.now() - started} timedOut=${timedOut} stdoutBytes=${stdout.length} stderrBytes=${stderr.length}`
      );
      resolve({ code, stdout, stderr, timedOut });
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

export async function getYtDlpMetadata(
  canonicalUrl: string,
  cookiesFile: string | null,
  timeoutMs = 60_000
): Promise<YtDlpMetadata> {
  const args = ["--dump-single-json", "--no-playlist", "--no-warnings", "--socket-timeout", "15"];
  if (cookiesFile) args.push("--cookies", cookiesFile);
  args.push(canonicalUrl);
  logger.debug(`[meta] fetch url=${canonicalUrl} cookies=${cookiesFile ? "yes(path only)" : "no"}`);
  const started = Date.now();
  const { code, stdout, stderr, timedOut } = await runCmd("yt-dlp", args, timeoutMs);
  logger.debug(`[meta] raw elapsedMs=${Date.now() - started} code=${code} timedOut=${timedOut} jsonBytes=${stdout.length}`);
  const combined = `${stdout}\n${stderr}`;
  if (timedOut) throw new TimeoutError("metadata fetch timed out");
  if (code !== 0) {
    if (isBlockedOutput(combined)) throw new BlockedError();
    throw new Error(`yt-dlp metadata failed: ${stderr.slice(-2000) || stdout.slice(-2000) || `exit ${code}`}`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("yt-dlp returned invalid JSON metadata");
  }
  const duration =
    typeof json["duration"] === "number" && Number.isFinite(json["duration"])
      ? (json["duration"] as number)
      : null;
  const meta: YtDlpMetadata = {
    title: typeof json["title"] === "string" ? (json["title"] as string) : null,
    duration,
    isLive: json["is_live"] === true,
    liveStatus: typeof json["live_status"] === "string" ? (json["live_status"] as string) : null,
    availability: typeof json["availability"] === "string" ? (json["availability"] as string) : null,
    ageLimit: typeof json["age_limit"] === "number" ? (json["age_limit"] as number) : 0,
    uploader:
      typeof json["uploader"] === "string"
        ? (json["uploader"] as string)
        : typeof json["channel"] === "string"
          ? (json["channel"] as string)
          : null,
  };
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
export async function runYtDlpExtract(
  canonicalUrl: string,
  tmpDir: string,
  cookiesFile: string | null,
  timeoutMs = YTDLP_EXTRACT_TIMEOUT_MS
): Promise<{ filepath: string; stdout: string; stderr: string }> {
  const outTemplate = `${tmpDir}/%(id)s.%(ext)s`;
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
  ];
  if (cookiesFile) args.push("--cookies", cookiesFile);
  args.push("-o", outTemplate, canonicalUrl);

  logger.debug(`[extract] start url=${canonicalUrl} tmpDir=${tmpDir} cookies=${cookiesFile ? "yes(path only)" : "no"}`);
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
