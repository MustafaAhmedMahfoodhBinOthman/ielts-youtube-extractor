/**
 * Minimal levelled logger (no deps).
 *
 * LOG_LEVEL=debug enables verbose per-stage diagnostics; default is info.
 * Invariants (enforced by convention, reviewed in code review):
 *  - NEVER log ADMIN_TOKEN, Authorization headers, R2_SECRET_ACCESS_KEY,
 *    cookie file *contents*, or full process.env. Presence only (set/missing).
 *  - Safe to log: video IDs/URLs, R2 bucket/key names, public audio URLs,
 *    timings, byte counts, exit codes, yt-dlp arg lists (cookies = path only).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase().trim();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

export const LOG_LEVEL: LogLevel = configuredLevel();

function emit(level: LogLevel, ...args: unknown[]): void {
  if (ORDER[level] < ORDER[LOG_LEVEL]) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

export const logger = {
  level: LOG_LEVEL,
  debug: (...args: unknown[]): void => emit("debug", ...args),
  info: (...args: unknown[]): void => emit("info", ...args),
  warn: (...args: unknown[]): void => emit("warn", ...args),
  error: (...args: unknown[]): void => emit("error", ...args),
};
