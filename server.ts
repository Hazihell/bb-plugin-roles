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

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // One plugin setting: the quota-skip threshold, a percentage. Candidate
  // selection (roles/select.ts) skips any candidate at or below this.
  const settings = bb.settings.define({
    thresholdPercent: {
      type: "number",
      label: "Quota skip threshold (%)",
      experimental_schema: z.number().int().min(0).max(100),
      default: 5,
    },
  });
  // (read again inside handlers/CLI for freshness — settings.get() below)

  const store = createRoleStore(bb);
  store.seedOnce();
  // The settings page (app.tsx) refetches on this signal; it fires for a
  // write from either the CLI or the RPC below, since both go through this
  // one store.
  store.onChange(() => bb.realtime.publish("roles-changed", {}));
  registerRoleRpc(bb, { store });

  const quota = createQuotaReader({
    sdk: bb.sdk,
    exec: execFileText,
  });

  const blocks = createBlockRegistry({ kv: bb.storage.kv, log: bb.log });

  // Builder B: spawn/respawn, instructions, mention
  const spawned = createSpawnedRegistry(bb);
  await spawned.load();
  const spawner = createSpawner({ bb, store, quota, blocks, spawned, settings });
  registerInstructions({ bb, store, spawned });
  registerMentions({ bb, store });

  // Builder C: CLI
  const roles = { store, quota, blocks, spawner, settings, spawned };
  registerCli(bb, roles);

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
