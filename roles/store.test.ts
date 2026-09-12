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
      "advisor",
      "scout",
      "builder",
      "apprentice",
      "reviewer",
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

  it("round-trips a role brief through storage and export/import", () => {
    const source = createFakePluginHost({ pluginId: "roles-test-brief-source" });
    const sourceStore = createRoleStore(source.bb);
    sourceStore.create({ id: "builder", description: "Builds.", brief: "One unit.", permissionMode: "full", candidates: [{ provider: "p", model: "m", reasoningLevel: "medium" }] });
    const exported = sourceStore.exportAll();
    expect(exported.roles[0]?.brief).toBe("One unit.");

    const target = createFakePluginHost({ pluginId: "roles-test-brief-target" });
    const targetStore = createRoleStore(target.bb);
    targetStore.importAll(exported);
    expect(targetStore.get("builder")?.brief).toBe("One unit.");
  });

  it("importAll upserts a role present in the document and updates its fields", () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test-c" });
    const store = createRoleStore(bb);
    store.seedOnce();
    const before = store.list();

    store.importAll({
      version: 1,
      roles: before.map((role) =>
        role.id === "scout" ? { ...role, description: "A rewritten scout description." } : role,
      ),
    });

    expect(store.list()).toHaveLength(5);
    expect(store.get("scout")?.description).toBe(
      "A rewritten scout description.",
    );
    expect(store.get("builder")).not.toBeNull();
  });

  it("importAll replaces the whole set: a role missing from the document is deleted", () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test-replace" });
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

    expect(store.list()).toHaveLength(1);
    expect(store.get("scout")?.description).toBe(
      "A rewritten scout description.",
    );
    expect(store.get("builder")).toBeNull();
  });

  it("import replaces positions with document order", () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test-order" });
    const store = createRoleStore(bb);
    store.seedOnce();
    const before = store.list();
    const reversed = [...before].reverse();

    store.importAll({ version: 1, roles: reversed });

    expect(store.list().map((role) => role.id)).toEqual(reversed.map((role) => role.id));
  });

  it("seeded store with scout deleted, exported, then imported into a freshly-seeded host reproduces exactly those roles", () => {
    const source = createFakePluginHost({ pluginId: "roles-test-import-source" });
    const sourceStore = createRoleStore(source.bb);
    sourceStore.seedOnce();
    sourceStore.remove("scout");
    const exported = sourceStore.exportAll();
    expect(exported.roles.map((role) => role.id)).not.toContain("scout");

    const target = createFakePluginHost({ pluginId: "roles-test-import-target" });
    const targetStore = createRoleStore(target.bb);
    targetStore.seedOnce(); // the normal plugin-load path: seed a fresh host first
    targetStore.importAll(exported);

    expect(targetStore.list()).toEqual(exported.roles);
    expect(targetStore.get("scout")).toBeNull();
  });

  it("importAll into a database that was never seeded marks it seeded, so a later seedOnce() is a no-op", () => {
    const { bb } = createFakePluginHost({ pluginId: "roles-test-import-unseeded" });
    const store = createRoleStore(bb);
    const doc = { version: 1 as const, roles: [
      {
        id: "custom",
        description: "A hand-authored role.",
        permissionMode: "full" as const,
        candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" as const }],
      },
    ] };

    store.importAll(doc); // no seedOnce() call before this
    store.seedOnce(); // must be a no-op: the import already marked the database seeded

    expect(store.list()).toEqual(doc.roles);
  });
});
