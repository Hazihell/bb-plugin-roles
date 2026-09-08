// roles/blocks.ts — held providers: an observed rate-limit block that
// outlives a single quota read.
//
// select.ts skips a candidate on live usage, but a "blocked" event on a
// spawned child can prove a provider is out well before its own usage
// numbers catch up. `record` remembers that observation; `isHeld` decides
// whether it still applies; `heldUntil` reports when it will lift, for the
// refusal message. One row per provider in `bb.storage.kv`, key
// `blocks/<providerId>`.
//
// A stored row is untrusted input: it may have been written by an older or
// newer version of this plugin. `readBlock` is the one place that reads and
// validates it; a row that fails validation is logged and treated as absent
// (and deleted), same as no block at all.
import { z } from "zod";
import type { Pool } from "./quota";

export interface BlockRecord {
  providerId: string;
  observedAtMs: number;
  resetsAtMs: number | null;
}

const blockRecordSchema = z.object({
  providerId: z.string().min(1),
  observedAtMs: z.number(),
  resetsAtMs: z.number().nullable(),
});

/** The candidate's matching pool plus when that reading was taken. */
export interface QuotaForCandidate {
  pool: Pool | null;
  fetchedAtMs: number;
}

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BlockRegistryDeps {
  kv: KvLike;
  now?: () => number;
  /** Optional: a malformed stored record is logged here when given. */
  log?: { warn(message: string): void };
}

/** The earliest time a held block releases, for the refusal message. */
export interface HeldUntil {
  resetsAtMs: number;
  /** false when `resetsAtMs` is the observedAtMs + 1h fallback, not a reported reset time. */
  hasResetTime: boolean;
}

export interface BlockRegistry {
  /** Upserts: a new record renews observedAtMs and replaces resetsAtMs. */
  record(providerId: string, resetsAtMs: number | null): Promise<void>;
  isHeld(
    providerId: string,
    quotaForCandidate: QuotaForCandidate,
    thresholdPercent: number,
  ): Promise<boolean>;
  /** The still-held block's earliest release, or null when not held. */
  heldUntil(providerId: string): Promise<HeldUntil | null>;
}

const HOLD_MINIMUM_MS = 60 * 60 * 1000; // never release a reset-less block under an hour

function keyFor(providerId: string): string {
  return `blocks/${providerId}`;
}

export function createBlockRegistry(deps: BlockRegistryDeps): BlockRegistry {
  const now = deps.now ?? (() => Date.now());

  async function readBlock(providerId: string): Promise<BlockRecord | null> {
    const raw = await deps.kv.get<unknown>(keyFor(providerId));
    if (raw === undefined) return null;
    const parsed = blockRecordSchema.safeParse(raw);
    if (!parsed.success) {
      deps.log?.warn(
        `dropping malformed block record for "${providerId}": ${parsed.error.message}`,
      );
      await deps.kv.delete(keyFor(providerId));
      return null;
    }
    return parsed.data;
  }

  async function record(
    providerId: string,
    resetsAtMs: number | null,
  ): Promise<void> {
    const next: BlockRecord = { providerId, observedAtMs: now(), resetsAtMs };
    await deps.kv.set(keyFor(providerId), next);
  }

  async function isHeld(
    providerId: string,
    quotaForCandidate: QuotaForCandidate,
    thresholdPercent: number,
  ): Promise<boolean> {
    const stored = await readBlock(providerId);
    if (stored === null) return false;
    const nowMs = now();

    if (stored.resetsAtMs !== null) {
      if (nowMs >= stored.resetsAtMs) {
        await deps.kv.delete(keyFor(providerId));
        return false;
      }
      return true;
    }

    // No reset time: held until BOTH an hour has passed AND a usage read
    // taken after the observation shows full headroom on every window of
    // the candidate's pool. Unknown/error/missing usage is not headroom.
    if (nowMs < stored.observedAtMs + HOLD_MINIMUM_MS) return true;
    if (quotaForCandidate.fetchedAtMs <= stored.observedAtMs) return true;

    const pool = quotaForCandidate.pool;
    if (pool === null || pool.windows.length === 0) return true;
    const thresholdFraction = thresholdPercent / 100;
    const hasHeadroom = pool.windows.every(
      (window) =>
        window.remainingFraction !== null &&
        window.remainingFraction > thresholdFraction,
    );
    if (!hasHeadroom) return true;

    await deps.kv.delete(keyFor(providerId));
    return false;
  }

  async function heldUntil(providerId: string): Promise<HeldUntil | null> {
    const stored = await readBlock(providerId);
    if (stored === null) return null;
    const nowMs = now();

    if (stored.resetsAtMs !== null) {
      if (nowMs >= stored.resetsAtMs) return null; // already released
      return { resetsAtMs: stored.resetsAtMs, hasResetTime: true };
    }
    return { resetsAtMs: stored.observedAtMs + HOLD_MINIMUM_MS, hasResetTime: false };
  }

  return { record, isHeld, heldUntil };
}
