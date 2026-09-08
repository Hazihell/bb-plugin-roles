import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRoleStore } from "./store";

describe("createRoleStore", () => {
  it("seeds the cast exactly once", () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);

    store.seedOnce();
    expect(store.list()).toHaveLength(5);
    expect(store.list().map((role) => role.id)).toEqual([
      "scout",
      "builder",
      "designer",
      "reviewer",
      "advisor",
    ]);

    // Calling it again is a no-op: still 5, unchanged.
    store.seedOnce();
    expect(store.list()).toHaveLength(5);

    // Deleting every role and reseeding never brings them back.
    for (const role of store.list()) store.remove(role.id);
    expect(store.list()).toHaveLength(0);
    store.seedOnce();
    expect(store.list()).toHaveLength(0);
  });

  it("round-trips export then import on a fresh store", () => {
    const source = createFakePluginHost({ pluginId: "roles-test-a" });
    const sourceStore = createRoleStore(source.bb);
    sourceStore.seedOnce();
    const exported = sourceStore.exportAll();

    const target = createFakePluginHost({ pluginId: "roles-test-b" });
    const targetStore = createRoleStore(target.bb);
    // No seedOnce() here: import alone should reproduce the roles.
    targetStore.importAll(exported);

    expect(targetStore.list()).toEqual(sourceStore.list());
  });

  it("importAll upserts by id and keeps other roles", () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test-c" });
    const store = createRoleStore(bb);
    store.seedOnce();
    const before = store.list();

    store.importAll({
      version: 1,
      roles: [
        {
          id: "scout",
          description: "A rewritten scout description.",
          permissionMode: "full",
          candidates: before[0]!.candidates,
        },
      ],
    });

    expect(store.list()).toHaveLength(5);
    expect(store.get("scout")?.description).toBe(
      "A rewritten scout description.",
    );
    expect(store.get("builder")).not.toBeNull();
  });
});
