import { describe, expect, it } from "vitest";
import { seedRoles } from "./seed";

// The expected table, straight from roles/cast.json:
// provider, model, level, in order, per role.
const EXPECTED: Record<string, [provider: string, model: string, level: string][]> = {
  scout: [
    ["codex", "gpt-5.6-luna", "low"],
    ["acp-antigravity", "gemini-3.8-flash-medium", "medium"],
    ["claude-code", "claude-sonnet-5", "low"],
  ],
  builder: [
    ["acp-antigravity", "gemini-3.8-flash-{level}", "medium"],
    ["codex", "gpt-5.6-luna", "medium"],
    ["claude-code", "claude-sonnet-5", "medium"],
  ],
  designer: [
    ["claude-code", "claude-opus-5[1m]", "low"],
    ["claude-code", "claude-sonnet-5", "low"],
    ["codex", "gpt-5.6-luna", "low"],
  ],
  reviewer: [
    ["codex", "gpt-5.6-sol", "medium"],
    ["claude-code", "claude-opus-5[1m]", "medium"],
  ],
  advisor: [
    ["codex", "gpt-6-astra", "medium"],
    ["claude-code", "claude-opus-5[1m]", "medium"],
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
