import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerMentions } from "./mention";
import { createRoleStore } from "./store";

function setup() {
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
    candidates: [{ provider: "codex", model: "m", reasoningLevel: "low" }],
  });
  registerMentions({ bb, store });

  const provider = harness.registrations.mentionProviders[0]!;
  return { provider };
}

describe("registerMentions", () => {
  it("registers one @-triggered provider labeled Roles", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "roles-test" });
    const store = createRoleStore(bb);
    registerMentions({ bb, store });

    expect(harness.registrations.mentionProviders).toHaveLength(1);
    const provider = harness.registrations.mentionProviders[0]!;
    expect(provider.id).toBe("roles");
    expect(provider.label).toBe("Roles");
    expect(provider.triggers).toEqual(["@"]);
  });

  it("search returns every role for an empty query", async () => {
    const { provider } = setup();
    const items = await provider.search({ trigger: "@", query: "", projectId: null, threadId: null });
    expect(items.map((item) => item.id).sort()).toEqual(["builder", "scout"]);
    expect(items.find((item) => item.id === "builder")?.subtitle).toBe("Implementation work.");
  });

  it("search filters by id or description substring", async () => {
    const { provider } = setup();
    const byId = await provider.search({ trigger: "@", query: "scou", projectId: null, threadId: null });
    expect(byId.map((item) => item.id)).toEqual(["scout"]);

    const byDescription = await provider.search({
      trigger: "@",
      query: "implementation",
      projectId: null,
      threadId: null,
    });
    expect(byDescription.map((item) => item.id)).toEqual(["builder"]);
  });

  it("resolve renders the description and a filled spawn line", async () => {
    const { provider } = setup();
    const resolved = await provider.resolve("builder");
    expect(resolved.context).toContain("Role **builder**: Implementation work.");
    expect(resolved.context).toContain("bb roles spawn --role builder");
  });

  it("resolve throws for an unknown role id, blocking the send", () => {
    const { provider } = setup();
    expect(() => provider.resolve("no-such-role")).toThrow();
  });
});
