/**
 * Audio trim range parsing/formatting (pure functions).
 * Accepts seconds (number or numeric string) or mm:ss / hh:mm:ss strings.
 * No secrets, no network — unit tested in range.test.ts.
 */
import { logger } from "./logger.js";

export class InvalidRangeError extends Error {
  code = "invalid_range" as const;
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidRangeError";
  }
}

export interface ParsedRange {
  startSeconds: number;
  endSeconds: number | null;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

export function parseTimeValue(v: unknown, name: "start_time" | "end_time"): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new InvalidRangeError(`${name} must be a finite number of seconds or mm:ss / hh:mm:ss`);
    if (v < 0) throw new InvalidRangeError(`${name} must not be negative (got ${v})`);
    return v;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") throw new InvalidRangeError(`${name} must not be empty`);
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t); // non-negative by regex
    const parts = t.split(":");
    if (parts.length === 2 || parts.length === 3) {
      const nums = parts.map((p) => (p.trim() === "" ? NaN : Number(p)));
      if (nums.every((n) => Number.isFinite(n) && n >= 0)) {
        const total = parts.length === 2 ? nums[0] * 60 + nums[1] : nums[0] * 3600 + nums[1] * 60 + nums[2];
        if (Number.isFinite(total)) return total;
      }
    }
    throw new InvalidRangeError(`${name} ${JSON.stringify(v)} is not a valid time (seconds or mm:ss / hh:mm:ss)`);
  }
  throw new InvalidRangeError(`${name} must be seconds or mm:ss / hh:mm:ss`);
}

/** Normalize optional raw inputs. Defaults: start 0, end omitted (full audio). */
export function parseTimeRange(start: unknown, end: unknown): ParsedRange {
  const s = start === undefined ? 0 : parseTimeValue(start, "start_time");
  const e = end === undefined ? null : parseTimeValue(end, "end_time");
  logger.debug(`[range] parsed startSeconds=${s} endSeconds=${e}`);
  if (e !== null && e <= s) {
    throw new InvalidRangeError(`end_time (${fmt(e)}s) must be greater than start_time (${fmt(s)}s)`);
  }
  return { startSeconds: s, endSeconds: e };
}

/** Duration upper-bound check once metadata duration is known. */
export function assertRangeWithinDuration(range: ParsedRange, duration: number | null, videoId: string): void {
  if (duration == null) {
    logger.debug(`[range] skip duration check videoId=${videoId} (duration unknown)`);
    return;
  }
  if (range.endSeconds !== null && range.endSeconds > duration) {
    throw new InvalidRangeError(`end_time ${fmt(range.endSeconds)}s exceeds video duration ${fmt(duration)}s`);
  }
  if (range.startSeconds >= duration) {
    throw new InvalidRangeError(
      `start_time ${fmt(range.startSeconds)}s is at or beyond video duration ${fmt(duration)}s`
    );
  }
  logger.debug(`[range] within duration videoId=${videoId} duration=${fmt(duration)}`);
}

/** Format float seconds as H:MM:SS for `yt-dlp --download-sections`. */
export function formatYtDlpTimestamp(sec: number): string {
  const total = Math.round(sec * 1000) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  const mStr = String(m).padStart(2, "0");
  let sStr: string;
  if (Number.isInteger(s)) {
    sStr = String(s).padStart(2, "0");
  } else {
    const fixed = s.toFixed(3);
    const dot = fixed.indexOf(".");
    sStr = `${fixed.slice(0, dot).padStart(2, "0")}.${fixed.slice(dot + 1).replace(/0+$/, "")}`;
  }
  return `${h}:${mStr}:${sStr}`;
}

/** Build the `--download-sections` value, or null when not trimming. */
export function buildSectionArg(range: ParsedRange): string | null {
  const trimming = range.startSeconds > 0 || range.endSeconds !== null;
  if (!trimming) return null;
  const end = range.endSeconds !== null ? formatYtDlpTimestamp(range.endSeconds) : "inf";
  return `*${formatYtDlpTimestamp(range.startSeconds)}-${end}`;
}
