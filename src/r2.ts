import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { MAX_FILE_BYTES } from "./extract.js";

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
 * Upload a local mp3 to R2 under predictions/{filename}.
 * Streams the file (never buffers 100MB in RAM — safe on medium-1x).
 * Stat-checked before upload so oversize files fail fast with 413.
 * Returns { r2Key, audioUrl }.
 */
export async function uploadToR2(
  localPath: string,
  filename: string
): Promise<{ r2Key: string; audioUrl: string }> {
  const st = await stat(localPath);
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(`Audio is ${(st.size / 1024 / 1024).toFixed(1)}MB, exceeds 100MB limit`);
  }
  const bucket = getBucket();
  const key = `predictions/${path.basename(filename)}`;
  const s3 = getS3Client();
  // Stream: constant memory regardless of file size (10-100MB).
  const body = createReadStream(localPath);
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "audio/mpeg",
      })
    );
  } catch (err) {
    body.destroy();
    throw err;
  }
  return { r2Key: key, audioUrl: publicUrlForKey(key) };
}
