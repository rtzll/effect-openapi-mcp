import type { Case } from "./cases.ts";

export const scoringVersion = 1;
export const subset = (actual: unknown, expected: unknown): boolean => {
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) =>
        subset((actual as Record<string, unknown>)[key], value),
      )
    );
  return actual === expected;
};
export const score = (input: {
  expected: Case["expected"];
  calls: { tool?: unknown; arguments?: unknown }[];
  acceptedDispatchCount: number;
  results: { result?: unknown }[];
  errorCount: number;
  transcript: string;
  exitCode: number | null;
  timedOut: boolean;
  authenticated: boolean;
  clientBlocker?: string;
  semanticReview?: { accepted: boolean; reviewer: string; evidence: string };
}) => {
  const { expected, calls } = input;
  const selection =
    calls.length === expected.tools.length &&
    calls.every((call, index) => call.tool === expected.tools[index]);
  const validArguments =
    calls.length > 0
      ? input.acceptedDispatchCount === calls.length &&
        (expected.arguments === undefined ||
          subset(calls[0]?.arguments, expected.arguments)) &&
        (expected.argumentAlternatives === undefined ||
          expected.argumentAlternatives.some((arguments_) =>
            subset(calls[0]?.arguments, arguments_),
          ))
      : expected.tools.length === 0;
  const pendingReview =
    expected.tools.length === 0 && input.semanticReview === undefined;
  const completion = pendingReview
    ? null
    : expected.tools.length === 0
      ? input.semanticReview?.accepted === true
      : expected.error
        ? input.errorCount === 1 && !input.transcript.includes("DO_NOT_EXPOSE")
        : expected.result === undefined
          ? input.exitCode === 0
          : input.results.some((result) =>
              subset(result.result, expected.result),
            );
  const unnecessaryCalls = Math.max(0, calls.length - expected.maxCalls);
  const blocked =
    !input.authenticated ||
    input.clientBlocker !== undefined ||
    input.timedOut ||
    (input.exitCode !== 0 && calls.length === 0);
  return {
    scoringVersion,
    pendingReview,
    metrics: {
      selection,
      validArguments,
      completion,
      unnecessaryCalls,
      clarification: expected.clarification
        ? (input.semanticReview?.accepted ?? null)
        : "not-required",
    },
    outcome: blocked
      ? "blocked"
      : selection &&
          validArguments &&
          completion === true &&
          unnecessaryCalls === 0 &&
          input.exitCode === 0
        ? "pass"
        : "fail",
  };
};
