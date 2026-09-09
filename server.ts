// bb-plugin-roles — a BB plugin backend entry.
//
// A role is a named cast entry (roles/schema.ts): a trigger description, an
// ordered list of model candidates, a permission mode and an optional
// instruction. This factory owns the foundation every other surface calls:
// the role store (roles/store.ts, seeded once from roles/seed.ts), live
// provider quota (roles/quota.ts) and the held-block registry
// (roles/blocks.ts) that back candidate selection (roles/select.ts).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createBlockRegistry } from "./roles/blocks";
import { registerCli } from "./roles/cli";
import { execFileText } from "./roles/exec";
import { registerInstructions } from "./roles/instructions";
import { registerMentions } from "./roles/mention";
import { createQuotaReader } from "./roles/quota";
import { registerRoleRpc } from "./roles/rpc";
import { createSpawner } from "./roles/spawn";
import { createSpawnedRegistry } from "./roles/spawned";
import { createRoleStore } from "./roles/store";
import { DEFAULT_DELEGATION_RULE } from "./roles/rule";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Plugin settings: the quota-skip threshold and the delegation rule.
  // Candidate selection (roles/select.ts) skips any candidate at or below the
  // threshold; the rule is cached by roles/instructions.ts for synchronous
  // contribution.
  const settings = bb.settings.define({
    thresholdPercent: {
      type: "number",
      label: "Quota skip threshold (%)",
      experimental_schema: z.number().int().min(0).max(100),
      default: 5,
    },
    delegationRule: {
      type: "string",
      experimental_multiline: true,
      label: "Delegation rule",
      default: DEFAULT_DELEGATION_RULE,
    },
  });
  // (read again inside handlers/CLI for freshness — settings.get() below)

  const store = createRoleStore(bb);
  store.seedOnce();
  // The settings page (app.tsx) refetches on this signal; it fires for a
  // write from either the CLI or the RPC below, since both go through this
  // one store.
  const unsubscribeRolesChanged = store.onChange(() => bb.realtime.publish("roles-changed", {}));
  registerRoleRpc(bb, { store, settings });

  const quota = createQuotaReader({
    sdk: bb.sdk,
    exec: execFileText,
  });

  const blocks = createBlockRegistry({ kv: bb.storage.kv, log: bb.log });

  // Builder B: spawn/respawn, instructions, mention
  const spawned = createSpawnedRegistry(bb);
  await spawned.load();
  const spawner = createSpawner({ bb, store, quota, blocks, spawned, settings });
  await registerInstructions({ bb, store, spawned, settings });
  registerMentions({ bb, store });

  // Builder C: CLI
  const roles = { store, quota, blocks, spawner, settings, spawned };
  registerCli(bb, roles);

  bb.onDispose(() => {
    unsubscribeRolesChanged();
    bb.log.info("disposed");
  });
}
