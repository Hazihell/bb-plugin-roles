import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerInstructions } from "./instructions";
import type { SpawnedRecord } from "./spawned";
import { createSpawnedRegistry } from "./spawned";
import { createRoleStore } from "./store";
import { DEFAULT_DELEGATION_RULE } from "./rule";

function spawnedRecord(overrides: Partial<SpawnedRecord> = {}): SpawnedRecord {
  return {
    childThreadId: "th_child",
    roleId: "builder",
    candidateIndex: 0,
    prompt: "do it",
    title: null,
    parentThreadId: "th_parent",
    environmentId: "env_1",
    reasoningOverride: null,
    stage: "active",
    replacedBy: null,
    error: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

describe("registerInstructions", () => {
  const settings = { get: async () => ({ delegationRule: DEFAULT_DELEGATION_RULE }), onChange: () => {} };

  it("includes the rule and empty Cast when there are no roles", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    const spawned = createSpawnedRegistry(bb);
    await registerInstructions({ bb, store, spawned, settings });

    const contribute = harness.registrations.instructionProvider;
    expect(contribute).not.toBeNull();
    expect(contribute!({ threadId: "th_x", projectId: "proj_1" })).toContain("## Delegation");
    expect(contribute!({ threadId: "th_x", projectId: "proj_1" })).toContain("## Cast");
  });

  it("carries the rule, cast, one line per role, and spawn pointer for any thread", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    store.create({
      id: "scout",
      description: "Read-only exploration.",
      permissionMode: "full",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    store.create({
      id: "builder",
      description: "Implementation work.",
      permissionMode: "full",
      instruction: "Follow the plan exactly.",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    const spawned = createSpawnedRegistry(bb);
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_not_spawned",
      projectId: "proj_1",
    });

    expect(text).toContain(DEFAULT_DELEGATION_RULE);
    expect(text).toContain("## Cast");
    expect(text).toContain("- **scout** — Read-only exploration.");
    expect(text).toContain("- **builder** — Implementation work.");
    expect(text).toContain("bb roles spawn --role <id>");
    // Not a thread this plugin spawned: no role-specific instruction section.
    expect(text).not.toContain("## Role:");
    expect(text).not.toContain("Follow the plan exactly.");
  });

  it("additionally carries the role's own instruction for a spawned thread", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    store.create({
      id: "builder",
      description: "Implementation work.",
      permissionMode: "full",
      instruction: "Follow the plan exactly.",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    const spawned = createSpawnedRegistry(bb);
    await spawned.put(spawnedRecord({ childThreadId: "th_child", roleId: "builder" }));
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_child",
      projectId: "proj_1",
    });

    expect(text).toBe("\n\n## Role: builder\nFollow the plan exactly.");
    expect(text).toContain("## Role: builder");
    expect(text).toContain("Follow the plan exactly.");
  });

  it("keeps the whole Cast under an 8000-char instruction, truncating the instruction instead", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    const longInstruction = `START-OF-INSTRUCTION ${"x".repeat(8000)}`;
    store.create({
      id: "scout",
      description: "Read-only exploration.",
      permissionMode: "full",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    store.create({
      id: "builder",
      description: "Implementation work.",
      permissionMode: "full",
      instruction: longInstruction,
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    const spawned = createSpawnedRegistry(bb);
    await spawned.put(spawnedRecord({ childThreadId: "th_child", roleId: "builder" }));
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_child",
      projectId: "proj_1",
    });

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("## Role: builder");
    expect(text).toContain("START-OF-INSTRUCTION");
    expect(text).not.toContain("## Cast");
  });

  it("reflects a role store change without touching the database again", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    const spawned = createSpawnedRegistry(bb);
    await registerInstructions({ bb, store, spawned, settings });

    store.create({
      id: "advisor",
      description: "Checks a plan.",
      permissionMode: "full",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_x",
      projectId: "proj_1",
    });
    expect(text).toContain("- **advisor** — Checks a plan.");
  });
});
