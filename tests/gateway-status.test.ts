import assert from "node:assert/strict";
import test from "node:test";

import { maskKey } from "../src/lib/fusion/credentials.ts";
import { gatewayProbeReason } from "../src/lib/fusion/gateway-status.ts";

test("maskKey never reveals more than the last 4 characters", () => {
  assert.equal(maskKey("sk-abcdEFGH1234wxyz"), "••••wxyz");
  // Short keys are fully masked.
  assert.equal(maskKey("ab"), "••••");
  assert.equal(maskKey("abcd"), "••••");
});

test("gatewayProbeReason classifies a spend/credit cap", () => {
  const reason = gatewayProbeReason(
    new Error("Quota limit exceeded. Current spend: $4.00, limit: $4.00")
  );
  assert.match(reason, /credit or spend limit/i);
  assert.match(gatewayProbeReason(new Error("insufficient credits")), /credit or spend limit/i);
});

test("gatewayProbeReason classifies an auth rejection (not as a quota issue)", () => {
  const reason = gatewayProbeReason(new Error("401 Unauthorized: invalid api key"));
  assert.match(reason, /rejected|invalid|unauthorized/i);
  assert.doesNotMatch(reason, /credit or spend/i);
});

test("gatewayProbeReason classifies a timeout", () => {
  assert.match(gatewayProbeReason(new Error("Gateway probe timed out.")), /didn.t respond in time/i);
});

test("gatewayProbeReason falls back to the (trimmed) raw message", () => {
  assert.match(gatewayProbeReason(new Error("some other unexpected failure")), /some other unexpected failure/);
});
