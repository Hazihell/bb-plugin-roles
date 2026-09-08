// roles/models.ts — the live model-existence check shared by the CLI
// (roles/cli.ts) and the settings page RPC (roles/rpc.ts). Warn, never
// block: an unreachable executionOptions call, or a provider this bb
// doesn't know about, is treated as "no information" rather than a missing
// model.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { resolveModel, type Candidate } from "./schema";

export interface ModelCheckResult {
  index: number;
  provider: string;
  model: string;
  resolvedModel: string;
  /** false only when the provider IS known and its live list omits the model. */
  known: boolean;
}

/**
 * Checks each candidate's resolved model against its provider's live model
 * list. `executionOptions` is called at most once per distinct provider
 * present in `candidates`. A provider that's unreachable, or one this bb
 * doesn't recognize, reports `known: true` for its candidates — there's no
 * information to warn from.
 */
export async function findMissingModels(
  bb: BbPluginApi,
  candidates: readonly Candidate[],
): Promise<ModelCheckResult[]> {
  const cache = new Map<string, Awaited<ReturnType<BbPluginApi["sdk"]["system"]["executionOptions"]>> | null>();
  const results: ModelCheckResult[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const resolvedModel = resolveModel(candidate.model, candidate.reasoningLevel);
    let options = cache.get(candidate.provider);
    if (options === undefined) {
      try {
        options = await bb.sdk.system.executionOptions({ providerId: candidate.provider });
      } catch {
        options = null;
      }
      cache.set(candidate.provider, options);
    }
    let known = true;
    if (options !== null) {
      const providerEntry = options.providers.find((provider) => provider.id === candidate.provider);
      if (providerEntry !== undefined) {
        known = [...options.models, ...options.selectedOnlyModels].some(
          (model) => model.model === resolvedModel || model.id === resolvedModel,
        );
      }
    }
    results.push({ index, provider: candidate.provider, model: candidate.model, resolvedModel, known });
  }
  return results;
}

/** The bare message for one unknown candidate, shared by the CLI and the RPC. */
export function formatUnknownModelMessage(result: ModelCheckResult): string {
  return `${result.provider} has no model "${result.resolvedModel}" in its live list`;
}

/** Formats `findMissingModels`' output as CLI warning lines, one per unknown candidate. */
export function formatMissingModelWarnings(results: readonly ModelCheckResult[]): string[] {
  return results.filter((result) => !result.known).map((result) => `warning: ${formatUnknownModelMessage(result)}`);
}

export interface ProviderModels {
  provider: string;
  /** Model ids as a candidate names them, e.g. "claude-opus-5[1m]". */
  models: string[];
}

/**
 * The pickable model list per provider, for the settings form's model
 * picker. Same "no information" rule as `findMissingModels`: a provider
 * whose live list can't be read reports an empty array, which the form
 * reads as "let the user type" rather than "this provider has no models".
 */
export async function listProviderModels(bb: BbPluginApi): Promise<ProviderModels[]> {
  let roster: Awaited<ReturnType<BbPluginApi["sdk"]["system"]["executionOptions"]>>;
  try {
    roster = await bb.sdk.system.executionOptions();
  } catch {
    return [];
  }
  const results: ProviderModels[] = [];
  for (const provider of roster.providers) {
    let options = roster;
    try {
      options = await bb.sdk.system.executionOptions({ providerId: provider.id });
    } catch {
      results.push({ provider: provider.id, models: [] });
      continue;
    }
    const models = [...options.models, ...options.selectedOnlyModels].map((model) => model.model);
    results.push({ provider: provider.id, models: [...new Set(models)] });
  }
  return results;
}
