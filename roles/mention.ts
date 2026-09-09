// roles/mention.ts — an `@` mention provider so a user can address a role
// directly in the composer. `resolve` hands the agent the role's
// description, its brief (what the brief file carries and how the child is
// used) and a ready `bb roles spawn` line as agent-only context.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RoleStore } from "./store";

export function registerMentions(deps: { bb: BbPluginApi; store: RoleStore }): void {
  const { bb, store } = deps;

  bb.ui.registerMentionProvider({
    id: "roles",
    label: "Roles",
    triggers: ["@"],
    search({ query }) {
      const needle = query.trim().toLowerCase();
      return store
        .list()
        .filter(
          (role) =>
            needle.length === 0 ||
            role.id.toLowerCase().includes(needle) ||
            role.description.toLowerCase().includes(needle),
        )
        .map((role) => ({
          id: role.id,
          title: role.id,
          subtitle: role.description,
        }));
    },
    resolve(itemId) {
      const role = store.get(itemId);
      if (role === null) throw new Error(`No role with id "${itemId}"`);
      return {
        context: [
          `Role **${role.id}**: ${role.description}`,
          ...(role.brief === undefined ? [] : [`Brief: ${role.brief}`]),
          `Spawn: bb roles spawn --role ${role.id} --title "<title>" --prompt "$(cat <brief-file>)"`,
        ].join("\n"),
      };
    },
  });
}
