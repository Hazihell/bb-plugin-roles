// roles/instructions.ts — the Cast every thread's instructions carry, plus
// a spawned child's own role instruction.
//
// `contributeInstructions` runs on the thread-start path and must be
// synchronous, so this keeps an in-memory role list refreshed through
// `store.onChange` rather than touching the database per resolution.
//
// Budget, under the host's 4096-character cap: the Cast is mandatory and is
// rendered first, so it is never dropped — each role's description is
// already truncated to DESCRIPTION_MAX, and in the pathological case where
// the whole cast still doesn't fit, the cast itself is cut to MAX_LENGTH.
// The role instruction section gets whatever budget is left, truncated with
// a trailing "…" marker when it doesn't fit.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Role } from "./schema";
import type { RoleStore } from "./store";
import type { SpawnedRegistry } from "./spawned";

const MAX_LENGTH = 4096;
const DESCRIPTION_MAX = 200;

function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function buildCastSection(roles: Role[]): string {
  const lines = roles.map(
    (role) => `- **${role.id}** — ${truncate(role.description, DESCRIPTION_MAX)}`,
  );
  return [
    "## Cast",
    ...lines,
    "",
    'Spawn a child by role with `bb roles spawn --role <id> --title "<title>" --prompt "$(cat <brief-file>)"`; the plugin picks the provider and handles quota fallback.',
  ].join("\n");
}

function buildRoleSection(role: Role): string | null {
  if (!role.instruction) return null;
  return `\n\n## Role: ${role.id}\n${role.instruction}`;
}

export function registerInstructions(deps: {
  bb: BbPluginApi;
  store: RoleStore;
  spawned: SpawnedRegistry;
}): void {
  const { bb, store, spawned } = deps;

  let roles: Role[] = store.list();
  store.onChange(() => {
    roles = store.list();
  });

  bb.agents.contributeInstructions(({ threadId }) => {
    const record = spawned.get(threadId);
    if (roles.length === 0 && record === null) return null;

    // The Cast is mandatory and goes first: it always renders, truncated to
    // MAX_LENGTH only in the pathological case where it alone overflows.
    const cast = truncate(buildCastSection(roles), MAX_LENGTH);
    const role = record === null ? null : (roles.find((r) => r.id === record.roleId) ?? null);
    const roleSection = role === null ? null : buildRoleSection(role);
    if (roleSection === null) return cast;

    // The role instruction gets whatever's left of the 4096 total.
    const roleBudget = Math.max(0, MAX_LENGTH - cast.length);
    return cast + truncate(roleSection, roleBudget);
  });
}
