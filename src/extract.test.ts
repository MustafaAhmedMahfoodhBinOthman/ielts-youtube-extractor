import { describe, expect, it } from "vitest";
import { assertMetadataAllowed, buildExtractArgs, parseMetadataPrint } from "./extract.js";
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
    const args = buildExtractArgs("https://www.youtube.com/watch?v=x", "/tmp/yt-j/%(id)s.%(ext)s", null, "*0:00:30-0:10:00");
    for (const flag of BASE) expect(args).toContain(flag);
    const i = args.indexOf("--download-sections");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("*0:00:30-0:10:00");
    // Exact cuts: without this, yt-dlp seeks to the nearest seek point and
    // audio before start_time leaks into the mp3.
    expect(args).toContain("--force-keyframes-at-cuts");
  });

  it("omits section flags when not trimming and keeps cookies", () => {
    const args = buildExtractArgs("url", "tmpl", "/tmp/cookies.txt", null);
    expect(args).not.toContain("--download-sections");
    expect(args).not.toContain("--force-keyframes-at-cuts");
    expect(args).toContain("--cookies");
    expect(args.slice(-3)).toEqual(["-o", "tmpl", "url"]);
  });
});
