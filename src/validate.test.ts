import { describe, expect, it } from "vitest";
import { InvalidUrlError, buildFilename, parseYoutubeUrl, sanitizeSlug } from "./validate.js";

describe("parseYoutubeUrl", () => {
  it("parses /watch URLs", () => {
    const r = parseYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(r.videoId).toBe("dQw4w9WgXcQ");
    expect(r.canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("ignores extra /watch params", () => {
    const r = parseYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=xyz");
    expect(r.videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses /shorts URLs", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ").videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses /embed URLs", () => {
    expect(parseYoutubeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ").videoId).toBe("dQw4w9WgXcQ");
  });

  it("parses youtu.be short links (ignores timestamp)", () => {
    expect(parseYoutubeUrl("https://youtu.be/dQw4w9WgXcQ?t=123").videoId).toBe("dQw4w9WgXcQ");
  });

  it.each([
    "https://example.com/not-youtube",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/playlist?list=xyz",
    "https://www.youtube.com/channel/UC123",
    "not-a-url",
    "",
  ])("rejects %s with invalid_url", (bad) => {
    expect(() => parseYoutubeUrl(bad)).toThrow(InvalidUrlError);
    try {
      parseYoutubeUrl(bad);
    } catch (err) {
      expect((err as InvalidUrlError).code).toBe("invalid_url");
    }
  });
});

describe("sanitizeSlug", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(sanitizeSlug("IELTS Listening Test #1: Foo/Bar!")).toBe("ielts-listening-test-1-foo-bar");
  });

  it("caps at 80 chars without trailing dash", () => {
    const s = sanitizeSlug("a".repeat(200));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).not.toMatch(/-$/);
  });

  it("falls back to audio", () => {
    expect(sanitizeSlug("")).toBe("audio");
    expect(sanitizeSlug("!!!")).toBe("audio");
  });
});

describe("buildFilename", () => {
  it("builds slug-id-timestamp.mp3", () => {
    expect(buildFilename("IELTS Listening Test 1", "dQw4w9WgXcQ", 1234567890000)).toBe(
      "ielts-listening-test-1-dQw4w9WgXcQ-1234567890000.mp3"
    );
  });

  it("truncates long slugs", () => {
    const f = buildFilename("x".repeat(200), "dQw4w9WgXcQ", 1);
    expect(f.startsWith(`${"x".repeat(80)}-dQw4w9WgXcQ-1.mp3`)).toBe(true);
  });
});
