import type { QueuedStep } from "./types.js";

export class StepError extends Error {
  constructor(
    failedStep: QueuedStep,
    allSteps: QueuedStep[],
    cause: unknown,
  ) {
    const causeMessage =
      cause instanceof Error ? cause.message : String(cause);

    const stepList = allSteps
      .map((step) => {
        const prefix = step === failedStep ? ">>> " : "    ";
        const status =
          step.index < failedStep.index
            ? "[ok]"
            : step.index === failedStep.index
              ? "[FAILED]"
              : "[skipped]";
        return `${prefix}${status} ${step.name}`;
      })
      .join("\n");

    super(
      `feather-testing-core: Step ${failedStep.index + 1} of ${allSteps.length} failed\n\n` +
        `Failed at: ${failedStep.name}\n` +
        `Cause: ${causeMessage}\n\n` +
        `Chain:\n${stepList}\n`,
      { cause },
    );

    this.name = "StepError";
  }
}

/**
 * Thrown by an adapter asked for something only a real browser can do.
 * A session wraps it in a StepError, so the chain trace names the verb that
 * could not run and this message says why and what to do instead.
 */
export class BrowserOnlyVerbError extends Error {
  /**
   * `environment` is what the adapter runs on instead of a browser, as the
   * message names it; it defaults to the RTL adapter's.
   */
  constructor(verb: string, alternative: string, environment = "JSDOM") {
    super(
      `feather-testing-core: ${verb} is a browser-only verb — this adapter runs ` +
        `in ${environment}, which has no browser to do it. ${alternative}`,
    );
    this.name = "BrowserOnlyVerbError";
  }
}
