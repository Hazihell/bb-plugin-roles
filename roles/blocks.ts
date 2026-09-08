// roles/blocks.ts — held providers: an observed rate-limit block that
// outlives a single quota read.
//
// select.ts skips a candidate on live usage, but a "blocked" event on a
// spawned child can prove a provider is out well before its own usage
// numbers catch up. `record` remembers that observation; `isHeld` decides
// whether it still applies. One row per provider in `bb.storage.kv`, key
// `blocks/<providerId>`.
import type { Pool } from "./quota";

export interface BlockRecord {
  providerId: string;
  observedAtMs: number;
  resetsAtMs: number | null;
}

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
}

export interface BlockRegistry {
  /** Upserts: a new record renews observedAtMs and replaces resetsAtMs. */
  record(providerId: string, resetsAtMs: number | null): Promise<void>;
  isHeld(
    providerId: string,
    quotaForCandidate: QuotaForCandidate,
    thresholdPercent: number,
  ): Promise<boolean>;
}

const HOLD_MINIMUM_MS = 60 * 60 * 1000; // never release a reset-less block under an hour

function keyFor(providerId: string): string {
  return `blocks/${providerId}`;
}

export function createBlockRegistry(deps: BlockRegistryDeps): BlockRegistry {
  const now = deps.now ?? (() => Date.now());

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
    const stored = await deps.kv.get<BlockRecord>(keyFor(providerId));
    if (stored === undefined) return false;
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

  return { record, isHeld };
}
