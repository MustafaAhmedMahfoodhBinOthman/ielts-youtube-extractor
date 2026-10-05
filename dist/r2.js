"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBucket = getBucket;
exports.getPublicBaseUrl = getPublicBaseUrl;
exports.getS3Client = getS3Client;
exports.publicUrlForKey = publicUrlForKey;
exports.uploadToR2 = uploadToR2;
const client_s3_1 = require("@aws-sdk/client-s3");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const extract_js_1 = require("./extract.js");
let client = null;
function requiredEnv(name) {
    const v = process.env[name];
    if (!v || v.trim() === "")
        throw new Error(`Missing required env ${name}`);
    return v;
}
function getBucket() {
    return requiredEnv("R2_BUCKET");
}
function getPublicBaseUrl() {
    return requiredEnv("R2_PUBLIC_URL").replace(/\/+$/, "");
}
function getS3Client() {
    if (client)
        return client;
    const endpoint = requiredEnv("R2_ENDPOINT");
    const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
    client = new client_s3_1.S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: false,
    });
    return client;
}
function publicUrlForKey(key) {
    return `${getPublicBaseUrl()}/${key}`;
}
/**
 * Upload a local mp3 to R2 under predictions/{filename}.
 * Streams the file (never buffers 100MB in RAM — safe on medium-1x).
 * Stat-checked before upload so oversize files fail fast with 413.
 * Returns { r2Key, audioUrl }.
 */
async function uploadToR2(localPath, filename) {
    const st = await (0, promises_1.stat)(localPath);
    if (st.size > extract_js_1.MAX_FILE_BYTES) {
        throw new Error(`Audio is ${(st.size / 1024 / 1024).toFixed(1)}MB, exceeds 100MB limit`);
    }
    const bucket = getBucket();
    const key = `predictions/${node_path_1.default.basename(filename)}`;
    const s3 = getS3Client();
    // Stream: constant memory regardless of file size (10-100MB).
    const body = (0, node_fs_1.createReadStream)(localPath);
    try {
        await s3.send(new client_s3_1.PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: "audio/mpeg",
        }));
    }
    catch (err) {
        body.destroy();
        throw err;
    }
    return { r2Key: key, audioUrl: publicUrlForKey(key) };
}
