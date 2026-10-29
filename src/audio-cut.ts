/**
 * Generic audio cutter for OneIELTS (and any hosted mp3).
 *
 * Separate from the YouTube path (`/extract`): the caller already knows the
 * source file URL (e.g. a OneIELTS CDN mp3 or an R2-proxied copy) and the
 * desired range, and just wants `{ range } -> R2 mp3 -> public URL`.
 *
 * Detection (Deepgram transcription + LLM range inference) intentionally
 * lives in the web app, not here: the app already holds the LLM clients,
 * the extracted question JSON, and the Deepgram key. This service stays a
 * stateless cutter (download -> ffmpeg -ss/-to -> R2), which keeps Cranl
 * env unchanged (no new API keys) and makes manual-range cutting testable
 * before auto-detection lands.
 */
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import ffmpeg from "fluent-ffmpeg";
import { logger } from "./logger.js";
import { sanitizeSlug } from "./validate.js";

export const AUDIO_CUT_MAX_BYTES = 100 * 1024 * 1024; // 100MB, same as yt-dlp audio cap
export const AUDIO_CUT_DOWNLOAD_TIMEOUT_MS = 120_000; // 120s to fetch the source file
export const AUDIO_CUT_FFMPEG_TIMEOUT_MS = 180_000; // 180s to cut + re-encode

export class InvalidAudioUrlError extends Error {
  code = "invalid_url" as const;
  status = 400;
  constructor(message = "audio_url must be an http(s) URL to a publicly reachable audio file") {
    super(message);
    this.name = "InvalidAudioUrlError";
  }
}

/** Lexical private/loopback check (fast reject before DNS). */
function looksPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "metadata.google.internal") return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  return false;
}

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  if (ip.startsWith("127.") || ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // IPv6 unique-local / link-local
  const low = ip.toLowerCase();
  if (low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80")) return true;
  return false;
}

/**
 * Validate a caller-supplied audio URL. Async because it resolves DNS to
 * block SSRF to private/link-local targets (TOCTOU accepted for a v1
 * admin-only tool; the lexical check runs first so hostile names fail fast).
 */
export async function validateAudioUrl(raw: string): Promise<URL> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new InvalidAudioUrlError("audio_url is required");
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new InvalidAudioUrlError();
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new InvalidAudioUrlError("audio_url must be http(s)");
  }
  if (u.username || u.password) {
    throw new InvalidAudioUrlError("audio_url must not contain credentials");
  }
  if (looksPrivateHostname(u.hostname)) {
    throw new InvalidAudioUrlError("audio_url must not target a private host");
  }
  try {
    const addrs = await lookup(u.hostname, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) {
      throw new InvalidAudioUrlError("audio_url must not resolve to a private address");
    }
  } catch (err) {
    if (err instanceof InvalidAudioUrlError) throw err;
    // DNS failure = unreachable; surface as invalid_url, not a 500.
    throw new InvalidAudioUrlError(`audio_url host does not resolve (${u.hostname})`);
  }
  logger.debug(`[audio-cut] url ok host=${u.hostname} path=${u.pathname.slice(0, 80)}`);
  return u;
}

export interface DownloadedAudio {
  filepath: string;
  contentType: string | null;
  sizeBytes: number;
}

/** Stream-download with a hard byte cap; aborts and cleans up on oversize. */
export async function downloadAudioToFile(
  audioUrl: string,
  tmpDir: string,
  timeoutMs = AUDIO_CUT_DOWNLOAD_TIMEOUT_MS,
  maxBytes = AUDIO_CUT_MAX_BYTES
): Promise<DownloadedAudio> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(audioUrl, { signal: ctrl.signal, redirect: "follow" });
  } catch (err) {
    clearTimeout(t);
    if ((err as Error).name === "AbortError") {
      throw new Error(`audio download timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`audio download failed: ${String(err).slice(0, 200)}`);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok || !res.body) {
    throw new Error(`audio download failed (HTTP ${res.status})`);
  }
  const contentType = res.headers.get("content-type");
  // Fail fast on an obviously wrong content type, but stay permissive:
  // some CDNs serve mp3 as application/octet-stream or omit the header.
  if (contentType && !/audio|video|mpeg|mp3|octet-stream|binary/i.test(contentType)) {
    throw new Error(`audio_url content-type looks wrong (${contentType}) — expected an audio file`);
  }
  const filename = `source-${Date.now()}.bin`;
  const filepath = path.join(tmpDir, filename);
  const fileStream = createWriteStream(filepath);
  let bytes = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      body.destroy(new Error(`Audio is ${(bytes / 1024 / 1024).toFixed(1)}MB, exceeds ${Math.round(maxBytes / 1024 / 1024)}MB limit`));
    }
  });
  try {
    await pipeline(body, fileStream);
  } catch (err) {
    await fs.rm(filepath, { force: true }).catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("exceeds")) {
      const e = new Error(msg) as Error & { status?: number; code?: string };
      e.status = 413;
      e.code = "too_large";
      throw e;
    }
    throw new Error(`audio download failed: ${msg.slice(0, 200)}`);
  }
  const st = await fs.stat(filepath);
  if (st.size < 10_000) {
    await fs.rm(filepath, { force: true }).catch(() => undefined);
    throw new Error(`downloaded audio suspiciously small (${st.size} bytes) — likely not an audio file`);
  }
  logger.debug(`[audio-cut] downloaded file=${filepath} sizeBytes=${st.size} contentType=${contentType ?? "none"}`);
  return { filepath, contentType, sizeBytes: st.size };
}

/**
 * Exact cut via re-encode (libmp3lame 128k, same as the YouTube audio path).
 * -ss after -i (output seeking) is sample-accurate; stream-copy (-c copy)
 * would snap to MP3 frame boundaries and drift the range.
 */
export function cutMp3(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  endSeconds: number | null,
  timeoutMs = AUDIO_CUT_FFMPEG_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let cmd = ffmpeg(inputPath).setStartTime(startSeconds).audioCodec("libmp3lame").audioBitrate("128k");
    if (endSeconds !== null) {
      cmd = cmd.setDuration(Math.max(0, endSeconds - startSeconds));
    }
    const kill = setTimeout(() => {
      reject(new Error(`audio cut timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    cmd
      .output(outputPath)
      .on("end", () => {
        clearTimeout(kill);
        logger.debug(`[audio-cut] ffmpeg done elapsedMs=${Date.now() - started} out=${outputPath}`);
        resolve();
      })
      .on("error", (err: Error) => {
        clearTimeout(kill);
        logger.debug(`[audio-cut] ffmpeg error err=${String(err).slice(0, 300)}`);
        reject(new Error(`audio cut failed: ${String(err.message || err).slice(0, 300)}`));
      })
      .run();
  });
}

/** practice/oneielts-style filename: {slug}-onecut-{now}.mp3 */
export function buildAudioCutFilename(baseTitle: string, now = Date.now()): string {
  const slug = sanitizeSlug(baseTitle).slice(0, 80) || "audio";
  return `${slug}-onecut-${now}.mp3`;
}

/** Full-file proxy filename (no cut): {slug}-full-{now}.mp3 */
export function buildAudioProxyFilename(baseTitle: string, now = Date.now()): string {
  const slug = sanitizeSlug(baseTitle).slice(0, 80) || "audio";
  return `${slug}-full-${now}.mp3`;
}
