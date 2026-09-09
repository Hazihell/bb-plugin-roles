// roles/spawn.ts — launches children by role and keeps them alive across a
// rate limit.
//
// `spawnByRole` turns a role id into a live child: the first usable
// candidate (roles/select.ts) wins, the child is recorded (roles/spawned.ts)
// before its first turn can start, and the caller gets back which candidate
// and level were used. The respawn watcher listens for `turn.failed` on a
// thread this plugin spawned; when the failure carries a blocked rate limit
// it holds the provider (roles/blocks.ts), cancels any pending Provider
// Retry, and calls `spawnByRole` again for the next candidate with the same
// brief — archiving the dead child and messaging its parent once either way.
//
// Dispatch race: the installed SDK's `ThreadSpawnArgs` has no way to create
// a thread without an initial turn (`input`/`prompt` is required either
// way, and there's no separate `threads.create`), so the row can't exist
// before dispatch is even possible. Instead `sendAt` defers the first turn
// by DISPATCH_DEFER_MS past `spawnByRole`'s own `spawned.put()`, which runs
// synchronously right after `threads.spawn()` resolves with no other await
// in between — 2s is well over that gap, so `thread.start` can never fire
// before this plugin has recorded the child.
//
// Respawn robustness: the `turn.failed` handler below must never reject —
// an uncaught rejection here would otherwise leave a claimed record stuck
// at "respawning" forever, silently, with nobody told. Every step after
// `claim()` succeeds is wrapped so any failure before a replacement thread
// exists ends in stage "failed" plus exactly one best-effort parent
// message; a failure to archive the dead child AFTER a successful respawn
// is logged only — the respawn already happened and must not be
// double-reported.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BlockRegistry } from "./blocks";
import { execFileText } from "./exec";
import type { QuotaReader } from "./quota";
import { resolveModel, type Candidate, type ReasoningLevel, type Role } from "./schema";
import { evaluateCandidates, formatRefusal, mostConstrainedWindow, type CandidateEvaluation } from "./select";
import type { QuotaSnapshot, SpawnedRecord, SpawnedRegistry } from "./spawned";
import type { RoleStore } from "./store";

/** The subset of `CreateThreadRequest["environment"]` this plugin uses. */
export type SpawnEnvironment =
  | { type: "reuse"; environmentId: string }
  | {
      type: "host";
      hostId?: string;
      workspace: {
        type: "managed-worktree";
        baseBranch: { kind: "named"; name: string } | { kind: "default" };
      };
    };

export interface SpawnByRoleArgs {
  roleId: string;
  prompt: string;
  title?: string;
  reasoningOverride?: ReasoningLevel;
  parentThreadId?: string;
  environment: SpawnEnvironment;
  /**
   * The BB project the child belongs to. `CreateThreadRequest.projectId` is
   * required with no default, and a reused environment doesn't always let
   * the SDK infer it cheaply, so the caller supplies it directly. The
   * respawn watcher below resolves it from the dead child's environment.
   */
  projectId: string;
  /** First usable candidate at index > after (default: from the start). */
  after?: number;
}

type SpawnedChild = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["spawn"]>>;

export interface SpawnByRoleResult {
  child: SpawnedChild;
  candidate: Candidate;
  index: number;
  level: ReasoningLevel;
}

export class AllCandidatesExhausted extends Error {
  readonly role: Role;
  readonly evaluations: CandidateEvaluation[];

  constructor(role: Role, evaluations: CandidateEvaluation[]) {
    super(`No usable candidate for role "${role.id}"`);
    this.name = "AllCandidatesExhausted";
    this.role = role;
    this.evaluations = evaluations;
  }
}

export type ExecFn = (
  command: string,
  args: string[],
) => Promise<{ stdout: string }>;

/** How long the first turn is deferred past `spawned.put()`; see the module header. */
const DISPATCH_DEFER_MS = 2000;

export interface SpawnerDeps {
  bb: BbPluginApi;
  store: RoleStore;
  quota: QuotaReader;
  blocks: BlockRegistry;
  spawned: SpawnedRegistry;
  settings: { get(): Promise<{ thresholdPercent: number }> };
  /** Injected for tests; defaults to a real `child_process.execFile`. */
  execFn?: ExecFn;
}

export interface Spawner {
  spawnByRole(args: SpawnByRoleArgs): Promise<SpawnByRoleResult>;
}

function findRole(store: RoleStore, roleId: string): Role {
  const role = store.get(roleId);
  if (role === null) throw new Error(`No role with id "${roleId}"`);
  return role;
}

/** The window with the latest reset, or null when every window is open. */
function latestResetsAtMs(
  windows: readonly { resetsAtMs: number | null }[],
): number | null {
  let latest: number | null = null;
  for (const window of windows) {
    if (window.resetsAtMs === null) continue;
    if (latest === null || window.resetsAtMs > latest) latest = window.resetsAtMs;
  }
  return latest;
}

/** Reconstructs a dead record's own candidate, for the parent message. */
function describeDeadCandidate(
  role: Role,
  record: SpawnedRecord,
): { candidate: Candidate; level: ReasoningLevel; model: string } | null {
  const candidate = role.candidates[record.candidateIndex];
  if (candidate === undefined) return null;
  const level = record.reasoningOverride ?? candidate.reasoningLevel;
  return { candidate, level, model: resolveModel(candidate.model, level) };
}

function snapshotFromEvaluation(evaluation: CandidateEvaluation): QuotaSnapshot {
  return {
    remainingPercent:
      evaluation.remainingFraction === null ? null : Math.round(evaluation.remainingFraction * 100),
    resetsAt: evaluation.resetsAt,
  };
}

function snapshotForQuota(quota: Awaited<ReturnType<QuotaReader["get"]>>, model: string): QuotaSnapshot {
  const pool = quota.pools.find((candidate) => candidate.matches(model));
  const windows = pool?.windows ?? [];
  const window = mostConstrainedWindow(windows);
  return {
    remainingPercent: window?.remainingFraction === null || window === null
      ? null
      : Math.round(window.remainingFraction * 100),
    resetsAt: window?.resetsAt ?? null,
  };
}

export function createSpawner(deps: SpawnerDeps): Spawner {
  const { bb, store, quota, blocks, spawned, settings } = deps;
  const execFn = deps.execFn ?? execFileText;

  async function spawnByRole(args: SpawnByRoleArgs): Promise<SpawnByRoleResult> {
    const role = findRole(store, args.roleId);
    const { thresholdPercent } = await settings.get();
    const evaluations = await evaluateCandidates(role, { quota, blocks, thresholdPercent });
    const after = args.after ?? -1;
    const picked = evaluations.find((e) => e.index > after && e.usable) ?? null;
    if (picked === null) throw new AllCandidatesExhausted(role, evaluations);

    const level = args.reasoningOverride ?? picked.candidate.reasoningLevel;
    const model = resolveModel(picked.candidate.model, level);

    const child = await bb.sdk.threads.spawn({
      projectId: args.projectId,
      providerId: picked.candidate.provider,
      model,
      reasoningLevel: level,
      permissionMode: role.permissionMode,
      title: args.title,
      parentThreadId: args.parentThreadId,
      environment: args.environment,
      prompt: args.prompt,
      // Defer dispatch of the first turn so this plugin's own record of the
      // child (below) is written before `thread.start` can possibly fire.
      // See DISPATCH_DEFER_MS and the module header.
      sendAt: Date.now() + DISPATCH_DEFER_MS,
    });

    if (child.environmentId === null) {
      throw new Error(`Spawned thread ${child.id} has no environment id`);
    }

    const now = Date.now();
    await spawned.put({
      childThreadId: child.id,
      roleId: role.id,
      candidateIndex: picked.index,
      prompt: args.prompt,
      title: args.title ?? null,
      parentThreadId: args.parentThreadId ?? null,
      environmentId: child.environmentId,
      reasoningOverride: args.reasoningOverride ?? null,
      stage: "active",
      replacedBy: null,
      error: null,
      createdAtMs: now,
      updatedAtMs: now,
      provider: picked.candidate.provider,
      model,
      level,
      quotaAtSpawn: snapshotFromEvaluation(picked),
      quotaAtEnd: null,
      endedAtMs: null,
    });

    return { child, candidate: picked.candidate, index: picked.index, level };
  }

  async function cancelProviderRetry(childThreadId: string): Promise<void> {
    // `bb.sdk.hosts.retryUpdate` takes only `{ hostId }` — it retries a
    // host connection update, not a thread's provider retry, so it can't
    // express this cancel. Fall back to the CLI form named in the task.
    try {
      await execFn("bb", ["provider-retry", "cancel", childThreadId]);
    } catch (error) {
      bb.log.warn(
        `provider-retry cancel failed for ${childThreadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function sendToParent(parentThreadId: string, text: string): Promise<void> {
    await bb.sdk.threads.send({
      threadId: parentThreadId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  /** Best-effort: logs and never throws, so a failed message never masks the real error. */
  async function trySendToParent(parentThreadId: string | null, text: string): Promise<void> {
    if (parentThreadId === null) return;
    try {
      await sendToParent(parentThreadId, text);
    } catch (error) {
      bb.log.warn(
        `parent message to ${parentThreadId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function describeDead(dead: SpawnedRecord): string {
    const role = store.get(dead.roleId);
    const deadCandidate = role === null ? null : describeDeadCandidate(role, dead);
    return deadCandidate === null
      ? dead.roleId
      : `${dead.roleId}, ${deadCandidate.candidate.provider} ${deadCandidate.model}`;
  }

  /**
   * The one path for "no replacement exists": persists stage "failed" (own
   * try/catch — a failed write is logged, never rethrown) and sends exactly
   * one best-effort parent message. Called both from inside
   * `respawnDeadChild` (role missing, spawn itself failed) and from the
   * `turn.failed` handler's outer catch (blocks.record or claim() failed).
   */
  async function markFailed(dead: SpawnedRecord, message: string): Promise<void> {
    bb.log.warn(`respawn failed for ${dead.childThreadId}: ${message}`);
    try {
      await spawned.put({ ...dead, stage: "failed", error: message, updatedAtMs: Date.now() });
    } catch (putError) {
      bb.log.warn(
        `failed to persist "failed" stage for ${dead.childThreadId}: ${putError instanceof Error ? putError.message : String(putError)}`,
      );
    }
    await trySendToParent(
      dead.parentThreadId,
      `Child ${dead.childThreadId} (${describeDead(dead)}) hit a usage limit and the respawn failed: ${message}`,
    );
  }

  async function respawnDeadChild(dead: SpawnedRecord): Promise<void> {
    const role = store.get(dead.roleId);
    if (role === null) {
      await markFailed(dead, `role "${dead.roleId}" no longer exists`);
      return;
    }
    const deadDescription = describeDead(dead);

    let result: SpawnByRoleResult;
    try {
      const environment = await bb.sdk.environments.get({
        environmentId: dead.environmentId,
      });
      result = await spawnByRole({
        roleId: dead.roleId,
        prompt: dead.prompt,
        title: dead.title ?? undefined,
        reasoningOverride: dead.reasoningOverride ?? undefined,
        parentThreadId: dead.parentThreadId ?? undefined,
        environment: { type: "reuse", environmentId: dead.environmentId },
        projectId: environment.projectId,
        after: dead.candidateIndex,
      });
    } catch (error) {
      if (error instanceof AllCandidatesExhausted) {
        try {
          await spawned.put({ ...dead, stage: "exhausted", updatedAtMs: Date.now() });
        } catch (putError) {
          bb.log.warn(
            `failed to persist "exhausted" stage for ${dead.childThreadId}: ${putError instanceof Error ? putError.message : String(putError)}`,
          );
        }
        await trySendToParent(
          dead.parentThreadId,
          `Child ${dead.childThreadId} (${deadDescription}) hit a usage limit and every remaining ` +
            `candidate is unusable:\n${formatRefusal(error.evaluations)}`,
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await markFailed(dead, message);
      return;
    }

    // A replacement now exists: from here on, failures are logged only —
    // never a second stage change to "failed" or a second parent message.
    try {
      await spawned.put({
        ...dead,
        stage: "replaced",
        replacedBy: result.child.id,
        updatedAtMs: Date.now(),
      });
    } catch (putError) {
      bb.log.warn(
        `failed to persist "replaced" stage for ${dead.childThreadId}: ${putError instanceof Error ? putError.message : String(putError)}`,
      );
    }

    const newModel = resolveModel(result.candidate.model, result.level);
    await trySendToParent(
      dead.parentThreadId,
      `Child ${dead.childThreadId} (${deadDescription}) hit a usage limit and was archived. ` +
        `Respawned as ${result.child.id} on ${result.candidate.provider} ${newModel} (${result.level}) with the same brief.`,
    );

    try {
      await bb.sdk.threads.archive({ threadId: dead.childThreadId });
    } catch (archiveError) {
      bb.log.warn(
        `archiving dead child ${dead.childThreadId} failed after a successful respawn: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`,
      );
    }
  }

  bb.events.on("turn.failed", async (event) => {
    const dead = spawned.get(event.threadId);
    // Nothing here may reject: an uncaught rejection would leave a claimed
    // record stuck at "respawning" forever with nobody told.
    try {
      if (dead === null || dead.stage !== "active") return; // not ours, or already handled
      if (event.rateLimits?.status !== "blocked") return; // not the failure we respawn on

      const claimed = await spawned.claim(event.threadId);
      if (!claimed) return; // a duplicate event raced us here

      await blocks.record(event.rateLimits.providerId, latestResetsAtMs(event.rateLimits.windows));
      await cancelProviderRetry(event.threadId);
      await respawnDeadChild(spawned.get(event.threadId) ?? dead);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`turn.failed handling crashed for ${event.threadId}: ${message}`);
      if (dead !== null) await markFailed(dead, message);
    }
  });

  const completionRefreshes = new Map<string, Promise<void>>();

  async function recordCompletion(childThreadId: string): Promise<void> {
    const previous = completionRefreshes.get(childThreadId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const record = spawned.get(childThreadId);
      if (record === null || record.provider === undefined || record.model === undefined) return;
      try {
        const quotaAtEnd = snapshotForQuota(await quota.refresh(record.provider, { force: true }), record.model);
        await spawned.put({
          ...record,
          quotaAtEnd,
          endedAtMs: Date.now(),
          updatedAtMs: Date.now(),
        });
      } catch (error) {
        bb.log.warn(`quota completion read failed for ${childThreadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    completionRefreshes.set(childThreadId, current);
    try {
      await current;
    } finally {
      if (completionRefreshes.get(childThreadId) === current) completionRefreshes.delete(childThreadId);
    }
  }

  bb.events.on("thread.idle", async (event) => {
    await recordCompletion(event.thread.id);
  });
  bb.events.on("thread.failed", async (event) => {
    await recordCompletion(event.thread.id);
  });

  return { spawnByRole };
}
