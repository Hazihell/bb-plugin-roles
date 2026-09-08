// @vitest-environment jsdom
//
// Frontend contract for the roles settings page (app.tsx → components/roles/*).
// The RPC stub below is a small in-memory fake of roles/rpc.ts's contract:
// it mutates its own role list on save/delete so a component under test sees
// the same read-your-write behavior the real backend gives it, and records
// every saveRole call so tests can assert on exactly what was sent.
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { rpcContract } from "./roles/rpc";
import type { Role } from "./roles/schema";

// This suite isn't run with vitest's `globals` option, so Testing Library's
// automatic per-test cleanup never registers — without this, each test's
// dialog and card render on top of the last one still in `document.body`.
afterEach(cleanup);

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: "builder",
    description: "Builds things.",
    permissionMode: "full",
    candidates: [{ provider: "p1", model: "m1", reasoningLevel: "medium" }],
    ...overrides,
  };
}

/**
 * A model named "missing" is reported unknown; every other model is known.
 * That's the only signal the settings page's live check (checkModels) needs
 * from a fake — the real check's own logic is covered in roles/rpc.test.ts.
 */
function createRolesRpcStub(initialRoles: Role[]) {
  let roles = initialRoles;
  const saveCalls: { role: Role; mode: "create" | "update" }[] = [];
  const handlers: PluginRpcTestHandlers<typeof rpcContract> = {
    listRoles: () => roles,
    saveRole: ({ role, mode }) => {
      saveCalls.push({ role, mode });
      roles = mode === "create" ? [...roles, role] : roles.map((existing) => (existing.id === role.id ? role : existing));
      return { role, warnings: [] };
    },
    deleteRole: ({ id }) => {
      const existed = roles.some((role) => role.id === id);
      roles = roles.filter((role) => role.id !== id);
      return { deleted: existed };
    },
    checkModels: ({ candidates }) =>
      candidates.map((candidate, index) => ({
        index,
        provider: candidate.provider,
        model: candidate.model,
        resolvedModel: candidate.model,
        known: candidate.model !== "missing",
      })),
  };
  return { handlers, saveCalls, getRoles: () => roles };
}

async function renderRolesSection(initialRoles: Role[] = []) {
  const app = await loadPluginApp(() => import("./app"));
  const registration = app.settingsSections[0];
  if (registration === undefined) throw new Error("settingsSection not registered");
  const stub = createRolesRpcStub(initialRoles);
  const slot = renderSlot(registration, {}, { rpc: stub.handlers });
  return { slot, stub };
}

describe("roles settings section", () => {
  it("lists roles from the RPC stub", async () => {
    const { slot } = await renderRolesSection([
      makeRole({ id: "builder", description: "Builds things." }),
      makeRole({ id: "reviewer", description: "Reviews things." }),
    ]);

    await slot.findByText("builder");
    expect(slot.getByText("Builds things.")).toBeTruthy();
    expect(slot.getByText("reviewer")).toBeTruthy();
    expect(slot.getByText("Reviews things.")).toBeTruthy();
  });

  it("saves the form via saveRole and refetches the list on the realtime signal", async () => {
    const { slot, stub } = await renderRolesSection([]);
    await slot.findByText("No roles yet.");

    fireEvent.click(slot.getByRole("button", { name: /add role/i }));

    fireEvent.change(await slot.findByLabelText("Id"), { target: { value: "builder" } });
    fireEvent.change(slot.getByLabelText("Description"), { target: { value: "Builds things." } });
    fireEvent.change(slot.getByLabelText("Candidate 1 provider"), { target: { value: "p1" } });
    fireEvent.change(slot.getByLabelText("Candidate 1 model"), { target: { value: "m1" } });

    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(stub.saveCalls).toHaveLength(1));
    expect(stub.saveCalls[0]).toMatchObject({
      mode: "create",
      role: {
        id: "builder",
        description: "Builds things.",
        candidates: [{ provider: "p1", model: "m1", reasoningLevel: "medium" }],
      },
    });

    // Saving alone doesn't refresh the list — only the server's realtime
    // signal does, whether the write came from this page or the CLI.
    expect(slot.queryByText("Builds things.")).toBeNull();

    await slot.behavior.emitRealtime("roles-changed", {});
    await slot.findByText("Builds things.");
  });

  it("sends a moved-down candidate order to saveRole", async () => {
    const role = makeRole({
      id: "builder",
      candidates: [
        { provider: "p1", model: "m1", reasoningLevel: "medium" },
        { provider: "p2", model: "m2", reasoningLevel: "high" },
      ],
    });
    const { slot, stub } = await renderRolesSection([role]);
    await slot.findByText("builder");

    fireEvent.click(slot.getByRole("button", { name: "Edit builder" }));
    await slot.findByLabelText("Candidate 1 provider");

    fireEvent.click(slot.getByRole("button", { name: "Move candidate 1 down" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(stub.saveCalls).toHaveLength(1));
    expect(stub.saveCalls[0]).toMatchObject({
      mode: "update",
      role: {
        candidates: [
          { provider: "p2", model: "m2", reasoningLevel: "high" },
          { provider: "p1", model: "m1", reasoningLevel: "medium" },
        ],
      },
    });
  });

  it("shows a warning for an unknown model and still proceeds to save", async () => {
    const { slot, stub } = await renderRolesSection([]);
    await slot.findByText("No roles yet.");

    fireEvent.click(slot.getByRole("button", { name: /add role/i }));
    fireEvent.change(await slot.findByLabelText("Id"), { target: { value: "builder" } });
    fireEvent.change(slot.getByLabelText("Description"), { target: { value: "Builds things." } });
    fireEvent.change(slot.getByLabelText("Candidate 1 provider"), { target: { value: "p1" } });
    fireEvent.change(slot.getByLabelText("Candidate 1 model"), { target: { value: "missing" } });

    await slot.findByLabelText("Candidate 1 has no matching live model", {}, { timeout: 2000 });

    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(stub.saveCalls).toHaveLength(1));
    expect(stub.saveCalls[0]?.role.candidates[0]).toMatchObject({ provider: "p1", model: "missing" });
  });
});
