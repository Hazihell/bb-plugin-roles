// bb-plugin-roles — a BB plugin backend entry.
//
// A role is a named cast entry (roles/schema.ts): a trigger description, an
// ordered list of model candidates, a permission mode and an optional
// instruction. This factory owns the foundation every other surface calls:
// the role store (roles/store.ts, seeded once from roles/seed.ts), live
// provider quota (roles/quota.ts) and the held-block registry
// (roles/blocks.ts) that back candidate selection (roles/select.ts).
import { execFile } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createBlockRegistry } from "./roles/blocks";
import { createQuotaReader } from "./roles/quota";
import { createRoleStore } from "./roles/store";

function exec(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });
}

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
  void settings; // read again inside handlers/CLI for freshness (Builder B/C)

  const store = createRoleStore(bb);
  store.seedOnce();

  const quota = createQuotaReader({
    sdk: bb.sdk,
    exec,
  });

  const blocks = createBlockRegistry({ kv: bb.storage.kv });
  void quota;
  void blocks;

  // Builder B: spawn/respawn, instructions, mention
  // Builder C: CLI

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
