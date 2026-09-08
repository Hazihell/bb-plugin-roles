// roles/cli.ts — `bb roles`, the operator and agent surface over the store,
// live quota and the spawner.
//
// Argv parsing is plugin-owned (per the CLI contract): a small `--flag
// value` / `--flag=value` / boolean parser below, no external dependency.
// Every command accepts `--json`. A path argument (`--instruction-file`,
// `import <file>`) names a file on the INVOKING machine, never on the
// server the CLI handler runs on, so those reads go through
// `bb.sdk.files.read` with the invoking thread's host id rather than
// `node:fs` (see the multi-machine rule in the plugin-authoring skill).
// `--machine <id-or-name>`, on `create`, `update` and `import`, names that
// host explicitly and wins over the invoking thread's own host; with
// neither a thread nor `--machine` there is no host to read from, so the
// command exits 1 rather than silently falling back to the primary host.
import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BlockRegistry } from "./blocks";
import type { QuotaReader } from "./quota";
import {
  permissionModeSchema,
  reasoningLevelSchema,
  resolveModel,
  roleSchema,
  type Candidate,
  type PermissionMode,
  type ReasoningLevel,
  type Role,
} from "./schema";
import { evaluateCandidates, formatRefusal } from "./select";
import { AllCandidatesExhausted, type Spawner, type SpawnEnvironment } from "./spawn";
import type { SpawnedRegistry } from "./spawned";
import { roleExportSchema, type RoleStore } from "./store";

export interface RolesDeps {
  store: RoleStore;
  quota: QuotaReader;
  blocks: BlockRegistry;
  spawner: Spawner;
  settings: { get(): Promise<{ thresholdPercent: number }> };
  spawned: SpawnedRegistry;
}

/** A usage mistake: reported as one stderr line, never a stack trace. */
class CliUsageError extends Error {}
function usageError(message: string): CliUsageError {
  return new CliUsageError(message);
}

// --- argv parsing -----------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  /** Every `--flag` seen, in argv order; a boolean flag maps to []. */
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    let name: string;
    let value: string | null;
    if (eq !== -1) {
      name = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = null;
      }
    }
    const values = flags.get(name) ?? [];
    if (value !== null) values.push(value);
    flags.set(name, values);
  }
  return { positionals, flags };
}

function hasFlag(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}
function flagValues(flags: Map<string, string[]>, name: string): string[] {
  return flags.get(name) ?? [];
}
function flagValue(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  return values === undefined || values.length === 0 ? undefined : values[values.length - 1];
}
function requireFlag(flags: Map<string, string[]>, name: string): string {
  const value = flagValue(flags, name);
  if (value === undefined) throw usageError(`--${name} is required`);
  return value;
}

function parseReasoningLevel(raw: string): ReasoningLevel {
  const parsed = reasoningLevelSchema.safeParse(raw);
  if (!parsed.success) throw usageError(`invalid --reasoning "${raw}"`);
  return parsed.data;
}

function parsePermissionMode(raw: string): PermissionMode {
  const parsed = permissionModeSchema.safeParse(raw);
  if (!parsed.success) throw usageError(`invalid --permission-mode "${raw}"`);
  return parsed.data;
}

/** `<provider>:<model>[:<level>]`; an omitted level defaults to "medium". */
function parseCandidateArg(raw: string): Candidate {
  const parts = raw.split(":");
  if (parts.length === 2) {
    return { provider: parts[0]!, model: parts[1]!, reasoningLevel: "medium" };
  }
  if (parts.length === 3) {
    return {
      provider: parts[0]!,
      model: parts[1]!,
      reasoningLevel: parseReasoningLevel(parts[2]!),
    };
  }
  throw usageError(`invalid --candidate "${raw}": expected <provider>:<model>[:<level>]`);
}

// --- text formatting ----------------------------------------------------

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]) => cells.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

// --- invoking-machine file access ---------------------------------------
// `--machine`, when given, names the host directly and wins. Otherwise a
// thread id resolves to a host through its environment. With neither, there
// is no host to read from — unlike an omitted SDK hostId elsewhere in the
// plugin (which falls back to the primary host), a file read here has
// nowhere sensible to fall back to, so it's a usage error instead.

type InvokingThread = { environmentId: string | null; projectId: string };

async function getInvokingThread(bb: BbPluginApi, threadId: string): Promise<InvokingThread> {
  const thread = await bb.sdk.threads.get({ threadId });
  return thread as InvokingThread;
}

/** Resolves `--machine <id-or-name>` against `bb.sdk.hosts.list()`. */
async function resolveMachineFlag(bb: BbPluginApi, raw: string): Promise<string> {
  const hosts = await bb.sdk.hosts.list();
  const byId = hosts.find((host) => host.id === raw);
  if (byId !== undefined) return byId.id;
  const byName = hosts.find((host) => host.name === raw);
  if (byName !== undefined) return byName.id;
  throw usageError(`no host matching --machine "${raw}"`);
}

async function resolveHostId(
  bb: BbPluginApi,
  ctx: PluginCliContext,
  machineFlag: string | undefined,
): Promise<string | undefined> {
  if (machineFlag !== undefined) return resolveMachineFlag(bb, machineFlag);
  if (ctx.threadId === undefined) {
    throw usageError("no host context: pass --machine");
  }
  const thread = await getInvokingThread(bb, ctx.threadId);
  if (thread.environmentId === null) return undefined;
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  return (environment as { hostId?: string }).hostId;
}

async function readInvokingFile(
  bb: BbPluginApi,
  ctx: PluginCliContext,
  path: string,
  machineFlag: string | undefined,
): Promise<string> {
  const hostId = await resolveHostId(bb, ctx, machineFlag);
  const result = await bb.sdk.files.read({ hostId, path });
  return result.contentEncoding === "base64"
    ? Buffer.from(result.content, "base64").toString("utf8")
    : result.content;
}

// --- create/update model-warning check -----------------------------------
// Warn, never block: an unreachable executionOptions call, or a provider
// this bb doesn't know about, is silently skipped rather than treated as a
// missing model.

async function warnMissingModels(
  bb: BbPluginApi,
  candidates: readonly Candidate[],
  warn: (message: string) => void,
): Promise<void> {
  const cache = new Map<string, Awaited<ReturnType<BbPluginApi["sdk"]["system"]["executionOptions"]>> | null>();
  for (const candidate of candidates) {
    let options = cache.get(candidate.provider);
    if (options === undefined) {
      try {
        options = await bb.sdk.system.executionOptions({ providerId: candidate.provider });
      } catch {
        options = null;
      }
      cache.set(candidate.provider, options);
    }
    if (options === null) continue;
    const providerEntry = options.providers.find((provider) => provider.id === candidate.provider);
    if (providerEntry === undefined) continue;
    const resolvedModel = resolveModel(candidate.model, candidate.reasoningLevel);
    const known = [...options.models, ...options.selectedOnlyModels].some(
      (model) => model.model === resolvedModel || model.id === resolvedModel,
    );
    if (!known) {
      warn(`warning: ${candidate.provider} has no model "${resolvedModel}" in its live list`);
    }
  }
}

// --- instruction flags (create/update share the same three) -------------

async function resolveInstructionFlag(
  flags: Map<string, string[]>,
  bb: BbPluginApi,
  ctx: PluginCliContext,
): Promise<string | undefined> {
  const inline = flagValue(flags, "instruction");
  const filePath = flagValue(flags, "instruction-file");
  if (inline !== undefined && filePath !== undefined) {
    throw usageError("pass only one of --instruction or --instruction-file");
  }
  if (inline !== undefined) return inline;
  if (filePath !== undefined) return readInvokingFile(bb, ctx, filePath, flagValue(flags, "machine"));
  return undefined;
}

async function resolveInstructionPatch(
  flags: Map<string, string[]>,
  bb: BbPluginApi,
  ctx: PluginCliContext,
): Promise<{ set: boolean; value: string | undefined }> {
  const clear = hasFlag(flags, "clear-instruction");
  const inline = flagValue(flags, "instruction");
  const filePath = flagValue(flags, "instruction-file");
  const chosen = [clear, inline !== undefined, filePath !== undefined].filter(Boolean).length;
  if (chosen > 1) {
    throw usageError("pass only one of --instruction, --instruction-file or --clear-instruction");
  }
  if (clear) return { set: true, value: undefined };
  if (inline !== undefined) return { set: true, value: inline };
  if (filePath !== undefined) {
    return { set: true, value: await readInvokingFile(bb, ctx, filePath, flagValue(flags, "machine")) };
  }
  return { set: false, value: undefined };
}

// --- spawn ----------------------------------------------------------------

function buildEnvironment(
  flags: Map<string, string[]>,
  thread: InvokingThread | null,
): SpawnEnvironment {
  const environmentId = flagValue(flags, "environment");
  const newEnvironment = flagValue(flags, "new-environment");
  if (environmentId !== undefined && newEnvironment !== undefined) {
    throw usageError("pass only one of --environment or --new-environment");
  }
  if (environmentId !== undefined) {
    return { type: "reuse", environmentId };
  }
  if (newEnvironment !== undefined) {
    if (newEnvironment !== "worktree") {
      throw usageError(`unsupported --new-environment "${newEnvironment}": only "worktree" is supported`);
    }
    const baseBranch = flagValue(flags, "base-branch");
    return {
      type: "host",
      workspace: {
        type: "managed-worktree",
        baseBranch: baseBranch !== undefined ? { kind: "named", name: baseBranch } : { kind: "default" },
      },
    };
  }
  if (thread === null || thread.environmentId === null) {
    throw usageError("no environment: pass --environment or --new-environment");
  }
  return { type: "reuse", environmentId: thread.environmentId };
}

async function cmdSpawn(
  flags: Map<string, string[]>,
  ctx: PluginCliContext,
  bb: BbPluginApi,
  roles: RolesDeps,
): Promise<PluginCliResult> {
  const roleId = requireFlag(flags, "role");
  const prompt = requireFlag(flags, "prompt");
  const reasoningRaw = flagValue(flags, "reasoning");
  const reasoningOverride = reasoningRaw === undefined ? undefined : parseReasoningLevel(reasoningRaw);
  const title = flagValue(flags, "title");
  const parentThreadId = flagValue(flags, "parent") ?? ctx.threadId;

  const thread = ctx.threadId !== undefined ? await getInvokingThread(bb, ctx.threadId) : null;
  const environment = buildEnvironment(flags, thread);
  const projectId = thread?.projectId ?? ctx.projectId;
  if (projectId === undefined) {
    throw usageError("no project: run from a thread, or resolve one via --environment");
  }

  const result = await roles.spawner.spawnByRole({
    roleId,
    prompt,
    title,
    reasoningOverride,
    parentThreadId,
    environment,
    projectId,
  });
  const resolvedModel = resolveModel(result.candidate.model, result.level);

  if (hasFlag(flags, "json")) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        childId: result.child.id,
        roleId,
        candidate: {
          provider: result.candidate.provider,
          model: resolvedModel,
          reasoningLevel: result.candidate.reasoningLevel,
        },
        index: result.index,
        level: result.level,
        environmentId: result.child.environmentId,
      })}\n`,
    };
  }
  return {
    exitCode: 0,
    stdout: `Spawned ${result.child.id} as ${roleId} on ${result.candidate.provider} ${resolvedModel} (${result.level})\n`,
  };
}

// --- list / show ------------------------------------------------------

function cmdList(flags: Map<string, string[]>, roles: RolesDeps): PluginCliResult {
  const rolesList = roles.store.list();
  if (hasFlag(flags, "json")) {
    return { exitCode: 0, stdout: `${JSON.stringify(rolesList)}\n` };
  }
  const rows = rolesList.map((role) => {
    const first = role.candidates[0];
    const firstStr = first === undefined ? "-" : `${first.provider}:${resolveModel(first.model, first.reasoningLevel)}`;
    return [role.id, role.description, firstStr, String(role.candidates.length)];
  });
  const table = formatTable(["id", "description", "first candidate", "candidates"], rows);
  return { exitCode: 0, stdout: `${table}\n` };
}

function cmdShow(positionals: string[], flags: Map<string, string[]>, roles: RolesDeps): PluginCliResult {
  const id = positionals[0];
  if (id === undefined) throw usageError("show requires an id");
  const role = roles.store.get(id);
  if (role === null) throw usageError(`No role with id "${id}"`);
  if (hasFlag(flags, "json")) {
    return { exitCode: 0, stdout: `${JSON.stringify(role)}\n` };
  }
  const lines = [
    `id: ${role.id}`,
    `description: ${role.description}`,
    `permissionMode: ${role.permissionMode}`,
    `instruction: ${role.instruction ?? "-"}`,
    "candidates:",
    ...role.candidates.map(
      (candidate, index) =>
        `  ${index}: ${candidate.provider} ${resolveModel(candidate.model, candidate.reasoningLevel)} (${candidate.reasoningLevel})`,
    ),
  ];
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

// --- create / update / delete ------------------------------------------

async function cmdCreate(
  flags: Map<string, string[]>,
  ctx: PluginCliContext,
  bb: BbPluginApi,
  roles: RolesDeps,
): Promise<PluginCliResult> {
  const id = requireFlag(flags, "id");
  const description = requireFlag(flags, "description");
  const permissionModeRaw = flagValue(flags, "permission-mode");
  const candidateArgs = flagValues(flags, "candidate");
  if (candidateArgs.length === 0) throw usageError("--candidate is required (repeatable)");
  const instruction = await resolveInstructionFlag(flags, bb, ctx);

  const role = roleSchema.parse({
    id,
    description,
    permissionMode: permissionModeRaw === undefined ? undefined : parsePermissionMode(permissionModeRaw),
    instruction,
    candidates: candidateArgs.map(parseCandidateArg),
  } satisfies Partial<Role>);
  const created = roles.store.create(role);

  const warnings: string[] = [];
  await warnMissingModels(bb, created.candidates, (message) => warnings.push(message));
  const stderr = warnings.length === 0 ? undefined : `${warnings.join("\n")}\n`;

  const stdout = hasFlag(flags, "json") ? `${JSON.stringify(created)}\n` : `Created role "${created.id}"\n`;
  return { exitCode: 0, stdout, stderr };
}

async function cmdUpdate(
  positionals: string[],
  flags: Map<string, string[]>,
  ctx: PluginCliContext,
  bb: BbPluginApi,
  roles: RolesDeps,
): Promise<PluginCliResult> {
  const id = positionals[0];
  if (id === undefined) throw usageError("update requires an id");

  const patch: Partial<Omit<Role, "id">> = {};
  if (hasFlag(flags, "description")) patch.description = requireFlag(flags, "description");
  if (hasFlag(flags, "permission-mode")) {
    patch.permissionMode = parsePermissionMode(requireFlag(flags, "permission-mode"));
  }
  const instructionPatch = await resolveInstructionPatch(flags, bb, ctx);
  if (instructionPatch.set) patch.instruction = instructionPatch.value;
  const candidateArgs = flagValues(flags, "candidate");
  if (candidateArgs.length > 0) patch.candidates = candidateArgs.map(parseCandidateArg);

  const updated = roles.store.update(id, patch);

  const warnings: string[] = [];
  await warnMissingModels(bb, updated.candidates, (message) => warnings.push(message));
  const stderr = warnings.length === 0 ? undefined : `${warnings.join("\n")}\n`;

  const stdout = hasFlag(flags, "json") ? `${JSON.stringify(updated)}\n` : `Updated role "${updated.id}"\n`;
  return { exitCode: 0, stdout, stderr };
}

function cmdDelete(positionals: string[], flags: Map<string, string[]>, roles: RolesDeps): PluginCliResult {
  const id = positionals[0];
  if (id === undefined) throw usageError("delete requires an id");
  const removed = roles.store.remove(id);
  if (!removed) throw usageError(`No role with id "${id}"`);
  if (hasFlag(flags, "json")) {
    return { exitCode: 0, stdout: `${JSON.stringify({ id, deleted: true })}\n` };
  }
  return { exitCode: 0, stdout: `Deleted role "${id}"\n` };
}

// --- export / import ----------------------------------------------------
// import REPLACES the whole cast (roles/store.ts importAll): a role not in
// the document is deleted, not merely left alone.

function cmdExport(roles: RolesDeps): PluginCliResult {
  const doc = roles.store.exportAll();
  return { exitCode: 0, stdout: `${JSON.stringify(doc, null, 2)}\n` };
}

async function cmdImport(
  positionals: string[],
  flags: Map<string, string[]>,
  ctx: PluginCliContext,
  bb: BbPluginApi,
  roles: RolesDeps,
): Promise<PluginCliResult> {
  const path = positionals[0];
  if (path === undefined) throw usageError("import requires a file path");
  const raw = await readInvokingFile(bb, ctx, path, flagValue(flags, "machine"));

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw usageError(`invalid JSON in "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const doc = roleExportSchema.parse(parsed);
  const beforeIds = new Set(roles.store.list().map((role) => role.id));
  roles.store.importAll(doc);
  const importedIds = doc.roles.map((role) => role.id);
  const importedIdSet = new Set(importedIds);
  const removed = [...beforeIds].filter((id) => !importedIdSet.has(id)).length;

  if (hasFlag(flags, "json")) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ imported: importedIds.length, removed, roles: importedIds })}\n`,
    };
  }
  return { exitCode: 0, stdout: `Imported ${doc.roles.length} role(s) from ${path}\n` };
}

// --- quota ----------------------------------------------------------------

async function cmdQuota(flags: Map<string, string[]>, roles: RolesDeps): Promise<PluginCliResult> {
  const { thresholdPercent } = await roles.settings.get();
  const rolesList = roles.store.list();
  const statusByProvider = new Map<string, string>();

  interface Row {
    role: string;
    index: number;
    provider: string;
    model: string;
    remainingFraction: number | null;
    resetsAt: string | null;
    status: string;
    skip: boolean;
    reason: string | null;
  }
  const rows: Row[] = [];

  for (const role of rolesList) {
    const evaluations = await evaluateCandidates(role, {
      quota: roles.quota,
      blocks: roles.blocks,
      thresholdPercent,
    });
    for (const evaluation of evaluations) {
      const provider = evaluation.candidate.provider;
      let status = statusByProvider.get(provider);
      if (status === undefined) {
        status = (await roles.quota.get(provider)).status;
        statusByProvider.set(provider, status);
      }
      rows.push({
        role: role.id,
        index: evaluation.index,
        provider,
        model: resolveModel(evaluation.candidate.model, evaluation.candidate.reasoningLevel),
        remainingFraction: evaluation.remainingFraction,
        resetsAt: evaluation.resetsAt,
        status,
        skip: !evaluation.usable,
        reason: evaluation.usable ? null : (evaluation.reason ?? "unusable"),
      });
    }
  }

  if (hasFlag(flags, "json")) {
    return { exitCode: 0, stdout: `${JSON.stringify(rows)}\n` };
  }
  const tableRows = rows.map((row) => [
    row.role,
    String(row.index),
    row.provider,
    row.model,
    row.remainingFraction === null ? "?" : `${Math.round(row.remainingFraction * 100)}%`,
    row.resetsAt ?? "-",
    row.status,
    row.skip ? `yes (${row.reason})` : "no",
  ]);
  const table = formatTable(
    ["role", "index", "provider", "model", "remaining", "resets", "status", "skip"],
    tableRows,
  );
  return { exitCode: 0, stdout: `${table}\n` };
}

// --- dispatch ---------------------------------------------------------

async function runRolesCli(
  argv: string[],
  ctx: PluginCliContext,
  bb: BbPluginApi,
  roles: RolesDeps,
): Promise<PluginCliResult> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);
  try {
    switch (command) {
      case "spawn":
        return await cmdSpawn(flags, ctx, bb, roles);
      case "list":
        return cmdList(flags, roles);
      case "show":
        return cmdShow(positionals, flags, roles);
      case "create":
        return await cmdCreate(flags, ctx, bb, roles);
      case "update":
        return await cmdUpdate(positionals, flags, ctx, bb, roles);
      case "delete":
        return cmdDelete(positionals, flags, roles);
      case "export":
        return cmdExport(roles);
      case "import":
        return await cmdImport(positionals, flags, ctx, bb, roles);
      case "quota":
        return await cmdQuota(flags, roles);
      default:
        return { exitCode: 1, stderr: `unknown command "${command ?? ""}"; run bb roles --help\n` };
    }
  } catch (error) {
    if (error instanceof AllCandidatesExhausted) {
      return { exitCode: 1, stderr: `${formatRefusal(error.evaluations)}\n` };
    }
    if (error instanceof CliUsageError) {
      return { exitCode: 1, stderr: `${error.message}\n` };
    }
    if (error instanceof z.ZodError) {
      const message = error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { exitCode: 1, stderr: `${message}\n` };
    }
    if (error instanceof Error) {
      return { exitCode: 1, stderr: `${error.message}\n` };
    }
    throw error;
  }
}

export function registerCli(bb: BbPluginApi, roles: RolesDeps): void {
  bb.cli.register({
    name: "roles",
    summary: "Spawn and manage first-class agent roles with quota-aware fallback.",
    commands: [
      {
        name: "spawn",
        summary: "Spawn a child by role, on the first candidate with quota.",
        usage:
          "bb roles spawn --role <id> --prompt <text> [--reasoning <level>] [--title <t>] [--environment <id> | --new-environment worktree --base-branch <ref>] [--parent <thread-id>] [--json]",
      },
      { name: "list", summary: "List every role.", usage: "bb roles list [--json]" },
      { name: "show", summary: "Show one role in full.", usage: "bb roles show <id> [--json]" },
      {
        name: "create",
        summary: "Create a role.",
        usage:
          'bb roles create --id <slug> --description <text> --candidate <provider>:<model>[:<level>] [--candidate ...] [--permission-mode <mode>] [--instruction <text> | --instruction-file <path>] [--machine <id-or-name>]',
      },
      {
        name: "update",
        summary: "Update a role; --candidate replaces the whole list.",
        usage:
          'bb roles update <id> [--description <text>] [--permission-mode <mode>] [--instruction <text> | --instruction-file <path> | --clear-instruction] [--candidate <provider>:<model>[:<level>] ...] [--machine <id-or-name>]',
      },
      { name: "delete", summary: "Delete a role.", usage: "bb roles delete <id> [--json]" },
      { name: "export", summary: "Export every role as one JSON document.", usage: "bb roles export [--json]" },
      {
        name: "import",
        summary: "Import roles from a JSON file; replaces the whole cast.",
        usage: "bb roles import <file> [--machine <id-or-name>] [--json]",
      },
      {
        name: "quota",
        summary: "Show every candidate of every role with live quota and skip status.",
        usage: "bb roles quota [--json]",
      },
    ],
    async run(argv, ctx) {
      return runRolesCli(argv, ctx, bb, roles);
    },
  });
}
