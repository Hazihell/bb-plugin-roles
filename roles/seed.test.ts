import { describe, expect, it } from "vitest";
import { seedRoles } from "./seed";

// The expected table, straight from roles/cast.json:
// provider, model, level, in order, per role.
const EXPECTED: Record<string, [provider: string, model: string, level: string][]> = {
  advisor: [
    ["claude-code", "claude-fable-5-1", "high"],
    ["claude-code", "claude-opus-5[1m]", "high"],
    ["acp-antigravity", "gemini-3.8-flash-{level}", "high"],
  ],
  scout: [
    ["acp-antigravity", "gemini-3.8-flash-{level}", "low"],
    ["acp-antigravity", "gemini-3.7-flash-{level}", "medium"],
    ["claude-code", "claude-sonnet-5", "low"],
  ],
  builder: [
    ["claude-code", "claude-opus-5[1m]", "medium"],
    ["acp-antigravity", "gemini-3.8-flash-{level}", "high"],
    ["claude-code", "claude-sonnet-5", "medium"],
  ],
  apprentice: [
    ["acp-antigravity", "gemini-3.8-flash-{level}", "medium"],
    ["acp-antigravity", "gemini-3.7-flash-{level}", "medium"],
    ["claude-code", "claude-sonnet-5", "medium"],
  ],
  reviewer: [
    ["claude-code", "claude-opus-5[1m]", "medium"],
    ["acp-antigravity", "gemini-3.8-flash-{level}", "high"],
    ["claude-code", "claude-fable-5-1", "medium"],
  ],
};

describe("seedRoles", () => {
  it("matches the exported cast candidate table exactly: provider, model, level and order, per role", () => {
    expect(seedRoles.map((role) => role.id)).toEqual(Object.keys(EXPECTED));
    for (const role of seedRoles) {
      const expected = EXPECTED[role.id]!;
      const actual = role.candidates.map(
        (candidate) => [candidate.provider, candidate.model, candidate.reasoningLevel] as const,
      );
      expect(actual).toEqual(expected);
    }
  });
});
