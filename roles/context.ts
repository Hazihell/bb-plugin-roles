// roles/context.ts — where a thread's context window stands, for
// `bb roles context`. Two sources, best first:
//
// 1. Claude Code's own session log (`~/.claude/projects/<cwd-slug>/<session>.jsonl`)
//    records every API request's usage, so the last non-sidechain assistant
//    line is the exact prompt size of the last request — current to the last
//    API call, not the last turn. Sidechain lines belong to the provider's own
//    sub-agents and carry their context, not the thread's.
// 2. BB's `thread/contextWindowUsage/updated` event, which every provider
//    emits at the end of a turn; one turn stale, marked estimated by BB.
//
// The log path is resolved against the server's home directory, so the
// exact source works when the thread's host is this machine; a remote host
// falls back to the BB event.
import { homedir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface ContextReading {
  threadId: string;
  usedTokens: number;
  modelContextWindow: number | null;
  /** Which source produced the figure and how fresh it is. */
  source: "claude-session-log" | "bb-turn-event";
  estimated: boolean;
}

/** Claude Code names a project folder by its cwd with every non-alphanumeric character replaced by "-". */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeSessionLogPath(args: { cwd: string; sessionId: string; home?: string }): string {
  return `${args.home ?? homedir()}/.claude/projects/${claudeProjectSlug(args.cwd)}/${args.sessionId}.jsonl`;
}

/**
 * The prompt size of the last main-thread API request in a Claude Code
 * session log: input + cache-read + cache-creation tokens of the last
 * assistant line that is not a sidechain. Scans from the end; null when no
 * such line exists.
 */
export function latestClaudeContextTokens(log: string): number | null {
  const lines = log.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { type?: unknown; isSidechain?: unknown; message?: { usage?: Record<string, unknown> } };
    if (record.type !== "assistant" || record.isSidechain === true) continue;
    const usage = record.message?.usage;
    if (usage === undefined) continue;
    const n = (key: string) => (typeof usage[key] === "number" && usage[key] >= 0 ? (usage[key] as number) : 0);
    return n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
  }
  return null;
}

async function readBbTurnEvent(bb: BbPluginApi, threadId: string): Promise<ContextReading | null> {
  const rows = await bb.sdk.threads.events.list({
    threadId,
    types: ["thread/contextWindowUsage/updated"],
    order: "desc",
    limit: "1",
  });
  const row = rows[0] as { data?: { contextWindowUsage?: { usedTokens: number | null; modelContextWindow: number | null; estimated: boolean } } } | undefined;
  const usage = row?.data?.contextWindowUsage;
  if (usage === undefined || usage.usedTokens === null) return null;
  return { threadId, usedTokens: usage.usedTokens, modelContextWindow: usage.modelContextWindow, source: "bb-turn-event", estimated: usage.estimated };
}

async function readClaudeSessionLog(bb: BbPluginApi, threadId: string, environmentId: string): Promise<number | null> {
  const identity = await bb.sdk.threads.events.list({ threadId, types: ["thread/identity"], order: "desc", limit: "1" });
  const sessionId = (identity[0] as { data?: { providerThreadId?: string } } | undefined)?.data?.providerThreadId;
  if (sessionId === undefined || sessionId === "") return null;
  const environment = (await bb.sdk.environments.get({ environmentId })) as { path?: string; hostId?: string };
  if (environment.path === undefined) return null;
  const path = claudeSessionLogPath({ cwd: environment.path, sessionId });
  let file: { content: string; contentEncoding: string };
  try {
    file = await bb.sdk.files.read({ hostId: environment.hostId, path });
  } catch {
    return null;
  }
  const text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
  return latestClaudeContextTokens(text);
}

/** The freshest reading available for a thread, or null when neither source has one. */
export async function readContext(bb: BbPluginApi, threadId: string): Promise<ContextReading | null> {
  const thread = (await bb.sdk.threads.get({ threadId })) as { providerId?: string; environmentId?: string | null };
  const turnEvent = await readBbTurnEvent(bb, threadId);
  if (thread.providerId === "claude-code" && typeof thread.environmentId === "string") {
    const usedTokens = await readClaudeSessionLog(bb, threadId, thread.environmentId);
    if (usedTokens !== null) {
      return { threadId, usedTokens, modelContextWindow: turnEvent?.modelContextWindow ?? null, source: "claude-session-log", estimated: false };
    }
  }
  return turnEvent;
}
