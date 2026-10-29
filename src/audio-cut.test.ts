import { describe, expect, it } from "vitest";
import { InvalidAudioUrlError, buildAudioCutFilename, buildAudioProxyFilename, validateAudioUrl } from "./audio-cut.js";

describe("validateAudioUrl", () => {
  it("rejects empty input", async () => {
    await expect(validateAudioUrl("")).rejects.toBeInstanceOf(InvalidAudioUrlError);
  });

  it("rejects non-http(s) protocols", async () => {
    await expect(validateAudioUrl("ftp://example.com/audio.mp3")).rejects.toBeInstanceOf(InvalidAudioUrlError);
  });

  it("rejects credentials in URL", async () => {
    await expect(validateAudioUrl("https://user:pass@example.com/audio.mp3")).rejects.toBeInstanceOf(
      InvalidAudioUrlError
    );
  });

  it("rejects localhost and loopback without DNS", async () => {
    await expect(validateAudioUrl("http://localhost/audio.mp3")).rejects.toBeInstanceOf(InvalidAudioUrlError);
    await expect(validateAudioUrl("http://127.0.0.1/audio.mp3")).rejects.toBeInstanceOf(InvalidAudioUrlError);
  });

  it("rejects RFC1918 hosts without DNS", async () => {
    await expect(validateAudioUrl("https://10.1.2.3/audio.mp3")).rejects.toBeInstanceOf(InvalidAudioUrlError);
    await expect(validateAudioUrl("https://192.168.0.5/audio.mp3")).rejects.toBeInstanceOf(InvalidAudioUrlError);
    await expect(validateAudioUrl("https://172.20.4.9/audio.mp3")).rejects.toBeInstanceOf(InvalidAudioUrlError);
    await expect(validateAudioUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      InvalidAudioUrlError
    );
  });

  it("rejects unresolvable hosts as invalid_url (no 500)", async () => {
    await expect(validateAudioUrl("https://this-host-does-not-exist-xyz.invalid/audio.mp3")).rejects.toBeInstanceOf(
      InvalidAudioUrlError
    );
  });
});

describe("buildAudioCutFilename", () => {
  it("slugifies the hint and appends -onecut", () => {
    const name = buildAudioCutFilename("OneIELTS Listening Test 12", 1234567890);
    expect(name).toBe("oneielts-listening-test-12-onecut-1234567890.mp3");
  });

  it("falls back to audio for empty hints", () => {
    expect(buildAudioCutFilename("   ", 1)).toBe("audio-onecut-1.mp3");
  });

  it("builds full-proxy filenames with -full- infix", () => {
    expect(buildAudioProxyFilename("OneIELTS Listening Test 12", 1234567890)).toBe(
      "oneielts-listening-test-12-full-1234567890.mp3"
    );
  });
});
