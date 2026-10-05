import { describe, expect, it } from "vitest";
import {
  assertMetadataAllowed,
  buildExtractArgs,
  buildVideoExtractArgs,
  parseMetadataPrint,
} from "./extract.js";
import { RejectedError } from "./extract.js";

const NORMAL = [
  "IELTS Listening Part 4 - Lecture",
  "1823",
  "False",
  "NA",
  "public",
  "0",
  "IELTS Channel",
  "IELTS Channel",
].join("\n") + "\n";

describe("parseMetadataPrint", () => {
  it("parses a normal video", () => {
    const m = parseMetadataPrint(NORMAL, "");
    expect(m).toEqual({
      title: "IELTS Listening Part 4 - Lecture",
      duration: 1823,
      isLive: false,
      liveStatus: null,
      availability: "public",
      ageLimit: 0,
      uploader: "IELTS Channel",
    });
    expect(() => assertMetadataAllowed(m)).not.toThrow();
  });

  it("maps NA variants", () => {
    const m = parseMetadataPrint(["NA", "NA", "False", "NA", "NA", "NA", "NA", "NA"].join("\n") + "\n", "");
    expect(m.title).toBeNull();
    expect(m.duration).toBeNull();
    expect(m.isLive).toBe(false);
    expect(m.liveStatus).toBeNull();
    expect(m.availability).toBeNull();
    expect(m.ageLimit).toBe(0);
    expect(m.uploader).toBeNull();
  });

  it("parses live + age-restricted + channel fallback", () => {
    const m = parseMetadataPrint(
      ["Premiere", "3600", "True", "is_upcoming", "public", "18", "NA", "Some Channel"].join("\n") + "\n",
      ""
    );
    expect(m.isLive).toBe(true);
    expect(m.ageLimit).toBe(18);
    expect(m.uploader).toBe("Some Channel"); // uploader-or-channel fallback
    expect(() => assertMetadataAllowed(m)).toThrow(RejectedError);
  });

  it("folds extra newlines into the title", () => {
    const m = parseMetadataPrint("Line one\nLine two\n90\nFalse\nNA\npublic\n0\nUp\nCh\n", "");
    expect(m.title).toBe("Line one\nLine two");
    expect(m.duration).toBe(90);
    expect(m.uploader).toBe("Up");
  });

  it("throws a detailed error on short output", () => {
    expect(() => parseMetadataPrint("oops\n", "some stderr")).toThrow(/expected 8/);
    try {
      parseMetadataPrint("oops\n", "some stderr");
    } catch (err) {
      expect((err as Error).message).toMatch(/stdout 5 bytes/);
      expect((err as Error).message).toMatch(/some stderr/);
    }
  });

  it("treats non-numeric duration/age as missing", () => {
    const m = parseMetadataPrint(["T", "abc", "False", "NA", "public", "xyz", "U", "C"].join("\n") + "\n", "");
    expect(m.duration).toBeNull();
    expect(m.ageLimit).toBe(0);
  });
});

describe("buildExtractArgs", () => {
  const BASE = ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "128K"];

  it("adds accurate section-cut flags when trimming", () => {
    const args = buildExtractArgs(
      "https://www.youtube.com/watch?v=x",
      "/tmp/yt-j/%(id)s.%(ext)s",
      null,
      "*0:00:30-0:10:00"
    );
    for (const flag of BASE) expect(args).toContain(flag);
    const i = args.indexOf("--download-sections");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("*0:00:30-0:10:00");
    // Sections REQUIRE the ffmpeg downloader: yt-dlp aborts with "This
    // format cannot be partially downloaded" when a section is requested
    // from the native http downloader (https has no PROTOCOL_MAP entry).
    expect(args[args.indexOf("--downloader") + 1]).toBe("ffmpeg");
    // Exact cuts: only honored by that downloader, which then drops
    // `-c copy` so ffmpeg re-encodes around the boundaries.
    expect(args).toContain("--force-keyframes-at-cuts");
  });

  it("omits section flags when not trimming and keeps cookies", () => {
    const args = buildExtractArgs("url", "tmpl", "/tmp/cookies.txt", null);
    expect(args).not.toContain("--download-sections");
    expect(args).not.toContain("--force-keyframes-at-cuts");
    // Do not slow the common full-audio path down with the ffmpeg downloader.
    expect(args).not.toContain("--downloader");
    expect(args).toContain("--cookies");
    expect(args.slice(-3)).toEqual(["-o", "tmpl", "url"]);
  });
});

describe("buildVideoExtractArgs", () => {
  it("requests a 480p H.264/AAC pair merged to mp4 by default", () => {
    const args = buildVideoExtractArgs("url", "tmpl", null);
    const fmt = args[args.indexOf("-f") + 1];
    // Every fallback branch is height-capped: an unbounded `best` branch would
    // silently pull 4K and blow up the model's token bill.
    expect(fmt).toContain("height<=480");
    for (const branch of fmt.split("/")) expect(branch).toContain("height<=480");
    // Regression: `[ext=mp4]` alone does NOT pin the codec. It constrains the
    // container, so yt-dlp falls through to YouTube's VP9/AV1 default — which
    // several cheap video models reject. Verified on a real 480p pull.
    for (const branch of fmt.split("/")) expect(branch).toContain("vcodec^=avc1");
    expect(fmt).toContain("acodec^=mp4a");
    expect(fmt).not.toContain("[ext=mp4]");
    expect(args[args.indexOf("--merge-output-format") + 1]).toBe("mp4");
    // mp3 extraction flags must NOT leak into the video path.
    expect(args).not.toContain("-x");
    expect(args).not.toContain("--audio-format");
    expect(args[args.indexOf("--max-filesize") + 1]).toBe("300M");
    expect(args.slice(-3)).toEqual(["-o", "tmpl", "url"]);
  });

  it("honours a custom max height", () => {
    const args = buildVideoExtractArgs("url", "tmpl", null, 1080);
    expect(args[args.indexOf("-f") + 1]).toContain("height<=1080");
  });

  it("never requests sections (video is always full length)", () => {
    const args = buildVideoExtractArgs("url", "tmpl", "/tmp/cookies.txt", 720);
    expect(args).not.toContain("--download-sections");
    expect(args).not.toContain("--force-keyframes-at-cuts");
    // Also must not force the ffmpeg downloader for the full-length path.
    expect(args).not.toContain("--downloader");
    expect(args).toContain("--cookies");
  });
});
