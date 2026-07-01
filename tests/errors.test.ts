import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyJudgeError,
  classifyProviderError
} from "../src/lib/fusion/errors.ts";

test("classifyProviderError maps provider credit, rate, timeout, and policy failures", () => {
  assert.equal(
    classifyProviderError(new Error("Payment required: insufficient credits")),
    "insufficient_credits"
  );
  assert.equal(
    classifyProviderError({ statusCode: 429, message: "Too many requests" }),
    "rate_limited"
  );
  assert.equal(classifyProviderError(new Error("Request timed out")), "provider_timeout");
  assert.equal(classifyProviderError(new Error("Blocked by safety policy")), "policy_blocked");
  assert.equal(classifyProviderError(new Error("Provider exploded")), "unexpected_error");
});

test("classifyJudgeError preserves structured-output failures", () => {
  assert.equal(classifyJudgeError(new Error("JSON schema parse failed")), "invalid_judge_json");
  assert.equal(classifyJudgeError(new Error("Rate limit exceeded")), "rate_limited");
});
