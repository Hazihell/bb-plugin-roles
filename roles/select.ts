// roles/select.ts — turns a role's candidate list plus live quota and
// blocks into a spawn decision: the first usable candidate, in order, or a
// refusal that names every candidate's reset time.
import type { Candidate, Role } from "./schema";
import type { Pool, PoolWindow, ProviderQuota, QuotaReader } from "./quota";
import type { BlockRegistry } from "./blocks";

export type SkipReason = "threshold" | "status" | "blocked";

export interface CandidateEvaluation {
  candidate: Candidate;
  index: number;
  usable: boolean;
  reason?: SkipReason;
  detail: string;
  remainingFraction: number | null;
  resetsAt: string | null;
}

export interface EvaluateOptions {
  quota: QuotaReader;
  blocks: BlockRegistry;
  thresholdPercent: number;
}

/** The window with the least headroom, for the evaluation's summary fields. */
function mostConstrainedWindow(windows: PoolWindow[]): PoolWindow | null {
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
    };
  }

  const held = await opts.blocks.isHeld(
    candidate.provider,
    { pool, fetchedAtMs: quota.fetchedAtMs },
    opts.thresholdPercent,
  );
  if (held) {
    return {
      candidate,
      index,
      usable: false,
      reason: "blocked",
      detail: `${candidate.provider} is held after an observed rate-limit block`,
      remainingFraction: constrained?.remainingFraction ?? null,
      resetsAt: constrained?.resetsAt ?? null,
    };
  }

  return {
    candidate,
    index,
    usable: true,
    detail: "usable",
    remainingFraction: constrained?.remainingFraction ?? null,
    resetsAt: constrained?.resetsAt ?? null,
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

/** One line per candidate: "<provider> <model>: <reason> (resets <iso|unknown>)". */
export function formatRefusal(evaluations: CandidateEvaluation[]): string {
  return evaluations
    .map((evaluation) => {
      const reason = evaluation.reason ?? "unusable";
      const resets = evaluation.resetsAt ?? "unknown";
      return `${evaluation.candidate.provider} ${evaluation.candidate.model}: ${reason} (resets ${resets})`;
    })
    .join("\n");
}
