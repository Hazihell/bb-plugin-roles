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
import { execFile } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { resolveModel, type Candidate, type ReasoningLevel, type Role } from "./schema";
import { evaluateCandidates, formatRefusal, type CandidateEvaluation } from "./select";
import type { BlockRegistry } from "./blocks";
import type { QuotaReader } from "./quota";
import type { RoleStore } from "./store";
import type { SpawnedRecord, SpawnedRegistry } from "./spawned";

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

function execFileExec(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });
}

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

export function createSpawner(deps: SpawnerDeps): Spawner {
  const { bb, store, quota, blocks, spawned, settings } = deps;
  const execFn = deps.execFn ?? execFileExec;

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
      // Defer dispatch of the first turn so the row exists — and this
      // plugin has recorded it below — before `thread.start` can fire.
      sendAt: Date.now(),
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

  async function respawnDeadChild(dead: SpawnedRecord): Promise<void> {
    const role = findRole(store, dead.roleId);
    const deadCandidate = describeDeadCandidate(role, dead);
    const deadDescription =
      deadCandidate === null
        ? dead.roleId
        : `${dead.roleId}, ${deadCandidate.candidate.provider} ${deadCandidate.model}`;

    try {
      const environment = await bb.sdk.environments.get({
        environmentId: dead.environmentId,
      });
      const result = await spawnByRole({
        roleId: dead.roleId,
        prompt: dead.prompt,
        title: dead.title ?? undefined,
        reasoningOverride: dead.reasoningOverride ?? undefined,
        parentThreadId: dead.parentThreadId ?? undefined,
        environment: { type: "reuse", environmentId: dead.environmentId },
        projectId: environment.projectId,
        after: dead.candidateIndex,
      });

      await spawned.put({
        ...dead,
        stage: "replaced",
        replacedBy: result.child.id,
        updatedAtMs: Date.now(),
      });

      if (dead.parentThreadId !== null) {
        const newModel = resolveModel(result.candidate.model, result.level);
        await sendToParent(
          dead.parentThreadId,
          `Child ${dead.childThreadId} (${deadDescription}) hit a usage limit and was archived. ` +
            `Respawned as ${result.child.id} on ${result.candidate.provider} ${newModel} (${result.level}) with the same brief.`,
        );
      }

      await bb.sdk.threads.archive({ threadId: dead.childThreadId });
    } catch (error) {
      if (error instanceof AllCandidatesExhausted) {
        await spawned.put({ ...dead, stage: "exhausted", updatedAtMs: Date.now() });
        if (dead.parentThreadId !== null) {
          await sendToParent(
            dead.parentThreadId,
            `Child ${dead.childThreadId} (${deadDescription}) hit a usage limit and every remaining ` +
              `candidate is unusable:\n${formatRefusal(error.evaluations)}`,
          );
        }
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      await spawned.put({ ...dead, stage: "failed", error: message, updatedAtMs: Date.now() });
      if (dead.parentThreadId !== null) {
        await sendToParent(
          dead.parentThreadId,
          `Child ${dead.childThreadId} (${deadDescription}) hit a usage limit and the respawn failed: ${message}`,
        );
      }
    }
  }

  bb.events.on("turn.failed", async (event) => {
    const dead = spawned.get(event.threadId);
    if (dead === null || dead.stage !== "active") return; // not ours, or already handled
    if (event.rateLimits?.status !== "blocked") return; // not the failure we respawn on

    const claimed = await spawned.claim(event.threadId);
    if (!claimed) return; // a duplicate event raced us here

    await blocks.record(event.rateLimits.providerId, latestResetsAtMs(event.rateLimits.windows));
    await cancelProviderRetry(event.threadId);
    await respawnDeadChild(spawned.get(event.threadId) ?? dead);
  });

  return { spawnByRole };
}
