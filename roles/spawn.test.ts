import {
  createFakePluginHost,
  makeThreadResponse,
  makeTurnFailedEvent,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { BlockRegistry, QuotaForCandidate } from "./blocks";
import type { Pool, ProviderQuota, QuotaReader } from "./quota";
import type { Role } from "./schema";
import { AllCandidatesExhausted, createSpawner } from "./spawn";
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

interface FakeBlocks extends BlockRegistry {
  recordCalls: [providerId: string, resetsAtMs: number | null][];
}

function fakeBlocks(heldProviders: Set<string> = new Set()): FakeBlocks {
  const recordCalls: [string, number | null][] = [];
  return {
    recordCalls,
    async record(providerId, resetsAtMs) {
      recordCalls.push([providerId, resetsAtMs]);
    },
    async isHeld(providerId: string, _quotaForCandidate: QuotaForCandidate, _thresholdPercent: number) {
      return heldProviders.has(providerId);
    },
    async heldUntil() {
      return null;
    },
  };
}

const builderRole: Role = {
  id: "builder",
  description: "Implementation work.",
  permissionMode: "full",
  candidates: [
    { provider: "p1", model: "m1-{level}", reasoningLevel: "medium" },
    { provider: "p2", model: "m2", reasoningLevel: "low" },
  ],
};

function setup(opts: { byProvider: Record<string, ProviderQuota> }) {
  const spawnCalls: unknown[] = [];
  const sendCalls: unknown[] = [];
  const archiveCalls: unknown[] = [];
  const execCalls: [string, string[]][] = [];
  let nextChildId = 1;

  const { bb, harness } = createFakePluginHost({
    pluginId: "roles-test",
    sdk: {
      threads: {
        // biome-ignore lint: test double, args shape isn't the point
        spawn: async (args: any) => {
          spawnCalls.push(args);
          const id = `th_child_${nextChildId++}`;
          return makeThreadResponse({ id, environmentId: `env_for_${id}` });
        },
        // biome-ignore lint: test double
        send: async (args: any) => {
          sendCalls.push(args);
          return {} as never;
        },
        // biome-ignore lint: test double
        archive: async (args: any) => {
          archiveCalls.push(args);
          return {} as never;
        },
      },
      environments: {
        get: async () => ({ projectId: "proj_1" }) as never,
      },
    },
  });

  const store = createRoleStore(bb);
  store.create(builderRole);
  const quota = fakeQuotaReader(opts.byProvider);
  const blocks = fakeBlocks();
  const spawned = createSpawnedRegistry(bb);
  const settings = { get: async () => ({ thresholdPercent: 5 }) };
  const execFn = async (command: string, args: string[]) => {
    execCalls.push([command, args]);
    return { stdout: "" };
  };

  const spawner = createSpawner({ bb, store, quota, blocks, spawned, settings, execFn });

  return {
    bb,
    harness,
    store,
    blocks,
    spawned,
    spawner,
    spawnCalls,
    sendCalls,
    archiveCalls,
    execCalls,
  };
}

const baseArgs = {
  roleId: "builder",
  prompt: "do it",
  environment: { type: "reuse" as const, environmentId: "env_x" },
  projectId: "proj_1",
};

describe("spawnByRole", () => {
  it("picks the first usable candidate and records the child under the response's environment id", async () => {
    const { spawner, spawnCalls, spawned } = setup({ byProvider: { p1: okQuota(), p2: okQuota() } });

    const result = await spawner.spawnByRole({
      ...baseArgs,
      title: "T",
      parentThreadId: "th_parent",
    });

    expect(result.candidate.provider).toBe("p1");
    expect(result.level).toBe("medium");
    expect(result.index).toBe(0);
    expect(result.child.id).toBe("th_child_1");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      projectId: "proj_1",
      providerId: "p1",
      model: "m1-medium",
      reasoningLevel: "medium",
      permissionMode: "full",
      title: "T",
      parentThreadId: "th_parent",
      environment: { type: "reuse", environmentId: "env_x" },
      prompt: "do it",
    });

    const record = spawned.get("th_child_1");
    expect(record?.stage).toBe("active");
    expect(record?.roleId).toBe("builder");
    expect(record?.candidateIndex).toBe(0);
    // The response's own environment id, not the "env_x" passed to spawn.
    expect(record?.environmentId).toBe("env_for_th_child_1");
  });

  it("a reasoning override changes both the resolved model and the reasoning level", async () => {
    const { spawner, spawnCalls } = setup({ byProvider: { p1: okQuota(), p2: okQuota() } });

    const result = await spawner.spawnByRole({ ...baseArgs, reasoningOverride: "high" });

    expect(result.level).toBe("high");
    expect(spawnCalls[0]).toMatchObject({ model: "m1-high", reasoningLevel: "high" });
  });

  it("throws AllCandidatesExhausted with one evaluation per candidate when every candidate is skipped", async () => {
    const { spawner } = setup({
      byProvider: {
        p1: { status: "unauthenticated", pools: [], fetchedAtMs: 0 },
        p2: { status: "expired", pools: [], fetchedAtMs: 0 },
      },
    });

    let caught: unknown;
    try {
      await spawner.spawnByRole(baseArgs);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AllCandidatesExhausted);
    const exhausted = caught as AllCandidatesExhausted;
    expect(exhausted.evaluations).toHaveLength(2);
    expect(exhausted.evaluations.map((e) => e.candidate.provider)).toEqual(["p1", "p2"]);
  });
});

describe("respawn watcher (turn.failed with a blocked rate limit)", () => {
  it("cancels the retry, respawns on the next candidate, messages the parent once, and archives the dead child", async () => {
    const { harness, spawner, spawned, spawnCalls, sendCalls, archiveCalls, execCalls, blocks } =
      setup({ byProvider: { p1: okQuota(), p2: okQuota() } });

    await spawner.spawnByRole({ ...baseArgs, title: "T", parentThreadId: "th_parent" });

    async function fire() {
      return harness.behavior.emitThreadEvent(
        "turn.failed",
        makeTurnFailedEvent({
          threadId: "th_child_1",
          rateLimits: {
            kind: "subscription-window",
            overageReason: null,
            overageStatus: null,
            providerId: "p1",
            reachedReason: null,
            status: "blocked",
            windows: [
              { label: "5h", providerKey: null, resetsAtMs: 1000, status: "blocked" },
              { label: "weekly", providerKey: null, resetsAtMs: 5000, status: "blocked" },
            ],
          },
        }),
      );
    }

    await fire();

    expect(execCalls).toEqual([["bb", ["provider-retry", "cancel", "th_child_1"]]]);
    expect(blocks.recordCalls).toEqual([["p1", 5000]]); // the LATEST resetsAtMs across windows

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]).toMatchObject({
      providerId: "p2",
      model: "m2",
      projectId: "proj_1",
      prompt: "do it",
      title: "T",
      parentThreadId: "th_parent",
      environment: { type: "reuse", environmentId: "env_for_th_child_1" },
    });

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toMatchObject({ threadId: "th_parent" });

    expect(archiveCalls).toEqual([{ threadId: "th_child_1" }]);

    const dead = spawned.get("th_child_1");
    expect(dead?.stage).toBe("replaced");
    expect(dead?.replacedBy).toBe("th_child_2");
    const next = spawned.get("th_child_2");
    expect(next?.stage).toBe("active");
    expect(next?.candidateIndex).toBe(1);

    // A second, identical event is a no-op: the dead record is no longer active.
    await fire();
    expect(execCalls).toHaveLength(1);
    expect(spawnCalls).toHaveLength(2);
    expect(sendCalls).toHaveLength(1);
    expect(archiveCalls).toHaveLength(1);
  });

  it("messages the parent with the refusal and marks the record exhausted when no candidate is left", async () => {
    const { harness, spawner, spawned, spawnCalls, sendCalls, archiveCalls } = setup({
      byProvider: { p1: okQuota(), p2: { status: "expired", pools: [], fetchedAtMs: 0 } },
    });

    await spawner.spawnByRole({ ...baseArgs, title: "T", parentThreadId: "th_parent" });

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "th_child_1",
        rateLimits: {
          kind: "subscription-window",
          overageReason: null,
          overageStatus: null,
          providerId: "p1",
          reachedReason: null,
          status: "blocked",
          windows: [{ label: "5h", providerKey: null, resetsAtMs: null, status: "blocked" }],
        },
      }),
    );

    expect(spawnCalls).toHaveLength(1); // no respawn
    expect(archiveCalls).toHaveLength(0); // dead child kept, not archived
    expect(sendCalls).toHaveLength(1);
    const [sent] = sendCalls as [{ input: { text: string }[] }];
    expect(sent.input[0]!.text).toContain("p2 m2");

    expect(spawned.get("th_child_1")?.stage).toBe("exhausted");
  });

  it("ignores a blocked event on a thread this plugin never spawned", async () => {
    const { harness, spawnCalls, sendCalls, archiveCalls, execCalls } = setup({
      byProvider: { p1: okQuota(), p2: okQuota() },
    });

    await harness.behavior.emitThreadEvent(
      "turn.failed",
      makeTurnFailedEvent({
        threadId: "th_unrelated",
        rateLimits: {
          kind: "subscription-window",
          overageReason: null,
          overageStatus: null,
          providerId: "p1",
          reachedReason: null,
          status: "blocked",
          windows: [],
        },
      }),
    );

    expect(spawnCalls).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
    expect(archiveCalls).toHaveLength(0);
    expect(execCalls).toHaveLength(0);
  });
});

describe("respawn robustness: nothing may reject out of turn.failed", () => {
  const blockedEvent = makeTurnFailedEvent({
    threadId: "th_child_1",
    rateLimits: {
      kind: "subscription-window",
      overageReason: null,
      overageStatus: null,
      providerId: "p1",
      reachedReason: null,
      status: "blocked",
      windows: [{ label: "5h", providerKey: null, resetsAtMs: 1000, status: "blocked" }],
    },
  });

  function customSetup(opts: {
    byProvider: Record<string, ProviderQuota>;
    archiveImpl?: () => Promise<void>;
    blocksRecordImpl?: () => Promise<void>;
  }) {
    const spawnCalls: unknown[] = [];
    const sendCalls: unknown[] = [];
    const archiveCalls: unknown[] = [];
    let nextChildId = 1;

    const { bb, harness } = createFakePluginHost({
      pluginId: "roles-test-robust",
      sdk: {
        threads: {
          // biome-ignore lint: test double
          spawn: async (args: any) => {
            spawnCalls.push(args);
            const id = `th_child_${nextChildId++}`;
            return makeThreadResponse({ id, environmentId: `env_for_${id}` });
          },
          // biome-ignore lint: test double
          send: async (args: any) => {
            sendCalls.push(args);
            return {} as never;
          },
          // biome-ignore lint: test double
          archive: async (args: any) => {
            archiveCalls.push(args);
            if (opts.archiveImpl) await opts.archiveImpl();
            return {} as never;
          },
        },
        environments: {
          get: async () => ({ projectId: "proj_1" }) as never,
        },
      },
    });

    const store = createRoleStore(bb);
    store.create(builderRole);
    const quota = fakeQuotaReader(opts.byProvider);
    const blocks: BlockRegistry = {
      async record() {
        if (opts.blocksRecordImpl) await opts.blocksRecordImpl();
      },
      async isHeld() {
        return false;
      },
      async heldUntil() {
        return null;
      },
    };
    const spawned = createSpawnedRegistry(bb);
    const settings = { get: async () => ({ thresholdPercent: 5 }) };
    const execFn = async () => ({ stdout: "" });
    const spawner = createSpawner({ bb, store, quota, blocks, spawned, settings, execFn });

    return { harness, store, spawned, spawner, spawnCalls, sendCalls, archiveCalls };
  }

  it("an archive failure after a successful respawn keeps stage replaced and sends no second message", async () => {
    const { harness, spawner, spawned, spawnCalls, sendCalls, archiveCalls } = customSetup({
      byProvider: { p1: okQuota(), p2: okQuota() },
      archiveImpl: async () => {
        throw new Error("archive down");
      },
    });

    await spawner.spawnByRole({ ...baseArgs, title: "T", parentThreadId: "th_parent" });
    await harness.behavior.emitThreadEvent("turn.failed", blockedEvent);

    expect(archiveCalls).toHaveLength(1); // attempted, and failed
    expect(spawnCalls).toHaveLength(2); // the respawn itself succeeded
    expect(sendCalls).toHaveLength(1); // exactly one message, not a second on the archive failure
    const dead = spawned.get("th_child_1");
    expect(dead?.stage).toBe("replaced");
    expect(dead?.replacedBy).toBe("th_child_2");
  });

  it("blocks.record rejecting stages the record failed with one message and no respawn attempt", async () => {
    const { harness, spawner, spawned, spawnCalls, sendCalls } = customSetup({
      byProvider: { p1: okQuota(), p2: okQuota() },
      blocksRecordImpl: async () => {
        throw new Error("kv down");
      },
    });

    await spawner.spawnByRole({ ...baseArgs, title: "T", parentThreadId: "th_parent" });
    await harness.behavior.emitThreadEvent("turn.failed", blockedEvent);

    expect(spawnCalls).toHaveLength(1); // no respawn attempt
    expect(sendCalls).toHaveLength(1);
    expect(spawned.get("th_child_1")?.stage).toBe("failed");
  });

  it("a role deleted before respawn stages the record failed with one message", async () => {
    const { harness, spawner, store, spawned, spawnCalls, sendCalls } = customSetup({
      byProvider: { p1: okQuota(), p2: okQuota() },
    });

    await spawner.spawnByRole({ ...baseArgs, title: "T", parentThreadId: "th_parent" });
    store.remove("builder");
    await harness.behavior.emitThreadEvent("turn.failed", blockedEvent);

    expect(spawnCalls).toHaveLength(1); // no respawn attempt: the role is gone
    expect(sendCalls).toHaveLength(1);
    expect(spawned.get("th_child_1")?.stage).toBe("failed");
  });
});
