// roles/rpc.ts — the frontend data plane for the roles settings page
// (components/roles/*, registered in app.tsx). Handlers read and write
// through the same RoleStore instance the CLI uses (roles/cli.ts), so a
// write from either surface fires the store's one `onChange` (wired to
// `bb.realtime.publish("roles-changed", …)` in server.ts) and both surfaces
// stay consistent.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { findMissingModels, formatUnknownModelMessage } from "./models";
import { candidateSchema, roleSchema, saveRoleInputSchema, type Role } from "./schema";
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
        role: saveRoleInputSchema,
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
 * Forcing an update's `instruction` key to `undefined` (see `saveRole` below)
 * makes `roleSchema.parse` keep that key on the returned record, an explicit
 * `undefined` value the RPC wire can't carry. Drop the key entirely when
 * absent, matching how a role with no instruction is stored and returned
 * everywhere else.
 */
function sanitizeRole(role: Role): Role {
  if (role.instruction !== undefined) return role;
  const { instruction: _unused, ...rest } = role;
  return rest;
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
      // `null` is the wire's explicit "clear the instruction" signal;
      // normalize it to the stored record's `undefined` before it reaches
      // the store. Building the patch as a full object literal (rather than
      // spreading `role`) keeps the `instruction` key present even when its
      // value is `undefined`, so an update always replaces the field
      // instead of a stale value surviving a merge — see roles/store.ts's
      // `update`.
      const record = {
        id: role.id,
        description: role.description,
        permissionMode: role.permissionMode,
        instruction: role.instruction ?? undefined,
        candidates: role.candidates,
      };
      const saved =
        mode === "create"
          ? deps.store.create(record)
          : deps.store.update(record.id, {
              description: record.description,
              permissionMode: record.permissionMode,
              instruction: record.instruction,
              candidates: record.candidates,
            });
      const results = await findMissingModels(bb, saved.candidates);
      const warnings = results.filter((result) => !result.known).map(formatUnknownModelMessage);
      return { role: sanitizeRole(saved), warnings };
    },
    deleteRole({ id }) {
      return { deleted: deps.store.remove(id) };
    },
    checkModels({ candidates }) {
      return findMissingModels(bb, candidates);
    },
  });
}
