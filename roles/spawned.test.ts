import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createSpawnedRegistry, type SpawnedRecord } from "./spawned";

function makeRecord(overrides: Partial<SpawnedRecord> = {}): SpawnedRecord {
  return {
    childThreadId: "th_child",
    roleId: "builder",
    candidateIndex: 0,
    prompt: "do the thing",
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

describe("createSpawnedRegistry", () => {
  it("loads every spawned/* row from KV into memory", async () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test" });
    const a = makeRecord({ childThreadId: "th_a" });
    const b = makeRecord({ childThreadId: "th_b" });
    await bb.storage.kv.set("spawned/th_a", a);
    await bb.storage.kv.set("spawned/th_b", b);

    const registry = createSpawnedRegistry(bb);
    expect(registry.list()).toEqual([]); // nothing loaded yet
    await registry.load();
    expect(registry.list().map((r) => r.childThreadId).sort()).toEqual(["th_a", "th_b"]);
    expect(registry.get("th_a")).toEqual(a);
    expect(registry.get("th_missing")).toBeNull();
  });

  it("put writes both the in-memory map and KV", async () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test" });
    const registry = createSpawnedRegistry(bb);
    const record = makeRecord();
    await registry.put(record);

    expect(registry.get("th_child")).toEqual(record);
    expect(await bb.storage.kv.get("spawned/th_child")).toEqual(record);
  });

  it("claim flips an active record to respawning and persists it", async () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test" });
    const registry = createSpawnedRegistry(bb);
    await registry.put(makeRecord());

    const claimed = await registry.claim("th_child");
    expect(claimed).toBe(true);
    expect(registry.get("th_child")?.stage).toBe("respawning");
    expect((await bb.storage.kv.get<SpawnedRecord>("spawned/th_child"))?.stage).toBe(
      "respawning",
    );
  });

  it("claim is false for a record that isn't active, or unknown", async () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test" });
    const registry = createSpawnedRegistry(bb);
    await registry.put(makeRecord({ stage: "replaced" }));

    expect(await registry.claim("th_child")).toBe(false);
    expect(await registry.claim("th_missing")).toBe(false);
  });

  it("claim is idempotent: a second concurrent claim on the same record fails", async () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test" });
    const registry = createSpawnedRegistry(bb);
    await registry.put(makeRecord());

    const [first, second] = await Promise.all([
      registry.claim("th_child"),
      registry.claim("th_child"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("load drops a malformed record, logging a warning, instead of throwing", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const good = makeRecord({ childThreadId: "th_good" });
    await bb.storage.kv.set("spawned/th_good", good);
    await bb.storage.kv.set("spawned/th_bad", { childThreadId: "th_bad", stage: "not-a-real-stage" });

    const registry = createSpawnedRegistry(bb);
    await registry.load();

    expect(registry.list().map((r) => r.childThreadId)).toEqual(["th_good"]);
    expect(registry.get("th_bad")).toBeNull();
    expect(harness.logEntries.some((entry) => entry.level === "warn" && entry.message.includes("th_bad"))).toBe(
      true,
    );
  });
});
