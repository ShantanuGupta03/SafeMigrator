import { describe, expect, it } from "vitest";
import { classifySubmissionError } from "@/lib/services/submission-errors";

describe("classifySubmissionError", () => {
  it("treats user rejection as definitive", () => {
    expect(classifySubmissionError({ code: 4001, message: "User rejected" })).toBe("user_rejected");
  });
  it("treats unsupported batch methods as not submitted", () => {
    expect(classifySubmissionError(new Error("Method wallet_sendCalls not supported"))).toBe("not_submitted");
  });
  it("treats timeouts as ambiguous", () => {
    expect(classifySubmissionError(new Error("request timeout"))).toBe("ambiguous");
  });
});
