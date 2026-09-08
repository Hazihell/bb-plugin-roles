// roles/rpc.ts — the frontend data plane for the roles settings page
// (components/roles/*, registered in app.tsx). Handlers read and write
// through the same RoleStore instance the CLI uses (roles/cli.ts), so a
// write from either surface fires the store's one `onChange` (wired to
// `bb.realtime.publish("roles-changed", …)` in server.ts) and both surfaces
// stay consistent.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { findMissingModels } from "./models";
import { candidateSchema, roleSchema } from "./schema";
import type { RoleStore } from "./store";

const modelCheckResultSchema = z.object({
  index: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string(),
  resolvedModel: z.string(),
  known: z.boolean(),
});

export const rpcContract = defineRpcContract({
  listRoles: {
    input: z.null(),
    output: z.array(roleSchema),
  },
  saveRole: {
    input: z
      .object({
        role: roleSchema,
        mode: z.enum(["create", "update"]),
      })
      .strict(),
    output: z.object({
      role: roleSchema,
      warnings: z.array(z.string()),
    }),
  },
  deleteRole: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  checkModels: {
    input: z.object({ candidates: z.array(candidateSchema) }).strict(),
    output: z.array(modelCheckResultSchema),
  },
});

export interface RoleRpcDeps {
  store: RoleStore;
}

/**
 * `saveRole` never blocks on the model check: an unknown model comes back
 * as a warning alongside the saved role, the same "warn, never block"
 * contract `bb roles create`/`update` use on the CLI.
 */
export function registerRoleRpc(bb: BbPluginApi, deps: RoleRpcDeps): void {
  bb.rpc.register(rpcContract, {
    listRoles() {
      return deps.store.list();
    },
    async saveRole({ role, mode }) {
      const saved = mode === "create" ? deps.store.create(role) : deps.store.update(role.id, role);
      const results = await findMissingModels(bb, saved.candidates);
      const warnings = results
        .filter((result) => !result.known)
        .map((result) => `${result.provider} has no model "${result.resolvedModel}" in its live list`);
      return { role: saved, warnings };
    },
    deleteRole({ id }) {
      return { deleted: deps.store.remove(id) };
    },
    checkModels({ candidates }) {
      return findMissingModels(bb, candidates);
    },
  });
}
