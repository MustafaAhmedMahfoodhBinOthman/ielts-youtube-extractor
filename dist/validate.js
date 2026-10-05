"use strict";
/**
 * YouTube URL parsing + filename sanitization.
 * No secrets, no network — pure functions, easy to unit test.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidUrlError = void 0;
exports.parseYoutubeUrl = parseYoutubeUrl;
exports.sanitizeSlug = sanitizeSlug;
exports.buildFilename = buildFilename;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
class InvalidUrlError extends Error {
    code = "invalid_url";
    constructor(message = "URL must be a youtube.com/watch, /shorts, /embed or youtu.be link with an 11-char video ID") {
        super(message);
        this.name = "InvalidUrlError";
    }
}
exports.InvalidUrlError = InvalidUrlError;
/**
 * Parse + validate a user-supplied YouTube URL.
 * Returns the 11-char video ID and a canonical watch URL.
 *
 * Accepted:
 *  - https://www.youtube.com/watch?v=VIDEOID
 *  - https://youtube.com/watch?v=VIDEOID&...
 *  - https://m.youtube.com/watch?v=VIDEOID
 *  - https://www.youtube.com/shorts/VIDEOID
 *  - https://www.youtube.com/embed/VIDEOID
 *  - https://youtu.be/VIDEOID
 */
function parseYoutubeUrl(raw) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new InvalidUrlError("youtube_url is required");
    }
    let u;
    try {
        u = new URL(raw.trim());
    }
    catch {
        throw new InvalidUrlError();
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new InvalidUrlError();
    }
    const host = u.hostname.toLowerCase();
    const isYoutubeHost = host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com");
    const isShortHost = host === "youtu.be" || host.endsWith(".youtu.be");
    if (!isYoutubeHost && !isShortHost) {
        throw new InvalidUrlError();
    }
    let videoId = null;
    if (isShortHost) {
        // https://youtu.be/VIDEOID?t=123
        const seg = u.pathname.split("/").filter(Boolean)[0];
        if (seg && VIDEO_ID_RE.test(seg))
            videoId = seg;
    }
    else {
        const path = u.pathname;
        if (path === "/watch") {
            const v = u.searchParams.get("v");
            if (v && VIDEO_ID_RE.test(v))
                videoId = v;
        }
        else if (path.startsWith("/shorts/")) {
            const seg = path.split("/")[2];
            if (seg && VIDEO_ID_RE.test(seg))
                videoId = seg;
        }
        else if (path.startsWith("/embed/")) {
            const seg = path.split("/")[2];
            if (seg && VIDEO_ID_RE.test(seg))
                videoId = seg;
        }
    }
    if (!videoId) {
        throw new InvalidUrlError();
    }
    return {
        videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
}
/**
 * Lowercase, [^a-z0-9]+ -> "-", trim dashes, max 80 chars.
 * Falls back to "audio" for empty input.
 */
function sanitizeSlug(input) {
    const s = (input || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80)
        .replace(/-$/g, "");
    return s || "audio";
}
/**
 * {sanitized-title-or-title_hint}-{youtube_id}-{Date.now()}.mp3
 */
function buildFilename(baseTitle, youtubeId, now = Date.now()) {
    const slug = sanitizeSlug(baseTitle).slice(0, 80) || "audio";
    return `${slug}-${youtubeId}-${now}.mp3`;
}
