// roles/instructions.ts — the delegation rule and Cast for parent threads,
// or the spawned child's own role instruction.
//
// `contributeInstructions` runs on the thread-start path and must be
// synchronous, so this keeps an in-memory role list refreshed through
// `store.onChange` rather than touching the database per resolution.
//
// Budget, under the host's 4096-character cap: the delegation rule and Cast
// are mandatory for parent threads and are rendered in that order. The role
// instruction section is the only content for a spawned thread with one.
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

export async function registerInstructions(deps: {
  bb: BbPluginApi;
  store: RoleStore;
  spawned: SpawnedRegistry;
  settings: { get(): Promise<{ delegationRule: string }>; onChange(listener: (next: { delegationRule: string }) => void): void };
}): Promise<void> {
  const { bb, store, spawned, settings } = deps;

  let roles: Role[] = store.list();
  let delegationRule = (await settings.get()).delegationRule;
  settings.onChange((next) => {
    delegationRule = next.delegationRule;
  });
  store.onChange(() => {
    roles = store.list();
  });

  bb.agents.contributeInstructions(({ threadId }) => {
    const record = spawned.get(threadId);
    const role = record === null ? null : (roles.find((r) => r.id === record.roleId) ?? null);
    const roleSection = role === null ? null : buildRoleSection(role);
    if (record !== null) return roleSection === null ? truncate(buildCastSection(roles), MAX_LENGTH) : truncate(roleSection, MAX_LENGTH);

    const rule = truncate(delegationRule, MAX_LENGTH);
    const separator = "\n\n";
    const cast = truncate(buildCastSection(roles), Math.max(0, MAX_LENGTH - rule.length - separator.length));
    return rule + separator + cast;
  });
}
