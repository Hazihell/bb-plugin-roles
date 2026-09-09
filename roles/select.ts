// roles/select.ts — turns a role's candidate list plus live quota and
// blocks into a spawn decision: the first usable candidate, in order, or a
// refusal that names every candidate's reset time.
import type { Candidate, Role } from "./schema";
import type { Pool, PoolWindow, ProviderQuota, QuotaReader } from "./quota";
import type { BlockRegistry } from "./blocks";

export type SkipReason = "threshold" | "status" | "blocked";

/**
 * What `resetsAt` means: `"reset"` is a reported reset time after which the
 * window (or block) is expected to be open again; `"earliest-release"` is
 * only the earliest a held-with-no-reset-time block can lift — fresh
 * headroom is still required after that time, so it may already be past and
 * still held; `"unknown"` means no time is known at all.
 */
export type ResetKind = "reset" | "earliest-release" | "unknown";

export interface CandidateEvaluation {
  candidate: Candidate;
  index: number;
  usable: boolean;
  reason?: SkipReason;
  detail: string;
  remainingFraction: number | null;
  resetsAt: string | null;
  resetKind: ResetKind;
}

export interface EvaluateOptions {
  quota: QuotaReader;
  blocks: BlockRegistry;
  thresholdPercent: number;
}

/** The window with the least headroom, for the evaluation's summary fields. */
export function mostConstrainedWindow(windows: readonly PoolWindow[]): PoolWindow | null {
  let result: PoolWindow | null = null;
  for (const window of windows) {
    if (window.remainingFraction === null) continue;
    if (
      result === null ||
      (result.remainingFraction !== null &&
        window.remainingFraction < result.remainingFraction)
    ) {
      result = window;
    }
  }
  return result ?? windows[0] ?? null;
}

function formatPercent(fraction: number | null): string {
  return fraction === null ? "unknown" : `${Math.round(fraction * 100)}%`;
}

/** A live window's own resetsAt is a reported reset time, or nothing known. */
function resetKindFor(resetsAt: string | null): ResetKind {
  return resetsAt === null ? "unknown" : "reset";
}

async function evaluateOne(
  candidate: Candidate,
  index: number,
  quota: ProviderQuota,
  opts: EvaluateOptions,
): Promise<CandidateEvaluation> {
  if (quota.status !== "ok") {
    return {
      candidate,
      index,
      usable: false,
      reason: "status",
      detail: `${candidate.provider} status is ${quota.status}`,
      remainingFraction: null,
      resetsAt: null,
      resetKind: "unknown",
    };
  }

  const pool: Pool | null =
    quota.pools.find((candidatePool) => candidatePool.matches(candidate.model)) ??
    null;
  const windows = pool?.windows ?? [];
  const constrained = mostConstrainedWindow(windows);
  const thresholdFraction = opts.thresholdPercent / 100;
  const overThreshold = windows.some(
    (window) =>
      window.remainingFraction !== null &&
      window.remainingFraction <= thresholdFraction,
  );
  if (overThreshold) {
    return {
      candidate,
      index,
      usable: false,
      reason: "threshold",
      detail: `remaining ${formatPercent(constrained?.remainingFraction ?? null)} at or below the ${opts.thresholdPercent}% threshold`,
      remainingFraction: constrained?.remainingFraction ?? null,
      resetsAt: constrained?.resetsAt ?? null,
      resetKind: resetKindFor(constrained?.resetsAt ?? null),
    };
  }

  const held = await opts.blocks.isHeld(
    candidate.provider,
    { pool, fetchedAtMs: quota.fetchedAtMs },
    opts.thresholdPercent,
  );
  if (held) {
    // The block's own reset time (or, absent one, its observedAtMs + 1h
    // earliest-release fallback) is what's reported here — not the live
    // window's resetsAt, which may be empty or stale relative to the block.
    const holdUntil = await opts.blocks.heldUntil(candidate.provider);
    if (holdUntil === null) {
      return {
        candidate,
        index,
        usable: false,
        reason: "blocked",
        detail: `${candidate.provider} is held after an observed rate-limit block`,
        remainingFraction: constrained?.remainingFraction ?? null,
        resetsAt: constrained?.resetsAt ?? null,
        resetKind: resetKindFor(constrained?.resetsAt ?? null),
      };
    }
    const resetsAtIso = new Date(holdUntil.resetsAtMs).toISOString();
    return {
      candidate,
      index,
      usable: false,
      reason: "blocked",
      detail: holdUntil.hasResetTime
        ? `${candidate.provider} is held after an observed rate-limit block`
        : `held (no reset time; earliest release ${resetsAtIso})`,
      remainingFraction: constrained?.remainingFraction ?? null,
      resetsAt: resetsAtIso,
      resetKind: holdUntil.hasResetTime ? "reset" : "earliest-release",
    };
  }

  return {
    candidate,
    index,
    usable: true,
    detail: "usable",
    remainingFraction: constrained?.remainingFraction ?? null,
    resetsAt: constrained?.resetsAt ?? null,
    resetKind: resetKindFor(constrained?.resetsAt ?? null),
  };
}

export async function evaluateCandidates(
  role: Role,
  opts: EvaluateOptions,
): Promise<CandidateEvaluation[]> {
  const evaluations: CandidateEvaluation[] = [];
  for (let index = 0; index < role.candidates.length; index++) {
    const candidate = role.candidates[index]!;
    const quota = await opts.quota.get(candidate.provider);
    evaluations.push(await evaluateOne(candidate, index, quota, opts));
  }
  return evaluations;
}

/** First usable candidate at index > after (default: from the start), or null. */
export async function selectCandidate(
  role: Role,
  opts: EvaluateOptions,
  select: { after?: number } = {},
): Promise<CandidateEvaluation | null> {
  const evaluations = await evaluateCandidates(role, opts);
  const after = select.after ?? -1;
  return (
    evaluations.find(
      (evaluation) => evaluation.index > after && evaluation.usable,
    ) ?? null
  );
}

/** The `(...)` suffix naming when a candidate is expected to become usable. */
export function formatResetSuffix(evaluation: Pick<CandidateEvaluation, "resetsAt" | "resetKind">): string {
  if (evaluation.resetKind === "earliest-release" && evaluation.resetsAt !== null) {
    return `held, earliest release ${evaluation.resetsAt}, needs fresh headroom`;
  }
  if (evaluation.resetKind === "reset" && evaluation.resetsAt !== null) {
    return `resets ${evaluation.resetsAt}`;
  }
  return "resets unknown";
}

/** One line per candidate: "<provider> <model>: <reason> (<reset suffix>)". */
export function formatRefusal(evaluations: CandidateEvaluation[]): string {
  return evaluations
    .map((evaluation) => {
      const reason = evaluation.reason ?? "unusable";
      return `${evaluation.candidate.provider} ${evaluation.candidate.model}: ${reason} (${formatResetSuffix(evaluation)})`;
    })
    .join("\n");
}
