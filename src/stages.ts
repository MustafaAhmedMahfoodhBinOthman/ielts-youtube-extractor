/**
 * Per-job stage tracking for live progress reporting.
 *
 * Long jobs (audio-cut, extract) update their stage as they move through
 * phases; GET /job/:id returns the current stage so callers can show
 * truthful "what is happening right now" status instead of a spinner.
 * In-memory like the jobs themselves (1h TTL handled by the caller).
 */
import { logger } from "./logger.js";

const stages = new Map<string, string>();

export function setStage(jobId: string, stage: string): void {
  stages.set(jobId, stage);
  logger.debug(`[job ${jobId}] stage=${stage}`);
}

export function getStage(jobId: string): string | undefined {
  return stages.get(jobId);
}

export function clearStage(jobId: string): void {
  stages.delete(jobId);
}
