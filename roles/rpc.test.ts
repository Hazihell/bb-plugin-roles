import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerRoleRpc, rpcContract } from "./rpc";
import { createRoleStore } from "./store";
import { DEFAULT_DELEGATION_RULE } from "./rule";

const builderCandidate = { provider: "p1", model: "m1", reasoningLevel: "medium" as const };

// biome-ignore lint: test double, sdk stub shape isn't the point
function setup(sdk: any = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "roles-rpc-test", sdk });
  const store = createRoleStore(bb);
  // Mirrors server.ts: every store write, from either surface, publishes.
  store.onChange(() => bb.realtime.publish("roles-changed", {}));
  registerRoleRpc(bb, {
    store,
    settings: {
      async experimental_set() {
        return { delegationRule: DEFAULT_DELEGATION_RULE };
      },
    },
  });
  return { bb, harness, store };
}

async function callRpc<Method extends keyof typeof rpcContract>(
  harness: ReturnType<typeof setup>["harness"],
  method: Method,
  input: unknown,
) {
  return harness.behavior.callRpc(method as string, input);
}

describe("listRoles", () => {
  it("returns roles in store order", async () => {
    const { harness, store } = setup();
    store.create({ id: "a", description: "A", permissionMode: "full", candidates: [builderCandidate] });
    store.create({ id: "b", description: "B", permissionMode: "full", candidates: [builderCandidate] });

    const result = await callRpc(harness, "listRoles", null);
    expect(result).toMatchObject([{ id: "a" }, { id: "b" }]);
  });
});

describe("saveRole", () => {
  it("creates a role through the store", async () => {
    const { harness, store } = setup();

    const result = (await callRpc(harness, "saveRole", {
      role: { id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] },
      mode: "create",
    })) as { role: { id: string }; warnings: string[] };

    expect(result.role.id).toBe("builder");
    expect(result.warnings).toEqual([]);
    expect(store.get("builder")).not.toBeNull();
  });

  it("saves and clears a role brief", async () => {
    const { harness, store } = setup();
    await callRpc(harness, "saveRole", {
      role: { id: "builder", description: "Builds.", brief: "One unit.", permissionMode: "full", candidates: [builderCandidate] },
      mode: "create",
    });
    expect(store.get("builder")?.brief).toBe("One unit.");
    await callRpc(harness, "saveRole", {
      role: { id: "builder", description: "Builds.", brief: null, permissionMode: "full", candidates: [builderCandidate] },
      mode: "update",
    });
    expect(store.get("builder")?.brief).toBeUndefined();
  });

  it("updates a role through the store, including a candidate reorder", async () => {
    const { harness, store } = setup();
    store.create({
      id: "builder",
      description: "Builds.",
      permissionMode: "full",
      candidates: [
        { provider: "p1", model: "m1", reasoningLevel: "medium" },
        { provider: "p2", model: "m2", reasoningLevel: "high" },
      ],
    });

    const result = (await callRpc(harness, "saveRole", {
      role: {
        id: "builder",
        description: "Builds things.",
        permissionMode: "full",
        candidates: [
          { provider: "p2", model: "m2", reasoningLevel: "high" },
          { provider: "p1", model: "m1", reasoningLevel: "medium" },
        ],
      },
      mode: "update",
    })) as { role: { candidates: unknown[] } };

    expect(result.role.candidates).toEqual([
      { provider: "p2", model: "m2", reasoningLevel: "high" },
      { provider: "p1", model: "m1", reasoningLevel: "medium" },
    ]);
    expect(store.get("builder")?.candidates).toEqual(result.role.candidates);
    expect(store.get("builder")?.description).toBe("Builds things.");
  });

  it("saves and warns, never blocks, when a candidate model is absent from the live list", async () => {
    const { harness, store } = setup({
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
    });

    const result = (await callRpc(harness, "saveRole", {
      role: { id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] },
      mode: "create",
    })) as { role: { id: string }; warnings: string[] };

    expect(store.get("builder")).not.toBeNull();
    expect(result.warnings).toEqual(['p1 has no model "m1" in its live list']);
  });

  it("publishes roles-changed on write", async () => {
    const { harness } = setup();

    await callRpc(harness, "saveRole", {
      role: { id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] },
      mode: "create",
    });

    expect(harness.inspection.realtimeSignals).toContainEqual({ channel: "roles-changed", payload: {} });
  });

  it("clears a role's instruction when updated with a blank one", async () => {
    const { harness, store } = setup();

    await callRpc(harness, "saveRole", {
      role: {
        id: "builder",
        description: "Builds.",
        permissionMode: "full",
        instruction: "Be terse.",
        candidates: [builderCandidate],
      },
      mode: "create",
    });
    expect(store.get("builder")?.instruction).toBe("Be terse.");

    await callRpc(harness, "saveRole", {
      role: {
        id: "builder",
        description: "Builds.",
        permissionMode: "full",
        instruction: null,
        candidates: [builderCandidate],
      },
      mode: "update",
    });

    expect(store.get("builder")?.instruction).toBeUndefined();
  });
});

describe("deleteRole", () => {
  it("removes a role through the store and reports whether one was removed", async () => {
    const { harness, store } = setup();
    store.create({ id: "builder", description: "Builds.", permissionMode: "full", candidates: [builderCandidate] });

    const removed = await callRpc(harness, "deleteRole", { id: "builder" });
    expect(removed).toEqual({ deleted: true });
    expect(store.get("builder")).toBeNull();

    const missing = await callRpc(harness, "deleteRole", { id: "builder" });
    expect(missing).toEqual({ deleted: false });
  });
});

describe("checkModels", () => {
  it("reports known: false only for a candidate absent from its provider's live list", async () => {
    const { harness } = setup({
      system: {
        // biome-ignore lint: test double
        executionOptions: async () =>
          ({
            modelLoadError: null,
            permissionCeiling: "full",
            providers: [{ id: "p1" }],
            models: [{ id: "m1", model: "m1" }],
            selectedOnlyModels: [],
            // biome-ignore lint: test double
          }) as any,
      },
    });

    const result = await callRpc(harness, "checkModels", {
      candidates: [
        { provider: "p1", model: "m1", reasoningLevel: "medium" },
        { provider: "p1", model: "missing", reasoningLevel: "medium" },
      ],
    });

    expect(result).toEqual([
      { index: 0, provider: "p1", model: "m1", resolvedModel: "m1", known: true },
      { index: 1, provider: "p1", model: "missing", resolvedModel: "missing", known: false },
    ]);
  });
});

describe("listProviderModels", () => {
  it("reports each provider's live models, and an empty list for one that can't be read", async () => {
    const { harness } = setup({
      system: {
        // biome-ignore lint: test double
        executionOptions: async (args?: { providerId?: string }) => {
          if (args?.providerId === "p2") throw new Error("provider unavailable");
          return {
            modelLoadError: null,
            permissionCeiling: "full",
            providers: [{ id: "p1" }, { id: "p2" }],
            models: [{ id: "m1", model: "m1" }],
            selectedOnlyModels: [{ id: "m2", model: "m2" }],
            // biome-ignore lint: test double
          } as any;
        },
      },
    });

    const result = await callRpc(harness, "listProviderModels", null);

    expect(result).toEqual([
      { provider: "p1", models: ["m1", "m2"] },
      { provider: "p2", models: [] },
    ]);
  });
});
