// roles/spawned.ts — the record of every child this plugin launched.
//
// Durable copy in `bb.storage.kv` (one row per child, key
// `spawned/<childThreadId>`), mirrored in a synchronous in-memory map so
// `contributeInstructions` — which runs on the thread-start path and must be
// synchronous — can answer without I/O. `load()` fills the map from KV once
// at plugin start; every write goes through both.
//
// A stored row is untrusted input (an older/newer plugin version, or a hand
// edit, could have written something that no longer matches this shape).
// `load()` validates every row with zod and drops — logging a warning,
// never adding to the in-memory map — any that fails; `get()` only ever
// returns what `load()` or `put()` put there, so it needs no separate check.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { reasoningLevelSchema, type ReasoningLevel } from "./schema";

export type SpawnedStage =
  | "active"
  | "respawning"
  | "replaced"
  | "failed"
  | "exhausted";

export interface SpawnedRecord {
  childThreadId: string;
  roleId: string;
  candidateIndex: number;
  prompt: string;
  title: string | null;
  parentThreadId: string | null;
  /** The real environment id from the child's `ThreadResponse`, never the
   * (possibly unresolved, e.g. "host") environment passed to spawn. */
  environmentId: string;
  reasoningOverride: ReasoningLevel | null;
  stage: SpawnedStage;
  replacedBy: string | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

const spawnedStageSchema = z.enum([
  "active",
  "respawning",
  "replaced",
  "failed",
  "exhausted",
]);

const spawnedRecordSchema = z.object({
  childThreadId: z.string().min(1),
  roleId: z.string().min(1),
  candidateIndex: z.number().int().nonnegative(),
  prompt: z.string(),
  title: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  environmentId: z.string().min(1),
  reasoningOverride: reasoningLevelSchema.nullable(),
  stage: spawnedStageSchema,
  replacedBy: z.string().nullable(),
  error: z.string().nullable(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

export interface SpawnedRegistry {
  /** Loads every `spawned/*` row from KV into memory. Call once at start. */
  load(): Promise<void>;
  list(): SpawnedRecord[];
  get(childThreadId: string): SpawnedRecord | null;
  put(record: SpawnedRecord): Promise<void>;
  /**
   * In-memory atomic claim: false when the record is missing or its stage
   * isn't "active" (a duplicate event, or one already being handled); else
   * flips it to "respawning" — synchronously, before any KV write — and
   * persists that, returning true.
   */
  claim(childThreadId: string): Promise<boolean>;
}

const KEY_PREFIX = "spawned/";

function keyFor(childThreadId: string): string {
  return `${KEY_PREFIX}${childThreadId}`;
}

export function createSpawnedRegistry(bb: BbPluginApi): SpawnedRegistry {
  const byId = new Map<string, SpawnedRecord>();

  async function load(): Promise<void> {
    const keys = await bb.storage.kv.list(KEY_PREFIX);
    for (const key of keys) {
      const raw = await bb.storage.kv.get<unknown>(key);
      if (raw === undefined) continue;
      const parsed = spawnedRecordSchema.safeParse(raw);
      if (!parsed.success) {
        bb.log.warn(`dropping malformed spawned record at "${key}": ${parsed.error.message}`);
        continue;
      }
      byId.set(parsed.data.childThreadId, parsed.data);
    }
  }

  function list(): SpawnedRecord[] {
    return [...byId.values()];
  }

  function get(childThreadId: string): SpawnedRecord | null {
    return byId.get(childThreadId) ?? null;
  }

  async function put(record: SpawnedRecord): Promise<void> {
    byId.set(record.childThreadId, record);
    await bb.storage.kv.set(keyFor(record.childThreadId), record);
  }

  async function claim(childThreadId: string): Promise<boolean> {
    const current = byId.get(childThreadId);
    if (current === undefined || current.stage !== "active") return false;
    const next: SpawnedRecord = {
      ...current,
      stage: "respawning",
      updatedAtMs: Date.now(),
    };
    // Synchronous flip before the KV write: a second, concurrent claim()
    // sees "respawning" immediately and returns false, no matter how long
    // the write below takes.
    byId.set(childThreadId, next);
    await bb.storage.kv.set(keyFor(childThreadId), next);
    return true;
  }

  return { load, list, get, put, claim };
}
