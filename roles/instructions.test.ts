import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerInstructions } from "./instructions";
import type { SpawnedRecord } from "./spawned";
import { createSpawnedRegistry } from "./spawned";
import { createRoleStore } from "./store";

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
  it("returns null when there are no roles and the thread was not spawned", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    const spawned = createSpawnedRegistry(bb);
    registerInstructions({ bb, store, spawned });

    const contribute = harness.registrations.instructionProvider;
    expect(contribute).not.toBeNull();
    expect(contribute!({ threadId: "th_x", projectId: "proj_1" })).toBeNull();
  });

  it("carries the cast, one line per role, and the spawn pointer for any thread", () => {
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
    registerInstructions({ bb, store, spawned });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_not_spawned",
      projectId: "proj_1",
    });

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
    registerInstructions({ bb, store, spawned });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_child",
      projectId: "proj_1",
    });

    expect(text).toContain("## Cast");
    expect(text).toContain("## Role: builder");
    expect(text).toContain("Follow the plan exactly.");
  });

  it("reflects a role store change without touching the database again", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    const spawned = createSpawnedRegistry(bb);
    registerInstructions({ bb, store, spawned });

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
