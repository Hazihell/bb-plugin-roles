// roles/instructions.ts — the Cast every thread's instructions carry, plus
// a spawned child's own role instruction.
//
// `contributeInstructions` runs on the thread-start path and must be
// synchronous, so this keeps an in-memory role list refreshed through
// `store.onChange` rather than touching the database per resolution.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Role } from "./schema";
import type { RoleStore } from "./store";
import type { SpawnedRegistry } from "./spawned";

const MAX_LENGTH = 4096;
const DESCRIPTION_MAX = 200;

function truncate(text: string, max: number): string {
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

    const cast = buildCastSection(roles);
    const role = record === null ? null : (roles.find((r) => r.id === record.roleId) ?? null);
    const roleSection = role === null ? null : buildRoleSection(role);

    if (roleSection === null) {
      return cast.length > MAX_LENGTH ? cast.slice(0, MAX_LENGTH) : cast;
    }

    // Truncate the cast, never the role instruction: clip the cast to
    // whatever budget is left after the instruction, down to nothing.
    const castBudget = Math.max(0, MAX_LENGTH - roleSection.length);
    const truncatedCast = cast.length > castBudget ? cast.slice(0, castBudget) : cast;
    return truncatedCast + roleSection;
  });
}
