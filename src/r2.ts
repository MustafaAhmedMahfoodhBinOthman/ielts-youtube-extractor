import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { MAX_FILE_BYTES, MAX_VIDEO_FILE_BYTES, type MediaKind } from "./extract.js";
import { logger } from "./logger.js";

let client: S3Client | null = null;

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing required env ${name}`);
  return v;
}

export function getBucket(): string {
  return requiredEnv("R2_BUCKET");
}

export function getPublicBaseUrl(): string {
  return requiredEnv("R2_PUBLIC_URL").replace(/\/+$/, "");
}

export function getS3Client(): S3Client {
  if (client) return client;
  const endpoint = requiredEnv("R2_ENDPOINT");
  const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
  client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });
  return client;
}

export function publicUrlForKey(key: string): string {
  return `${getPublicBaseUrl()}/${key}`;
}

/**
 * Upload a local media file (mp3 or mp4) to R2 under predictions/{filename}.
 * Streams the file (never buffers 100MB+ in RAM — safe on medium-1x).
 * Stat-checked before upload so oversize files fail fast with 413.
 * Returns { r2Key, url }.
 */
export async function uploadToR2(
  localPath: string,
  filename: string,
  kind: MediaKind = "audio"
): Promise<{ r2Key: string; url: string }> {
  const capBytes = kind === "video" ? MAX_VIDEO_FILE_BYTES : MAX_FILE_BYTES;
  const capMb = Math.round(capBytes / 1024 / 1024);
  const st = await stat(localPath);
  logger.debug(`[r2] stat localPath=${localPath} sizeBytes=${st.size} kind=${kind}`);
  if (st.size > capBytes) {
    throw new Error(
      `${kind === "video" ? "Video" : "Audio"} is ${(st.size / 1024 / 1024).toFixed(1)}MB, exceeds ${capMb}MB limit`
    );
  }
  const bucket = getBucket();
  const key = `predictions/${path.basename(filename)}`;
  const s3 = getS3Client();
  // Stream: constant memory regardless of file size (10-300MB).
  const started = Date.now();
  logger.debug(`[r2] upload start bucket=${bucket} key=${key} sizeBytes=${st.size}`);
  const body = createReadStream(localPath);
  body.on("error", (err) => {
    logger.debug(`[r2] stream error key=${key} err=${String(err).slice(0, 200)}`);
  });
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: kind === "video" ? "video/mp4" : "audio/mpeg",
      })
    );
  } catch (err) {
    logger.debug(`[r2] upload failed key=${key} elapsedMs=${Date.now() - started} err=${String(err).slice(0, 300)}`);
    body.destroy();
    throw err;
  }
  logger.debug(`[r2] upload done key=${key} sizeBytes=${st.size} elapsedMs=${Date.now() - started}`);
  return { r2Key: key, url: publicUrlForKey(key) };
}
