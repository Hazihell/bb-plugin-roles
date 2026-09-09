import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import cast from "./cast.json" with { type: "json" };
import { registerInstructions } from "./instructions";
import { roleSchema } from "./schema";
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
    provider: "p1",
    model: "m1",
    level: "medium",
    quotaAtSpawn: { remainingPercent: 80, resetsAt: null },
    quotaAtEnd: null,
    endedAtMs: null,
    ...overrides,
  };
}

describe("registerInstructions", () => {
  const settings = { get: async () => ({ delegationRule: DEFAULT_DELEGATION_RULE, disabledRoles: "[]" }), onChange: () => {} };

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

  it("uses the review-only delegation rule", async () => {
    expect(DEFAULT_DELEGATION_RULE).toBe(
      '## Delegation\nThis thread builds its own unit in its own worktree and sends every candidate commit to a reviewer child before hand-back. Spawn the reviewer with `bb roles spawn --role reviewer --title "<title>" --prompt "$(cat <brief-file>)"`, briefed with the two SHAs, the spec and the check commands, and read back its report, never its transcript. Fix its findings here, in this worktree, then return them to the same reviewer with the new head SHA by `bb thread tell`; it answers closed, open or regressed, and this thread decides what blocks. End the turn after a spawn or `bb thread tell`; the reviewer notifies on completion and its questions arrive the same way. A reviewer stays until its findings close; archive it then. Other roles in the Cast are for a unit this thread judges too large for one context; a child is briefed from a file with what its cast line asks for and the cap on what it returns, and the provider\'s own agent or subagent tool stays unused.',
    );
  });

  it("renders a brief after a truncated description and truncates the brief", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test-brief" });
    const store = createRoleStore(bb);
    store.create({
      id: "builder",
      description: "D".repeat(201),
      brief: "B".repeat(201),
      permissionMode: "full",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    const spawned = createSpawnedRegistry(bb);
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({ threadId: "th_x", projectId: "proj_1" });
    expect(text).toContain(`- **builder** — ${"D".repeat(199)}… Brief: ${"B".repeat(199)}…`);
  });

  it("keeps the default rule followed by a five-role cast within 4096 characters", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test-brief-budget" });
    const store = createRoleStore(bb);
    for (const id of ["scout", "builder", "designer", "reviewer", "advisor"] as const) {
      store.create({
        id,
        description: "D".repeat(200),
        brief: "B".repeat(200),
        permissionMode: "full",
        candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
      });
    }
    const spawned = createSpawnedRegistry(bb);
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({ threadId: "th_x", projectId: "proj_1" });
    expect(text!.length).toBeLessThanOrEqual(4096);
    expect(text).toContain(DEFAULT_DELEGATION_RULE);
    expect(text).toContain("- **advisor**");
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

    expect(text).toBe("\n\n## Role: builder\nFollow the plan exactly.\n\nA child is a leaf: it edits only what its role allows, spawns nothing, and leaves the provider's own agent or subagent tool unused.\n\nYour coordinator is thread th_parent. A decision the brief does not settle goes there: `bb thread tell th_parent \"<the fork and your recommendation>\"`, then end the turn and continue when the answer arrives.");
    expect(text).toContain("## Role: builder");
    expect(text).toContain("Follow the plan exactly.");
  });

  it("renders the reviewer instruction from the cast within the budget", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test-reviewer" });
    const store = createRoleStore(bb);
    const reviewer = roleSchema.parse(cast.roles.find((role) => role.id === "reviewer"));
    store.create(reviewer);
    const spawned = createSpawnedRegistry(bb);
    await spawned.put(spawnedRecord({ childThreadId: "th_reviewer", roleId: "reviewer" }));
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_reviewer",
      projectId: "proj_1",
    });

    expect(text!.length).toBeLessThan(4096);
    expect(text).toContain(reviewer.instruction);
    expect(text).not.toContain("…");
  });

  it("keeps the coordinator paragraph when a role instruction is too long", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test-budget" });
    const store = createRoleStore(bb);
    store.create({
      id: "builder",
      description: "Implementation work.",
      permissionMode: "full",
      instruction: "I".repeat(5000),
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    const spawned = createSpawnedRegistry(bb);
    await spawned.put(spawnedRecord({ childThreadId: "th_builder", roleId: "builder" }));
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_builder",
      projectId: "proj_1",
    });

    expect(text).toHaveLength(4096);
    expect(text).toMatch(/Your coordinator is thread th_parent\..*answer arrives\.$/);
  });

  it("does not add a coordinator paragraph when a spawned thread has no parent", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test-orphan" });
    const store = createRoleStore(bb);
    store.create({
      id: "builder",
      description: "Implementation work.",
      permissionMode: "full",
      instruction: "Follow the plan exactly.",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    const spawned = createSpawnedRegistry(bb);
    await spawned.put(spawnedRecord({ childThreadId: "th_orphan", parentThreadId: null }));
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_orphan",
      projectId: "proj_1",
    });

    expect(text).toBe("\n\n## Role: builder\nFollow the plan exactly.\n\nA child is a leaf: it edits only what its role allows, spawns nothing, and leaves the provider's own agent or subagent tool unused.");
    expect(text).not.toContain("Your coordinator is thread");
  });

  it("falls back to the Cast for a spawned child whose role has no instruction", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    store.create({
      id: "scout",
      description: "Read-only exploration.",
      permissionMode: "full",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    const spawned = createSpawnedRegistry(bb);
    await spawned.put(spawnedRecord({ childThreadId: "th_child", roleId: "scout" }));
    await registerInstructions({ bb, store, spawned, settings });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_child",
      projectId: "proj_1",
    });

    expect(text).toContain("## Cast");
    expect(text).toContain("- **scout** — Read-only exploration.");
    expect(text).not.toContain("## Role:");
  });

  it("serves the delegation rule first, truncating the Cast when the rule is long", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    store.create({
      id: "scout",
      description: "Read-only exploration.",
      permissionMode: "full",
      candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
    });
    const spawned = createSpawnedRegistry(bb);
    const longRule = "R".repeat(4090);
    const longRuleSettings = { get: async () => ({ delegationRule: longRule }), onChange: () => {} };
    await registerInstructions({ bb, store, spawned, settings: longRuleSettings });

    const text = harness.registrations.instructionProvider!({
      threadId: "th_parent",
      projectId: "proj_1",
    });

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(4096);
    expect(text!.startsWith(longRule)).toBe(true);
    expect(text).not.toContain("## Cast");
  });

  it("uses an edited delegation rule for the next parent contribution", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    const spawned = createSpawnedRegistry(bb);
    let onChange: ((next: { delegationRule: string }) => void) | undefined;
    const editableSettings = {
      get: async () => ({ delegationRule: "old rule" }),
      onChange: (listener: (next: { delegationRule: string }) => void) => {
        onChange = listener;
      },
    };
    await registerInstructions({ bb, store, spawned, settings: editableSettings });

    onChange!({ delegationRule: "new rule" });
    const text = harness.registrations.instructionProvider!({
      threadId: "th_parent",
      projectId: "proj_1",
    });

    expect(text).not.toBeNull();
    expect(text!.startsWith("new rule\n\n")).toBe(true);
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

  it("omits disabled roles from the Cast", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test-disabled" });
    const store = createRoleStore(bb);
    store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [{ provider: "p", model: "m", reasoningLevel: "low" }] });
    store.create({ id: "reviewer", description: "Reviews.", permissionMode: "full", candidates: [{ provider: "p", model: "m", reasoningLevel: "low" }] });
    const spawned = createSpawnedRegistry(bb);
    const disabledSettings = { get: async () => ({ delegationRule: DEFAULT_DELEGATION_RULE, disabledRoles: '["builder"]' }), onChange: () => {} };
    await registerInstructions({ bb, store, spawned, settings: disabledSettings });
    const text = harness.registrations.instructionProvider!({ threadId: "th_x", projectId: "proj_1" });
    expect(text).not.toContain("- **builder**");
    expect(text).toContain("- **reviewer**");
  });
});
