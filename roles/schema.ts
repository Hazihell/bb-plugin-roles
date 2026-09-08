// roles/schema.ts — the Role record and its validation.
//
// A role is a named cast entry: a trigger description, an ordered list of
// model candidates to try in order, a permission mode, and an optional
// instruction contributed to threads it spawns. Every other module in this
// plugin imports its types from here rather than redeclaring them.
import { z } from "zod";

export const reasoningLevelSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const candidateSchema = z.object({
  /** A BB provider id, e.g. "claude-code", "codex", "acp-antigravity". */
  provider: z.string().min(1),
  /** May contain the literal "{level}", resolved at spawn time. */
  model: z.string().min(1),
  reasoningLevel: reasoningLevelSchema,
});
export type Candidate = z.infer<typeof candidateSchema>;

export const roleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "Role id must be a lowercase slug");

export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const roleSchema = z.object({
  id: roleIdSchema,
  description: z.string().min(1),
  permissionMode: permissionModeSchema.default("full"),
  instruction: z.string().optional(),
  candidates: z.array(candidateSchema).min(1),
});
export type Role = z.infer<typeof roleSchema>;

// `roleSchema.instruction` is `string | undefined`, which JSON.stringify
// drops from a wire payload — so a form clearing the field can't send
// `instruction: undefined` and have it arrive. This input variant accepts
// `null` as the explicit "clear" signal, which round-trips over JSON. It
// lives here (not roles/rpc.ts) so the frontend form can validate against it
// without importing a backend module — see components/roles/RoleFormDialog.tsx.
export const saveRoleInputSchema = roleSchema.extend({ instruction: z.string().nullable().optional() });
export type SaveRoleInput = z.infer<typeof saveRoleInputSchema>;

/** Replaces the literal "{level}" in a candidate's model with its level. */
export function resolveModel(model: string, level: ReasoningLevel): string {
  return model.replaceAll("{level}", level);
}
