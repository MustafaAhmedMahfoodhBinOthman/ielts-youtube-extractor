import { describe, expect, it } from "vitest";
import {
  InvalidRangeError,
  assertRangeWithinDuration,
  buildSectionArg,
  formatYtDlpTimestamp,
  parseTimeRange,
  parseTimeValue,
} from "./range.js";

describe("parseTimeValue", () => {
  it("accepts seconds as number or numeric string", () => {
    expect(parseTimeValue(30, "start_time")).toBe(30);
    expect(parseTimeValue("30", "start_time")).toBe(30);
    expect(parseTimeValue("30.5", "end_time")).toBe(30.5);
    expect(parseTimeValue(0, "start_time")).toBe(0);
  });

  it("parses mm:ss", () => {
    expect(parseTimeValue("8:24", "end_time")).toBe(504);
    expect(parseTimeValue("10:00", "end_time")).toBe(600);
    expect(parseTimeValue("0:45", "start_time")).toBe(45);
  });

  it("parses hh:mm:ss", () => {
    expect(parseTimeValue("1:02:03", "end_time")).toBe(3723);
    expect(parseTimeValue("0:08:24", "end_time")).toBe(504);
  });

  it.each([-5, "-5", "abc", "", "1:2:3:4", "10:", ":30", "NaN", null, {}, []])(
    "rejects %p",
    (bad) => {
      expect(() => parseTimeValue(bad, "start_time")).toThrow(InvalidRangeError);
    }
  );
});

describe("parseTimeRange", () => {
  it("defaults to full audio", () => {
    expect(parseTimeRange(undefined, undefined)).toEqual({ startSeconds: 0, endSeconds: null });
  });

  it("parses mixed forms", () => {
    expect(parseTimeRange(30, "10:00")).toEqual({ startSeconds: 30, endSeconds: 600 });
    expect(parseTimeRange("1:00", "0:08:24")).toEqual({ startSeconds: 60, endSeconds: 504 });
  });

  it.each([
    [30, 30],
    [60, 30],
    ["10:00", "8:24"],
  ])("rejects end<=start (%p, %p)", (s, e) => {
    expect(() => parseTimeRange(s, e)).toThrow(InvalidRangeError);
  });
});

describe("assertRangeWithinDuration", () => {
  it("rejects end beyond duration with actual duration in message", () => {
    try {
      assertRangeWithinDuration({ startSeconds: 0, endSeconds: 5024 }, 504, "vid");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRangeError);
      expect((err as Error).message).toBe("end_time 5024s exceeds video duration 504s");
    }
  });

  it("rejects start at or beyond duration", () => {
    expect(() => assertRangeWithinDuration({ startSeconds: 504, endSeconds: null }, 504, "vid")).toThrow(
      InvalidRangeError
    );
    expect(() => assertRangeWithinDuration({ startSeconds: 600, endSeconds: null }, 504, "vid")).toThrow(
      InvalidRangeError
    );
  });

  it("passes valid ranges and unknown durations", () => {
    expect(() =>
      assertRangeWithinDuration({ startSeconds: 30, endSeconds: 600 }, 1823, "vid")
    ).not.toThrow();
    expect(() => assertRangeWithinDuration({ startSeconds: 0, endSeconds: 99999 }, null, "vid")).not.toThrow();
  });
});

describe("formatYtDlpTimestamp", () => {
  it.each([
    [0, "0:00:00"],
    [30, "0:00:30"],
    [504, "0:08:24"],
    [600, "0:10:00"],
    [3723, "1:02:03"],
    [90.5, "0:01:30.5"],
  ])("formats %p as %p", (sec, expected) => {
    expect(formatYtDlpTimestamp(sec)).toBe(expected);
  });
});

describe("buildSectionArg", () => {
  it("returns null when not trimming", () => {
    expect(buildSectionArg({ startSeconds: 0, endSeconds: null })).toBeNull();
  });

  it("builds *START-END and *START-inf", () => {
    expect(buildSectionArg({ startSeconds: 0, endSeconds: 504 })).toBe("*0:00:00-0:08:24");
    expect(buildSectionArg({ startSeconds: 30, endSeconds: 600 })).toBe("*0:00:30-0:10:00");
    expect(buildSectionArg({ startSeconds: 30, endSeconds: null })).toBe("*0:00:30-inf");
  });
});
