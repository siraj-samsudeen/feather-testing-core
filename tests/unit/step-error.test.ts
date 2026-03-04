import { describe, it, expect } from "vitest";
import { StepError } from "../../src/errors.js";
import type { QueuedStep } from "../../src/types.js";

function makeStep(index: number, name: string): QueuedStep {
  return { index, name, action: async () => {} };
}

describe("StepError", () => {
  it("formats the error message with step number and total", () => {
    const steps = [
      makeStep(0, "visit('/')"),
      makeStep(1, "fillIn('Email', 'a@b.com')"),
      makeStep(2, "clickButton('Sign in')"),
    ];
    const cause = new Error("button not found");
    const error = new StepError(steps[2], steps, cause);

    expect(error.message).toContain("Step 3 of 3 failed");
  });

  it("shows the failed step name and cause", () => {
    const steps = [
      makeStep(0, "visit('/')"),
      makeStep(1, "clickButton('Go')"),
    ];
    const cause = new Error("locator resolved to 0 elements");
    const error = new StepError(steps[1], steps, cause);

    expect(error.message).toContain("Failed at: clickButton('Go')");
    expect(error.message).toContain("Cause: locator resolved to 0 elements");
  });

  it("marks steps before failure as [ok]", () => {
    const steps = [
      makeStep(0, "visit('/')"),
      makeStep(1, "fillIn('Name', 'x')"),
      makeStep(2, "clickButton('Go')"),
    ];
    const error = new StepError(steps[2], steps, new Error("fail"));

    expect(error.message).toContain("    [ok] visit('/')");
    expect(error.message).toContain("    [ok] fillIn('Name', 'x')");
  });

  it("marks the failed step with >>> [FAILED]", () => {
    const steps = [
      makeStep(0, "visit('/')"),
      makeStep(1, "clickButton('Go')"),
    ];
    const error = new StepError(steps[1], steps, new Error("fail"));

    expect(error.message).toContain(">>> [FAILED] clickButton('Go')");
  });

  it("marks steps after failure as [skipped]", () => {
    const steps = [
      makeStep(0, "visit('/')"),
      makeStep(1, "clickButton('Go')"),
      makeStep(2, "assertText('Done')"),
      makeStep(3, "assertPath('/done')"),
    ];
    const error = new StepError(steps[1], steps, new Error("fail"));

    expect(error.message).toContain("    [skipped] assertText('Done')");
    expect(error.message).toContain("    [skipped] assertPath('/done')");
  });

  it("handles first step failure", () => {
    const steps = [
      makeStep(0, "visit('/')"),
      makeStep(1, "assertText('Hello')"),
    ];
    const error = new StepError(steps[0], steps, new Error("fail"));

    expect(error.message).toContain("Step 1 of 2 failed");
    expect(error.message).toContain(">>> [FAILED] visit('/')");
    expect(error.message).toContain("    [skipped] assertText('Hello')");
    // No [ok] steps
    expect(error.message).not.toContain("[ok]");
  });

  it("handles single step failure", () => {
    const steps = [makeStep(0, "visit('/')")];
    const error = new StepError(steps[0], steps, new Error("fail"));

    expect(error.message).toContain("Step 1 of 1 failed");
    expect(error.message).toContain(">>> [FAILED] visit('/')");
    expect(error.message).not.toContain("[ok]");
    expect(error.message).not.toContain("[skipped]");
  });

  it("handles last step failure with all preceding steps as [ok]", () => {
    const steps = [
      makeStep(0, "visit('/')"),
      makeStep(1, "fillIn('Email', 'a@b.com')"),
      makeStep(2, "clickButton('Go')"),
    ];
    const error = new StepError(steps[2], steps, new Error("fail"));

    expect(error.message).toContain("    [ok] visit('/')");
    expect(error.message).toContain("    [ok] fillIn('Email', 'a@b.com')");
    expect(error.message).toContain(">>> [FAILED] clickButton('Go')");
    expect(error.message).not.toContain("[skipped]");
  });

  it("preserves the original error as cause", () => {
    const steps = [makeStep(0, "visit('/')")];
    const cause = new Error("original error");
    const error = new StepError(steps[0], steps, cause);

    expect(error.cause).toBe(cause);
  });

  it("handles non-Error cause (string)", () => {
    const steps = [makeStep(0, "visit('/')")];
    const error = new StepError(steps[0], steps, "string cause");

    expect(error.message).toContain("Cause: string cause");
    expect(error.cause).toBe("string cause");
  });

  it("sets name to StepError", () => {
    const steps = [makeStep(0, "visit('/')")];
    const error = new StepError(steps[0], steps, new Error("fail"));

    expect(error.name).toBe("StepError");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StepError);
  });
});
