// roles/seed.ts — the seed cast, copied from the current custom-instructions
// Cast (cast.md on task RL-2). Loaded once by store.seedOnce() and never
// re-applied afterwards, so editing this file only affects new databases.
import type { Role } from "./schema";

export const seedRoles: Role[] = [
  {
    id: "scout",
    description:
      "Read-only exploration, research or inventory ending in a report of at most a thousand words.",
    permissionMode: "full",
    candidates: [
      {
        provider: "acp-antigravity",
        model: "gemini-3.8-flash-medium",
        reasoningLevel: "medium",
      },
      {
        provider: "claude-code",
        model: "claude-sonnet-5",
        reasoningLevel: "low",
      },
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningLevel: "medium",
      },
    ],
  },
  {
    id: "builder",
    description:
      "Implementation that changes files: backend, API, state, tests, layout mechanics, UI without qualitative judgement.",
    permissionMode: "full",
    candidates: [
      {
        provider: "acp-antigravity",
        model: "gemini-3.8-flash-{level}",
        reasoningLevel: "medium",
      },
      {
        provider: "claude-code",
        model: "claude-sonnet-5",
        reasoningLevel: "medium",
      },
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningLevel: "medium",
      },
    ],
  },
  {
    id: "designer",
    description:
      "Changes needing taste: visual composition, interaction judgement, qualitative design.",
    permissionMode: "full",
    candidates: [
      {
        provider: "claude-code",
        model: "claude-opus-5[1m]",
        reasoningLevel: "low",
      },
      {
        provider: "claude-code",
        model: "claude-sonnet-5",
        reasoningLevel: "low",
      },
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningLevel: "medium",
      },
    ],
  },
  {
    id: "reviewer",
    description:
      "Read-only review of a diff between two commits; reports findings, never edits.",
    permissionMode: "full",
    candidates: [
      {
        provider: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "low",
      },
      {
        provider: "claude-code",
        model: "claude-opus-5",
        reasoningLevel: "medium",
      },
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningLevel: "high",
      },
    ],
  },
  {
    id: "advisor",
    description:
      "Read-only check of a coordinator's plan before building; returns what it gets wrong, misses or could drop.",
    permissionMode: "full",
    candidates: [
      {
        provider: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "medium",
      },
      {
        provider: "claude-code",
        model: "claude-opus-5",
        reasoningLevel: "medium",
      },
      {
        provider: "codex",
        model: "gpt-5.6-luna",
        reasoningLevel: "high",
      },
    ],
  },
];
