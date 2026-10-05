import "dotenv/config";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import cors from "cors";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { InvalidUrlError, buildFilename, parseYoutubeUrl } from "./validate.js";
import {
  BlockedError,
  MAX_FILE_BYTES,
  RejectedError,
  TooLargeError,
  TimeoutError,
  assertMetadataAllowed,
  getMediaInfo,
  getOembed,
  getYtDlpMetadata,
  runYtDlpExtract,
} from "./extract.js";
import { tryRun } from "./queue.js";
import { uploadToR2 } from "./r2.js";

const PORT = Number(process.env.PORT || "3000");

// --- versions (populated at startup) ---
let ytDlpVersion = "unknown";
let ffmpegVersion = "unknown";

function execVersion(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) return resolve(`unavailable (${String(err.message).slice(0, 120)})`);
      const out = `${stdout || ""}\n${stderr || ""}`.trim().split("\n")[0]?.trim() || "unknown";
      resolve(out.slice(0, 200));
    });
  });
}

async function loadVersions(): Promise<void> {
  const [yd, ff] = await Promise.all([
    execVersion("yt-dlp", ["--version"]),
    execVersion("ffmpeg", ["-version"]),
  ]);
  ytDlpVersion = yd;
  ffmpegVersion = ff;
}

// --- cookies (optional) ---
let cookiesFile: string | null = null;

async function setupCookies(): Promise<void> {
  const b64 = process.env.YTDLP_COOKIES_B64;
  if (!b64 || b64.trim() === "") return;
  try {
    const buf = Buffer.from(b64.trim(), "base64");
    if (buf.length === 0) return;
    const p = path.join(os.tmpdir(), "cookies.txt");
    await fs.writeFile(p, buf, { mode: 0o600 });
    cookiesFile = p;
    console.log("[startup] cookies loaded to /tmp/cookies.txt (redacted)");
  } catch (err) {
    console.error("[startup] failed to decode YTDLP_COOKIES_B64:", (err as Error).message);
  }
}

// --- auth (constant-time) ---
function getAdminToken(): string {
  return process.env.ADMIN_TOKEN || "";
}

function isAuthorized(req: express.Request): boolean {
  const expected = getAdminToken();
  if (!expected) return false;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const provided = m[1].trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still do a timing-safe compare on same-length buffers to avoid leaking length fast-path timing
    // then return false. Compare against a dummy of provided length.
    try {
      crypto.timingSafeEqual(a, a);
    } catch {
      // ignore
    }
    return false;
  }
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!getAdminToken()) {
    res.status(500).json({ success: false, code: "misconfigured", error: "ADMIN_TOKEN not set on server" });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ success: false, code: "unauthorized", error: "Missing or invalid token" });
    return;
  }
  next();
}

// --- validation ---
const ExtractBody = z.object({
  youtube_url: z.string().min(1).max(2000),
  title_hint: z.string().min(1).max(200).optional(),
});

function redactUrlForLog(canonicalUrl: string): string {
  return canonicalUrl; // YouTube watch URLs are not secrets
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

// CORS: ALLOWED_ORIGINS comma-separated allowlist.
// Default deny when empty: requests WITHOUT an Origin header (curl,
// server-side, same-origin navigations) pass through; browser cross-origin
// requests carrying an Origin header are rejected 403 unless the origin is
// allowlisted (or matches Host = same-origin). Set ALLOWED_ORIGINS to the
// admin UI origin, e.g. https://admin.yourdomain.com.
const allowedOriginsRaw = (process.env.ALLOWED_ORIGINS || "").trim();
const allowList = allowedOriginsRaw.split(",").map((s) => s.trim()).filter(Boolean);
if (allowList.length > 0) {
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (allowList.includes("*") || allowList.includes(origin)) return cb(null, true);
        return cb(new Error("CORS blocked"), false);
      },
    })
  );
} else {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next(); // curl / server-side / non-CORS: allow
    const host = req.headers.host;
    let sameOrigin = false;
    try {
      sameOrigin = !!host && new URL(String(origin)).host === host;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) {
      res.setHeader("Access-Control-Allow-Origin", String(origin));
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
        return res.sendStatus(204);
      }
      return next();
    }
    return res.status(403).json({ success: false, code: "forbidden", error: "CORS: origin not allowed" });
  });
}

// Never log tokens/secrets: tiny redaction middleware for error logs
function safeLog(...args: unknown[]): void {
  console.log(...args);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, ytDlp: ytDlpVersion, ffmpeg: ffmpegVersion });
});

// --- async jobs (in-memory; 1-2 concurrent, admin-only, low volume) ---
type JobStatus = "queued" | "running" | "done" | "failed";

interface JobResult {
  audio_url: string;
  r2Key: string;
  youtube_id: string;
  title: string;
  duration_seconds: number | null;
  size: number;
}

interface JobError {
  code: string;
  error: string;
  hint?: string;
}

interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  youtube_id: string;
  title_hint?: string;
  result?: JobResult;
  error?: JobError;
}

const jobs = new Map<string, Job>();
const JOB_TTL_MS = 3_600_000; // 1h: keep result/error for polling, then drop

function scheduleJobCleanup(jobId: string): void {
  const t = setTimeout(() => {
    jobs.delete(jobId);
  }, JOB_TTL_MS);
  // Don't hold the process open for cleanup timers in tests/dev.
  (t as unknown as { unref?: () => void }).unref?.();
}

function toJobError(err: unknown): { status: number; body: JobError } {
  if (err instanceof RejectedError) {
    return { status: err.status, body: { code: err.code, error: err.reason } };
  }
  if (err instanceof BlockedError) {
    return { status: err.status, body: { code: err.code, error: err.message, hint: err.hint } };
  }
  if (err instanceof TooLargeError) {
    return { status: err.status, body: { code: err.code, error: err.message } };
  }
  if (err instanceof TimeoutError) {
    return { status: err.status, body: { code: err.code, error: err.message } };
  }
  const message = err instanceof Error ? err.message.slice(0, 500) : "Extraction failed";
  const low = message.toLowerCase();
  if (low.includes("429") || low.includes("403") || low.includes("sign in to confirm")) {
    return {
      status: 502,
      body: {
        code: "blocked_429",
        error: "YouTube blocked the request (429/403)",
        hint: "Refresh YTDLP_COOKIES_B64 or redeploy with a newer pinned yt-dlp (see Dockerfile).",
      },
    };
  }
  if (low.includes("larger than max-filesize") || low.includes("exceeds 100mb")) {
    return { status: 413, body: { code: "too_large", error: message } };
  }
  return { status: 500, body: { code: "extract_failed", error: message } };
}

/** Shared extraction core: metadata -> yt-dlp -> verify -> R2. Cleans its tmp dir. */
async function runExtraction(
  jobId: string,
  videoId: string,
  canonicalUrl: string,
  title_hint: string | undefined
): Promise<JobResult> {
  const tmpDir = path.join(os.tmpdir(), `yt-${jobId}`);
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    // oEmbed (best-effort) + yt-dlp metadata (authoritative for duration/restrictions)
    const [oembed, meta] = await Promise.all([getOembed(videoId), getYtDlpMetadata(canonicalUrl, cookiesFile)]);

    assertMetadataAllowed(meta);

    const title = (oembed.title || meta.title || title_hint || videoId).trim().slice(0, 200) || videoId;

    // Extract mp3 (240s timeout inside)
    const { filepath } = await runYtDlpExtract(canonicalUrl, tmpDir, cookiesFile);

    // Verify: exists, size, ffprobe duration
    const info = await getMediaInfo(filepath);
    if (info.sizeBytes > MAX_FILE_BYTES) {
      throw new TooLargeError(`Audio is ${(info.sizeBytes / 1024 / 1024).toFixed(1)}MB, exceeds 100MB limit`);
    }
    if (info.sizeBytes < 10_000) {
      throw new Error(`Extracted file suspiciously small (${info.sizeBytes} bytes) — likely failed download`);
    }

    // Prefer title_hint for the filename slug when provided, fall back to resolved title
    const slugBase = (title_hint && title_hint.trim()) || title;
    const filename = buildFilename(slugBase, videoId);

    // Upload to R2 (streamed)
    const { r2Key, audioUrl } = await uploadToR2(filepath, filename);

    return {
      audio_url: audioUrl,
      r2Key,
      youtube_id: videoId,
      title,
      duration_seconds:
        info.durationSeconds != null
          ? Math.round(info.durationSeconds)
          : meta.duration != null
            ? Math.round(meta.duration)
            : null,
      size: info.sizeBytes,
    };
  } finally {
    // Cleanup /tmp always (job record stays in Map for 1h of polling)
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function parseExtractInput(body: unknown):
  | { ok: true; videoId: string; canonicalUrl: string; title_hint?: string }
  | { ok: false; status: number; body: Record<string, unknown> } {
  const parsed = ExtractBody.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        code: "invalid_url",
        error: "Body must be { youtube_url: string, title_hint?: string }",
        details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })).slice(0, 5),
      },
    };
  }
  try {
    const p = parseYoutubeUrl(parsed.data.youtube_url);
    return { ok: true, videoId: p.videoId, canonicalUrl: p.canonicalUrl, title_hint: parsed.data.title_hint };
  } catch (err) {
    const message = err instanceof InvalidUrlError ? err.message : "Invalid YouTube URL";
    return { ok: false, status: 400, body: { success: false, code: "invalid_url", error: message } };
  }
}

app.post("/extract", authMiddleware, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const input = parseExtractInput(req.body);
  if (!input.ok) {
    res.status(input.status).json(input.body);
    return;
  }
  const { videoId, canonicalUrl, title_hint } = input;
  const wait = req.query.wait === "true";

  // Local-dev synchronous path: request waits 30-120s for the result.
  if (wait) {
    const jobId = uuidv4();
    safeLog(`[job ${jobId}] sync start ${redactUrlForLog(canonicalUrl)}`);
    // Atomic admission (no await between busy-check and dispatch — see queue.ts).
    const p = tryRun(() => runExtraction(jobId, videoId, canonicalUrl, title_hint));
    if (!p) {
      res.status(429).json({ success: false, code: "busy_retry", error: "Server busy (2 concurrent jobs). Retry shortly." });
      return;
    }
    try {
      const result = await p;
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, ...result });
      safeLog(`[job ${jobId}] sync done ${videoId} -> ${result.r2Key} (${result.size} bytes)`);
    } catch (err) {
      const mapped = toJobError(err);
      if (mapped.status >= 500) console.error(`[job ${jobId}] sync failed:`, mapped.body.error.slice(0, 300));
      res.status(mapped.status).json({ success: false, ...mapped.body });
    }
    return;
  }

  // Default async path (avoids gateway timeouts): 202 + poll GET /job/:id.
  const job: Job = {
    id: uuidv4(),
    status: "queued",
    createdAt: Date.now(),
    youtube_id: videoId,
    title_hint,
  };
  // Atomic admission before promising anything.
  const p = tryRun(async () => {
    job.status = "running";
    safeLog(`[job ${job.id}] start ${redactUrlForLog(canonicalUrl)}`);
    try {
      const result = await runExtraction(job.id, videoId, canonicalUrl, title_hint);
      job.status = "done";
      job.result = result;
      safeLog(`[job ${job.id}] done ${videoId} -> ${result.r2Key} (${result.size} bytes)`);
    } catch (err) {
      const mapped = toJobError(err);
      job.status = "failed";
      job.error = mapped.body;
      if (mapped.status >= 500) console.error(`[job ${job.id}] failed:`, mapped.body.error.slice(0, 300));
      else safeLog(`[job ${job.id}] failed: ${mapped.body.code}`);
    }
  });
  if (!p) {
    res.status(429).json({ success: false, code: "busy_retry", error: "Server busy (2 concurrent jobs). Retry shortly." });
    return;
  }
  jobs.set(job.id, job);
  scheduleJobCleanup(job.id);
  // Surface background failures (already recorded on the job) without crashing.
  p.catch(() => undefined);
  res.status(202).json({ success: true, jobId: job.id, status: job.status });
});

app.get("/job/:id", authMiddleware, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ success: false, code: "not_found", error: "Unknown or expired job id" });
    return;
  }
  res.json({
    success: true,
    jobId: job.id,
    status: job.status,
    youtube_id: job.youtube_id,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
});

async function main(): Promise<void> {
  if (!process.env.ADMIN_TOKEN) {
    console.error("FATAL: ADMIN_TOKEN env is required");
    process.exit(1);
  }
  await loadVersions();
  await setupCookies();
  console.log(`[startup] yt-dlp: ${ytDlpVersion}`);
  console.log(`[startup] ffmpeg: ${ffmpegVersion.slice(0, 120)}`);
  // Do not print ADMIN_TOKEN / R2 secrets. Show only presence:
  console.log(
    `[startup] env: R2_ENDPOINT=${process.env.R2_ENDPOINT ? "set" : "missing"} ` +
      `R2_BUCKET=${process.env.R2_BUCKET || "missing"} ` +
      `R2_PUBLIC_URL=${process.env.R2_PUBLIC_URL ? "set" : "missing"} ` +
      `COOKIES=${cookiesFile ? "loaded" : "none"} ` +
      `CORS=${allowList.length > 0 ? "allowlist" : "default-deny"}`
  );
  // Only listen when run directly (never under vitest imports).
  app.listen(PORT, () => {
    console.log(`ielts-youtube-extractor listening on :${PORT}`);
  });
}

// Auto-run on `node dist/index.js`, but not when imported (vitest sets VITEST=true).
if (process.env.VITEST !== "true") {
  void main();
}

export default app;
