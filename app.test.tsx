// @vitest-environment jsdom
//
// Frontend contract for the roles settings page (app.tsx → components/roles/*).
// The RPC stub below is a small in-memory fake of roles/rpc.ts's contract:
// it mutates its own role list on save/delete so a component under test sees
// the same read-your-write behavior the real backend gives it, and records
// every saveRole call so tests can assert on exactly what was sent.
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { rpcContract } from "./roles/rpc";
import type { Role, SaveRoleInput } from "./roles/schema";

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
  const saveCalls: { role: SaveRoleInput; mode: "create" | "update" }[] = [];
  const handlers: PluginRpcTestHandlers<typeof rpcContract> = {
    listRoles: () => roles,
    saveRole: ({ role, mode }) => {
      saveCalls.push({ role, mode });
      // Mirrors roles/rpc.ts: `null` clears the instruction rather than
      // leaving a stale one in place. An explicit `undefined` key isn't a
      // JSON value, so a cleared instruction has to be dropped entirely
      // rather than merely nulled out.
      const { instruction, ...withoutInstruction } = role;
      const normalized: Role = instruction === null || instruction === undefined ? withoutInstruction : { ...withoutInstruction, instruction };
      roles =
        mode === "create"
          ? [...roles, normalized]
          : roles.map((existing) => (existing.id === normalized.id ? normalized : existing));
      return { role: normalized, warnings: [] };
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
  return {
    handlers,
    saveCalls,
    getRoles: () => roles,
    /** Simulates a durable write the ephemeral realtime signal wouldn't replay. */
    setRoles: (next: Role[]) => {
      roles = next;
    },
  };
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

  it("clears an existing instruction by sending null, not by omitting the field", async () => {
    const role = makeRole({ id: "builder", instruction: "Be terse." });
    const { slot, stub } = await renderRolesSection([role]);
    await slot.findByText("builder");

    fireEvent.click(slot.getByRole("button", { name: "Edit builder" }));
    const instructionField = await slot.findByLabelText("Instruction");
    expect((instructionField as HTMLTextAreaElement).value).toBe("Be terse.");
    fireEvent.change(instructionField, { target: { value: "  " } });

    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(stub.saveCalls).toHaveLength(1));
    expect(stub.saveCalls[0]?.role.instruction).toBeNull();
  });

  it("refetches the list on a reconnect, but not on the first connection", async () => {
    const { slot, stub } = await renderRolesSection([makeRole({ id: "builder", description: "Builds things." })]);
    await slot.findByText("builder");

    // The default fixture starts "connected" — this is the first connection
    // the mount effect already covers, so it must not trigger a second fetch.
    stub.setRoles([makeRole({ id: "builder", description: "Builds better things." })]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.queryByText("Builds better things.")).toBeNull();

    // A reconnect (a transition INTO "connected", not the first one) has to
    // reconcile state the ephemeral realtime signal wouldn't have replayed.
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");

    await slot.findByText("Builds better things.");
  });

  it("ignores a stale checkModels response for the list view that resolves after a newer one", async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    let checkCalls = 0;
    const role = makeRole({
      id: "builder",
      candidates: [{ provider: "p1", model: "m1", reasoningLevel: "medium" }],
    });
    const handlers: PluginRpcTestHandlers<typeof rpcContract> = {
      listRoles: () => [role],
      saveRole: () => {
        throw new Error("not used in this test");
      },
      deleteRole: () => ({ deleted: false }),
      checkModels: ({ candidates }) => {
        checkCalls += 1;
        const isFirstCall = checkCalls === 1;
        return new Promise<void>((resolve) => {
          if (isFirstCall) resolveFirst = resolve;
          else resolveSecond = resolve;
        }).then(() =>
          // The stale first check reports "unknown"; the fresh second one
          // reports "known" — only the second result may reach the UI.
          candidates.map((candidate, index) => ({
            index,
            provider: candidate.provider,
            model: candidate.model,
            resolvedModel: candidate.model,
            known: !isFirstCall,
          })),
        );
      },
    };
    const app = await loadPluginApp(() => import("./app"));
    const registration = app.settingsSections[0];
    if (registration === undefined) throw new Error("settingsSection not registered");
    const slot = renderSlot(registration, {}, { rpc: handlers });
    await slot.findByText("builder");
    // The mount effect starts the first (soon-to-be-stale) check.
    await waitFor(() => expect(resolveFirst).toBeDefined());

    // The realtime "roles-changed" signal fires a second list load — and a
    // second check — before the first one has resolved.
    await act(async () => {
      await slot.behavior.emitRealtime("roles-changed", {});
    });
    await waitFor(() => expect(resolveSecond).toBeDefined());

    // Resolve out of order: the newer check settles first...
    await act(async () => {
      resolveSecond?.();
      await Promise.resolve();
    });
    // ...then the stale one, which must not override the fresh result.
    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
    });

    expect(slot.queryByLabelText("Unknown model for candidate 1")).toBeNull();
  });

  it("ignores a stale checkModels response that resolves after a newer one", async () => {
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    let calls = 0;
    const handlers: PluginRpcTestHandlers<typeof rpcContract> = {
      listRoles: () => [],
      saveRole: () => {
        throw new Error("not used in this test");
      },
      deleteRole: () => ({ deleted: false }),
      checkModels: ({ candidates }) => {
        calls += 1;
        const isFirstCall = calls === 1;
        return new Promise<void>((resolve) => {
          if (isFirstCall) resolveFirst = resolve;
          else resolveSecond = resolve;
        }).then(() =>
          // The stale first check reports "unknown"; the fresh second one
          // reports "known" — only the second result may reach the UI.
          candidates.map((candidate, index) => ({
            index,
            provider: candidate.provider,
            model: candidate.model,
            resolvedModel: candidate.model,
            known: !isFirstCall,
          })),
        );
      },
    };
    const app = await loadPluginApp(() => import("./app"));
    const registration = app.settingsSections[0];
    if (registration === undefined) throw new Error("settingsSection not registered");
    const slot = renderSlot(registration, {}, { rpc: handlers });
    await slot.findByText("No roles yet.");

    fireEvent.click(slot.getByRole("button", { name: /add role/i }));
    fireEvent.change(await slot.findByLabelText("Id"), { target: { value: "builder" } });
    fireEvent.change(slot.getByLabelText("Description"), { target: { value: "Builds things." } });
    fireEvent.change(slot.getByLabelText("Candidate 1 provider"), { target: { value: "p1" } });
    fireEvent.change(slot.getByLabelText("Candidate 1 model"), { target: { value: "m1" } });
    // Wait past the 400ms debounce so the first (soon-to-be-stale) check fires.
    await waitFor(() => expect(resolveFirst).toBeDefined(), { timeout: 1000 });

    fireEvent.change(slot.getByLabelText("Candidate 1 model"), { target: { value: "m2" } });
    // Wait past the debounce again so the second, current check fires.
    await waitFor(() => expect(resolveSecond).toBeDefined(), { timeout: 1000 });

    // Resolve out of order: the newer check settles first...
    await act(async () => {
      resolveSecond?.();
      await Promise.resolve();
    });
    // ...then the stale one, which must not override the fresh result.
    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
    });

    expect(slot.queryByLabelText("Candidate 1 has no matching live model")).toBeNull();
  });

  it("discards a checkModels response for candidates that changed while it was in flight", async () => {
    let resolveFirst: (() => void) | undefined;
    let checkCalls = 0;
    const handlers: PluginRpcTestHandlers<typeof rpcContract> = {
      listRoles: () => [],
      saveRole: () => {
        throw new Error("not used in this test");
      },
      deleteRole: () => ({ deleted: false }),
      checkModels: ({ candidates }) => {
        checkCalls += 1;
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }).then(() =>
          // Reports the candidate unknown — if this stale response is ever
          // applied it shows a marker a fresh check for "m2" would not.
          candidates.map((candidate, index) => ({
            index,
            provider: candidate.provider,
            model: candidate.model,
            resolvedModel: candidate.model,
            known: false,
          })),
        );
      },
    };
    const app = await loadPluginApp(() => import("./app"));
    const registration = app.settingsSections[0];
    if (registration === undefined) throw new Error("settingsSection not registered");
    const slot = renderSlot(registration, {}, { rpc: handlers });
    await slot.findByText("No roles yet.");

    fireEvent.click(slot.getByRole("button", { name: /add role/i }));
    fireEvent.change(await slot.findByLabelText("Id"), { target: { value: "builder" } });
    fireEvent.change(slot.getByLabelText("Description"), { target: { value: "Builds things." } });
    fireEvent.change(slot.getByLabelText("Candidate 1 provider"), { target: { value: "p1" } });
    fireEvent.change(slot.getByLabelText("Candidate 1 model"), { target: { value: "m1" } });
    // Wait past the 400ms debounce so the request for "m1" fires and is in flight.
    await waitFor(() => expect(resolveFirst).toBeDefined(), { timeout: 1000 });

    // Change the candidate while that request is still in flight. This must
    // invalidate it immediately, not only once a second debounced request
    // for "m2" fires.
    fireEvent.change(slot.getByLabelText("Candidate 1 model"), { target: { value: "m2" } });

    // Resolve the stale "m1" request right away, well inside the new
    // debounce window — before any second request has even been sent.
    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
    });

    expect(slot.queryByLabelText("Candidate 1 has no matching live model")).toBeNull();
    expect(checkCalls).toBe(1);
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
