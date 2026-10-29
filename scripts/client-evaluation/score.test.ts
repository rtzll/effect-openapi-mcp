import { expect, it } from "vite-plus/test";
import { score } from "./score.ts";
const valid = {
  expected: {
    tools: ["get_item"],
    arguments: { path: { id: "it_1" } },
    result: { id: "it_1" },
    maxCalls: 1,
  },
  calls: [{ tool: "get_item", arguments: { path: { id: "it_1" } } }],
  acceptedDispatchCount: 1,
  results: [{ result: { id: "it_1" } }],
  errorCount: 0,
  transcript: "",
  exitCode: 0,
  timedOut: false,
  authenticated: true,
};
it("scores the expected accepted call and actual result", () =>
  expect(score(valid).outcome).toBe("pass"));
it("rejects a wrong or invalid pre-dispatch attempt", () => {
  expect(
    score({
      ...valid,
      calls: [{ tool: "invented", arguments: {} }, ...valid.calls],
    }).outcome,
  ).toBe("fail");
  expect(score({ ...valid, acceptedDispatchCount: 0 }).outcome).toBe("fail");
});
it("classifies a catalog limit as a client blocker", () => {
  expect(
    score({
      ...valid,
      calls: [],
      acceptedDispatchCount: 0,
      results: [],
      clientBlocker: "2048 item catalog limit",
    }).outcome,
  ).toBe("blocked");
});
it("counts repeated calls and rejects nonzero completion", () => {
  const repeated = score({
    ...valid,
    calls: [...valid.calls, ...valid.calls],
    acceptedDispatchCount: 2,
  });
  expect(repeated.metrics.unnecessaryCalls).toBe(1);
  expect(repeated.outcome).toBe("fail");
  expect(score({ ...valid, exitCode: 1 }).outcome).toBe("fail");
});
it("keeps a no-call clarification pending until its final response is reviewed", () => {
  const noCall = {
    ...valid,
    expected: { tools: [], maxCalls: 0, clarification: true },
    calls: [],
    acceptedDispatchCount: 0,
    results: [],
  };
  expect(score(noCall)).toMatchObject({
    pendingReview: true,
    metrics: { completion: null },
    outcome: "fail",
  });
  expect(
    score({
      ...noCall,
      semanticReview: {
        accepted: true,
        reviewer: "manual reviewer",
        evidence: "Asked for the missing item ID.",
      },
    }).outcome,
  ).toBe("pass");
});
