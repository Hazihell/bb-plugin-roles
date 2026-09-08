// roles/exec.ts — the one `execFile` adapter for shelling out: the
// Antigravity usage read (roles/quota.ts) and the `bb provider-retry cancel`
// fallback (roles/spawn.ts) both go through this rather than each declaring
// its own `Promise` wrapper around `node:child_process.execFile`.
import { execFile } from "node:child_process";

export function execFileText(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });
}
