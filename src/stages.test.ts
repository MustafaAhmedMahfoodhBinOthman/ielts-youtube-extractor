import { describe, expect, it } from "vitest";
import { clearStage, getStage, setStage } from "./stages.js";

describe("stages", () => {
  it("tracks and clears per-job stages", () => {
    expect(getStage("nope")).toBeUndefined();
    setStage("job-1", "downloading");
    expect(getStage("job-1")).toBe("downloading");
    setStage("job-1", "cutting");
    expect(getStage("job-1")).toBe("cutting");
    clearStage("job-1");
    expect(getStage("job-1")).toBeUndefined();
  });
});
