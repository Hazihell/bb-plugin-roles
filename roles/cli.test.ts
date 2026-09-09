import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { BlockRegistry, QuotaForCandidate } from "./blocks";
import { registerCli, type RolesDeps } from "./cli";
import { createQuotaReader, type Pool, type ProviderQuota, type QuotaReader, type QuotaSdk } from "./quota";
import { createSpawner } from "./spawn";
import { createSpawnedRegistry } from "./spawned";
import { createRoleStore } from "./store";

function pool(windows: Pool["windows"]): Pool {
  return { id: "default", matches: () => true, windows };
}

function okQuota(): ProviderQuota {
  return {
    status: "ok",
    pools: [pool([{ label: "5h", remainingFraction: 1, resetsAt: null }])],
    fetchedAtMs: 0,
  };
}

function fakeQuotaReader(byProvider: Record<string, ProviderQuota>): QuotaReader {
  return {
    async get(providerId) {
      const quota = byProvider[providerId];
      if (quota === undefined) throw new Error(`no quota fixture for ${providerId}`);
      return quota;
    },
    async refresh(providerId) {
      return this.get(providerId);
    },
  };
}

function fakeBlocks(
  held: Set<string> = new Set(),
  heldUntilByProvider: Map<string, { resetsAtMs: number; hasResetTime: boolean }> = new Map(),
): BlockRegistry {
  return {
    async record() {},
    async isHeld(providerId: string, _quotaForCandidate: QuotaForCandidate, _thresholdPercent: number) {
      return held.has(providerId);
    },
    async heldUntil(providerId: string) {
      return heldUntilByProvider.get(providerId) ?? null;
    },
  };
}

function setup(opts: {
  // biome-ignore lint: test double, sdk stub shape isn't the point
  sdk?: any;
  quotaByProvider?: Record<string, ProviderQuota>;
  held?: Set<string>;
  heldUntil?: Map<string, { resetsAtMs: number; hasResetTime: boolean }>;
} = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "roles-cli-test",
    sdk: opts.sdk ?? {},
  });
  const store = createRoleStore(bb);
  const quota = fakeQuotaReader(opts.quotaByProvider ?? {});
  const blocks = fakeBlocks(opts.held, opts.heldUntil);
  const spawned = createSpawnedRegistry(bb);
  const settings = { get: async () => ({ thresholdPercent: 5 }) };
  const spawner = createSpawner({ bb, store, quota, blocks, spawned, settings });
  const roles: RolesDeps = { store, quota, blocks, spawner, settings, spawned };
  registerCli(bb, roles);
  return { bb, harness, store, quota, blocks, spawned, spawner };
}

const builderCandidate = { provider: "p1", model: "m1-{level}", reasoningLevel: "medium" as const };

describe("bb roles spawn", () => {
  it("reuses the invoker's environment and project, and prints both ids", async () => {
    // biome-ignore lint: test double
    const getCalls: any[] = [];
    // biome-ignore lint: test double
    const spawnCalls: any[] = [];
    const { harness, store } = setup({
      sdk: {
        threads: {
          // biome-ignore lint: test double
          get: async (args: any) => {
            getCalls.push(args);
            return makeThreadResponse({ id: args.threadId, environmentId: "env_abc", projectId: "proj_1" });
          },
          // biome-ignore lint: test double
          spawn: async (args: any) => {
            spawnCalls.push(args);
            return makeThreadResponse({ id: "th_child_1", environmentId: "env_abc" });
          },
        },
      },
      quotaByProvider: { p1: okQuota() },
    });
    store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] });

    const result = await harness.behavior.runCli(["spawn", "--role", "builder", "--prompt", "x"], {
      threadId: "th_invoker",
    });

    expect(getCalls).toEqual([{ threadId: "th_invoker" }]);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      projectId: "proj_1",
      parentThreadId: "th_invoker",
      environment: { type: "reuse", environmentId: "env_abc" },
      prompt: "x",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("th_child_1");
    expect(result.stdout).toContain("builder");
    expect(result.stdout).toContain("p1 m1-medium (medium)");

    const jsonResult = await harness.behavior.runCli(
      ["spawn", "--role", "builder", "--prompt", "x", "--json"],
      { threadId: "th_invoker" },
    );
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      childId: "th_child_1",
      roleId: "builder",
      candidate: { provider: "p1", model: "m1-medium", reasoningLevel: "medium" },
      index: 0,
      level: "medium",
      environmentId: "env_abc",
    });
  });

  it("builds a managed-worktree environment for --new-environment worktree --base-branch", async () => {
    // biome-ignore lint: test double
    const spawnCalls: any[] = [];
    const { harness, store } = setup({
      sdk: {
        threads: {
          // biome-ignore lint: test double
          spawn: async (args: any) => {
            spawnCalls.push(args);
            return makeThreadResponse({ id: "th_child_1", environmentId: "env_new" });
          },
        },
      },
      quotaByProvider: { p1: okQuota() },
    });
    store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] });

    const result = await harness.behavior.runCli(
      ["spawn", "--role", "builder", "--prompt", "x", "--new-environment", "worktree", "--base-branch", "main"],
      { projectId: "proj_1" },
    );

    expect(result.exitCode).toBe(0);
    expect(spawnCalls[0]).toMatchObject({
      projectId: "proj_1",
      environment: {
        type: "host",
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
      },
    });
  });

  it("exits 1 with one refusal line per candidate when every candidate is skipped", async () => {
    const { harness, store } = setup({
      quotaByProvider: {
        p1: { status: "unauthenticated", pools: [], fetchedAtMs: 0 },
        p2: { status: "expired", pools: [], fetchedAtMs: 0 },
      },
    });
    store.create({
      id: "builder",
      description: "Builds.",
      permissionMode: "full",
      candidates: [
        { provider: "p1", model: "m1", reasoningLevel: "medium" },
        { provider: "p2", model: "m2", reasoningLevel: "medium" },
      ],
    });

    const result = await harness.behavior.runCli(
      ["spawn", "--role", "builder", "--prompt", "x", "--environment", "env_x"],
      { projectId: "proj_1" },
    );

    expect(result.exitCode).toBe(1);
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("p1");
    expect(lines[1]).toContain("p2");
  });
});

describe("bb roles list / show", () => {
  it("list prints a table in text mode and full records with --json", async () => {
    const { harness, store } = setup();
    store.create({ id: "builder", description: "Builds things.", permissionMode: "full", candidates: [builderCandidate] });

    const text = await harness.behavior.runCli(["list"], {});
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("builder");
    expect(text.stdout).toContain("Builds things.");

    const json = await harness.behavior.runCli(["list", "--json"], {});
    const parsed = JSON.parse(json.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("builder");
  });

  it("show prints one role with numbered candidates, and errors on an unknown id", async () => {
    const { harness, store } = setup();
    store.create({ id: "builder", description: "Builds things.", permissionMode: "full", candidates: [builderCandidate] });

    const shown = await harness.behavior.runCli(["show", "builder"], {});
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("0: p1 m1-medium (medium)");

    const missing = await harness.behavior.runCli(["show", "nope"], {});
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("nope");
  });

  it("shows, creates, updates, and clears a role brief", async () => {
    const { harness, store } = setup();
    const created = await harness.behavior.runCli([
      "create", "--id", "builder", "--description", "Builds.", "--brief", "One unit.", "--candidate", "p1:m1",
    ], {});
    expect(created.exitCode).toBe(0);
    expect(store.get("builder")?.brief).toBe("One unit.");
    expect((await harness.behavior.runCli(["show", "builder"], {})).stdout).toContain("brief: One unit.");
    await harness.behavior.runCli(["update", "builder", "--clear-brief"], {});
    expect(store.get("builder")?.brief).toBeUndefined();
  });
});

describe("bb roles create / update / delete", () => {
  it("create warns on stderr, exit 0, when a candidate model is absent from the live list", async () => {
    const { harness } = setup({
      sdk: {
        system: {
          // biome-ignore lint: test double
          executionOptions: async () =>
            ({
              modelLoadError: null,
              permissionCeiling: "full",
              providers: [{ id: "p1" }],
              models: [{ id: "other", model: "other-model" }],
              selectedOnlyModels: [],
              // biome-ignore lint: test double
            }) as any,
        },
      },
    });

    const result = await harness.behavior.runCli(
      ["create", "--id", "builder", "--description", "Builds.", "--candidate", "p1:m1:medium"],
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('warning: p1 has no model "m1" in its live list');
  });

  it("a failing executionOptions call is silently ignored", async () => {
    const { harness } = setup({
      sdk: {
        system: {
          // biome-ignore lint: test double
          executionOptions: async () => {
            throw new Error("offline");
          },
        },
      },
    });

    const result = await harness.behavior.runCli(
      ["create", "--id", "builder", "--description", "Builds.", "--candidate", "p1:m1:medium"],
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr ?? "").toBe("");
  });

  it("update replaces the whole candidate list when --candidate is given", async () => {
    const { harness, store } = setup({
      sdk: {
        system: {
          // biome-ignore lint: test double
          executionOptions: async () => {
            throw new Error("offline");
          },
        },
      },
    });
    store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] });

    const result = await harness.behavior.runCli(
      ["update", "builder", "--candidate", "p2:m2:high", "--candidate", "p3:m3"],
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(store.get("builder")?.candidates).toEqual([
      { provider: "p2", model: "m2", reasoningLevel: "high" },
      { provider: "p3", model: "m3", reasoningLevel: "medium" },
    ]);
  });

  it("delete removes a role and errors on an unknown id", async () => {
    const { harness, store } = setup();
    store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] });

    const result = await harness.behavior.runCli(["delete", "builder"], {});
    expect(result.exitCode).toBe(0);
    expect(store.get("builder")).toBeNull();

    const missing = await harness.behavior.runCli(["delete", "builder"], {});
    expect(missing.exitCode).toBe(1);
  });
});

// biome-ignore lint: test double, `Host` shape isn't the point
function fakeHost(id: string, name: string): any {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    maxPermissionMode: "full",
    status: "connected",
    type: "persistent",
  };
}

describe("bb roles export / import", () => {
  it("export then import via --machine reproduces the roles", async () => {
    const source = setup();
    source.store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] });

    const exported = await source.harness.behavior.runCli(["export"], {});
    expect(exported.exitCode).toBe(0);

    const target = setup({
      sdk: {
        hosts: {
          // biome-ignore lint: test double
          list: async () => [fakeHost("host_1", "laptop")],
        },
        files: {
          // biome-ignore lint: test double
          read: async (args: any) => ({
            content: exported.stdout,
            contentEncoding: "utf8",
            path: args.path,
            sha256: "x",
            sizeBytes: exported.stdout.length,
          }),
        },
      },
    });

    const imported = await target.harness.behavior.runCli(
      ["import", "/tmp/roles.json", "--machine", "host_1"],
      {},
    );
    expect(imported.exitCode).toBe(0);
    expect(imported.stdout).toContain("Imported 1 role(s)");
    expect(target.store.list()).toEqual(source.store.list());
  });

  it("import replaces the whole set: a role missing from the document is deleted", async () => {
    const target = setup({
      sdk: {
        hosts: {
          // biome-ignore lint: test double
          list: async () => [fakeHost("host_1", "laptop")],
        },
        files: {
          // biome-ignore lint: test double
          read: async () => ({
            content: JSON.stringify({
              version: 1,
              roles: [{ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] }],
            }),
            contentEncoding: "utf8",
            path: "/tmp/roles.json",
            sha256: "x",
            sizeBytes: 0,
          }),
        },
      },
    });
    target.store.create({ id: "scout", description: "Scouts.", permissionMode: "full", candidates: [builderCandidate] });
    target.store.create({ id: "builder", description: "Old.", permissionMode: "full", candidates: [builderCandidate] });

    const result = await target.harness.behavior.runCli(
      ["import", "/tmp/roles.json", "--machine", "host_1", "--json"],
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ imported: 1, removed: 1, roles: ["builder"] });
    expect(target.store.get("scout")).toBeNull();
    expect(target.store.get("builder")?.description).toBe("Builds.");
  });

  it("import without a thread and without --machine exits 1", async () => {
    const { harness } = setup();
    const result = await harness.behavior.runCli(["import", "/tmp/roles.json"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no host context: pass --machine");
  });

  it("import --machine reads through bb.sdk.files.read for that host", async () => {
    // biome-ignore lint: test double
    const readCalls: any[] = [];
    const { harness } = setup({
      sdk: {
        hosts: {
          // biome-ignore lint: test double
          list: async () => [fakeHost("host_1", "laptop")],
        },
        files: {
          // biome-ignore lint: test double
          read: async (args: any) => {
            readCalls.push(args);
            return {
              content: JSON.stringify({ version: 1, roles: [] }),
              contentEncoding: "utf8",
              path: args.path,
              sha256: "x",
              sizeBytes: 0,
            };
          },
        },
      },
    });

    const result = await harness.behavior.runCli(["import", "/tmp/roles.json", "--machine", "host_1"], {});
    expect(result.exitCode).toBe(0);
    expect(readCalls).toEqual([{ hostId: "host_1", path: "/tmp/roles.json" }]);
  });
});

describe("bb roles delete --json", () => {
  it("prints { id, deleted: true }", async () => {
    const { harness, store } = setup();
    store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] });

    const result = await harness.behavior.runCli(["delete", "builder", "--json"], {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: "builder", deleted: true });
  });
});

describe("bb roles quota", () => {
  // The live Antigravity report sample from cast.md (2026-09-08): the
  // Gemini group is exhausted, the other group is untouched.
  const ANTIGRAVITY_REPORT = JSON.stringify({
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                name: "Weekly Limit Remaining",
                remaining_fraction: 0,
                reset_time: "2026-09-10T19:35:41Z",
              },
            ],
          },
        ],
      },
    },
  });

  it("marks a candidate skipped when its pool is exhausted", async () => {
    const quotaSdk: QuotaSdk = {
      system: {
        usageLimits: async () => ({}),
        providerStates: async () => ({ providers: [] }),
      },
    };
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-cli-quota-test" });
    const store = createRoleStore(bb);
    const quota = createQuotaReader({ sdk: quotaSdk, exec: async () => ({ stdout: ANTIGRAVITY_REPORT }) });
    const blocks = fakeBlocks();
    const spawned = createSpawnedRegistry(bb);
    const settings = { get: async () => ({ thresholdPercent: 5 }) };
    const spawner = createSpawner({ bb, store, quota, blocks, spawned, settings });
    registerCli(bb, { store, quota, blocks, spawner, settings, spawned });

    store.create({
      id: "builder",
      description: "Builds.",
      permissionMode: "full",
      candidates: [{ provider: "acp-antigravity", model: "gemini-3.8-flash-{level}", reasoningLevel: "medium" }],
    });

    const result = await harness.behavior.runCli(["quota", "--json"], {});
    expect(result.exitCode).toBe(0);
    const rows = JSON.parse(result.stdout);
    expect(rows).toEqual([
      expect.objectContaining({
        role: "builder",
        provider: "acp-antigravity",
        skip: true,
        reason: "threshold",
      }),
    ]);
  });

  it("shows the earliest-release wording for a held block with no reset time, in text and JSON", async () => {
    const fallbackMs = Date.parse("2026-03-01T01:00:00Z");
    const iso = new Date(fallbackMs).toISOString();
    const { harness, store } = setup({
      quotaByProvider: { p1: okQuota() },
      held: new Set(["p1"]),
      heldUntil: new Map([["p1", { resetsAtMs: fallbackMs, hasResetTime: false }]]),
    });
    store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] });

    const jsonResult = await harness.behavior.runCli(["quota", "--json"], {});
    expect(jsonResult.exitCode).toBe(0);
    const rows = JSON.parse(jsonResult.stdout);
    expect(rows).toEqual([
      expect.objectContaining({
        role: "builder",
        provider: "p1",
        resetsAt: iso,
        resetKind: "earliest-release",
        skip: true,
        reason: "blocked",
      }),
    ]);

    const textResult = await harness.behavior.runCli(["quota"], {});
    expect(textResult.exitCode).toBe(0);
    expect(textResult.stdout).toContain(`held, earliest release ${iso}, needs fresh headroom`);
  });
});

describe("bb roles usage", () => {
  it("prints a null delta when the provider reset changed", async () => {
    const { harness, spawned } = setup();
    await spawned.put({
      childThreadId: "th_child_1",
      roleId: "builder",
      candidateIndex: 0,
      prompt: "x",
      title: null,
      parentThreadId: null,
      environmentId: "env_1",
      reasoningOverride: null,
      stage: "active",
      replacedBy: null,
      error: null,
      createdAtMs: Date.parse("2026-09-09T10:00:00Z"),
      updatedAtMs: Date.parse("2026-09-09T10:00:00Z"),
      provider: "p1",
      model: "m1-medium",
      level: "medium",
      quotaAtSpawn: { remainingPercent: 80, resetsAt: "2026-09-09T12:00:00Z" },
      quotaAtEnd: { remainingPercent: 95, resetsAt: "2026-09-09T17:00:00Z" },
      endedAtMs: Date.parse("2026-09-09T11:00:00Z"),
    });

    for (const argv of [["usage", "th_child_1", "--json"], ["usage", "--json", "th_child_1"]]) {
      const result = await harness.behavior.runCli(argv, {});
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({
        thread: "th_child_1",
        provider: "p1",
        model: "m1-medium",
        quotaAtSpawn: { remainingPercent: 80, resetsAt: "2026-09-09T12:00:00Z" },
        quotaAtEnd: { remainingPercent: 95, resetsAt: "2026-09-09T17:00:00Z" },
        delta: null,
        spawnedAt: "2026-09-09T10:00:00.000Z",
        endedAt: "2026-09-09T11:00:00.000Z",
      })]);
    }
  });
});
