import { describe, expect, it } from "vitest";
import { seedRoles } from "./seed";

// The expected table, straight from cast.md's Cast section (2026-09-08):
// provider, model, level, in order, per role.
const EXPECTED: Record<string, [provider: string, model: string, level: string][]> = {
  scout: [
    ["acp-antigravity", "gemini-3.8-flash-medium", "medium"],
    ["claude-code", "claude-sonnet-5", "low"],
    ["codex", "gpt-5.6-luna", "medium"],
  ],
  builder: [
    ["acp-antigravity", "gemini-3.8-flash-{level}", "medium"],
    ["claude-code", "claude-sonnet-5", "medium"],
    ["codex", "gpt-5.6-luna", "medium"],
  ],
  designer: [
    ["claude-code", "claude-opus-5[1m]", "low"],
    ["claude-code", "claude-sonnet-5", "low"],
    ["codex", "gpt-5.6-luna", "low"],
  ],
  reviewer: [
    ["codex", "gpt-6-astra", "low"],
    ["claude-code", "claude-opus-5", "medium"],
    ["codex", "gpt-5.6-luna", "high"],
  ],
  advisor: [
    ["codex", "gpt-6-astra", "medium"],
    ["claude-code", "claude-opus-5", "medium"],
    ["codex", "gpt-5.6-luna", "high"],
  ],
};

describe("seedRoles", () => {
  it("matches the cast.md candidate table exactly: provider, model, level and order, per role", () => {
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
