// roles/quota.ts — live provider usage, read behind a 30s cache.
//
// Two data sources, chosen by provider id:
//   - claude-code and codex read `bb.sdk.system.usageLimits` (windows) and
//     `bb.sdk.system.providerStates` (auth/install status), and expose one
//     pool that matches every model.
//   - acp-antigravity has no BB-native usage surface; it shells out to
//     `agy -p /usage --output-format json` and exposes two pools (Gemini,
//     everything else) so an exhausted Gemini group never blocks a
//     Claude/GPT candidate on the same provider.
//
// `sdk` and `exec` are injected so tests never touch a real provider or
// spawn a real process.
export type ProviderStatus =
  | "ok"
  | "unauthenticated"
  | "expired"
  | "not_installed"
  | "unsupported_version"
  | "error"
  | "unknown";

export interface PoolWindow {
  label: string;
  remainingFraction: number | null;
  resetsAt: string | null;
}

export interface Pool {
  id: string;
  matches(model: string): boolean;
  windows: PoolWindow[];
}

export interface ProviderQuota {
  status: ProviderStatus;
  pools: Pool[];
  /** When this reading was taken, per the injected `now()`. */
  fetchedAtMs: number;
}

export type ExecFn = (
  command: string,
  args: string[],
) => Promise<{ stdout: string }>;

interface UsageWindow {
  label: string;
  resetsAt: string | null;
  usedPercent: number;
}

type UsageLimitEntry =
  | { status: "ok"; windows: UsageWindow[] }
  | { status: "not_installed" | "unauthenticated" | "expired" }
  | { status: "error"; message?: string };

export interface QuotaSdk {
  system: {
    usageLimits(args?: {
      providerId?: string;
    }): Promise<Record<string, UsageLimitEntry>>;
    providerStates(args?: { capability?: "usage" }): Promise<{
      providers: { providerId: string; status: string }[];
    }>;
  };
}

interface AntigravityBucket {
  id?: string;
  name?: string;
  disabled?: boolean;
  remaining_fraction?: number;
  reset_time?: string | null;
}
interface AntigravityGroup {
  name: string;
  buckets?: AntigravityBucket[];
}
interface AntigravityReport {
  command?: { data?: { groups?: AntigravityGroup[] } };
}

export interface QuotaReaderDeps {
  sdk: QuotaSdk;
  exec: ExecFn;
  now?: () => number;
}

export interface QuotaReader {
  /** Cached read (respects the 30s TTL). */
  get(providerId: string): Promise<ProviderQuota>;
  /** `refresh(id, { force: true })` bypasses the cache. */
  refresh(
    providerId: string,
    opts?: { force?: boolean },
  ): Promise<ProviderQuota>;
}

const CACHE_TTL_MS = 30_000;
const ANTIGRAVITY_PROVIDER_ID = "acp-antigravity";

function mapProviderStateStatus(status: string | undefined): ProviderStatus {
  switch (status) {
    case "ready":
      return "ok";
    case "expired":
    case "not_installed":
    case "unauthenticated":
    case "unsupported_version":
      return status;
    default:
      return "unknown";
  }
}

function mapUsageStatus(
  status: Exclude<UsageLimitEntry["status"], "ok">,
): ProviderStatus {
  return status;
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

export function createQuotaReader(deps: QuotaReaderDeps): QuotaReader {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, ProviderQuota>();

  async function fetchUsageLimits(
    providerId: string,
  ): Promise<Omit<ProviderQuota, "fetchedAtMs">> {
    try {
      const [usage, states] = await Promise.all([
        deps.sdk.system.usageLimits({ providerId }),
        deps.sdk.system.providerStates({ capability: "usage" }),
      ]);
      const providerState = states.providers.find(
        (candidate) => candidate.providerId === providerId,
      );
      const status = mapProviderStateStatus(providerState?.status);
      if (status !== "ok") return { status, pools: [] };

      const entry = usage[providerId];
      if (entry === undefined) return { status: "unknown", pools: [] };
      if (entry.status !== "ok") {
        return { status: mapUsageStatus(entry.status), pools: [] };
      }

      const windows: PoolWindow[] = entry.windows.map((window) => ({
        label: window.label,
        remainingFraction: 1 - window.usedPercent / 100,
        resetsAt: window.resetsAt,
      }));
      return {
        status: "ok",
        pools: [{ id: "default", matches: () => true, windows }],
      };
    } catch {
      return { status: "error", pools: [] };
    }
  }

  async function fetchAntigravity(): Promise<
    Omit<ProviderQuota, "fetchedAtMs">
  > {
    let stdout: string;
    try {
      const result = await deps.exec("agy", [
        "-p",
        "/usage",
        "--output-format",
        "json",
      ]);
      stdout = result.stdout;
    } catch (cause) {
      return isNotFound(cause)
        ? { status: "not_installed", pools: [] }
        : { status: "error", pools: [] };
    }
    try {
      const parsed = JSON.parse(stdout) as AntigravityReport;
      const groups = parsed.command?.data?.groups ?? [];
      const pools: Pool[] = groups.map((group) => {
        const isGemini = group.name === "Gemini Models";
        const windows: PoolWindow[] = (group.buckets ?? [])
          .filter((bucket) => bucket.disabled !== true)
          .map((bucket) => ({
            label: bucket.name ?? bucket.id ?? "",
            remainingFraction:
              typeof bucket.remaining_fraction === "number"
                ? bucket.remaining_fraction
                : null,
            resetsAt: bucket.reset_time ?? null,
          }));
        return {
          id: group.name,
          matches: (model: string) =>
            isGemini ? model.startsWith("gemini") : !model.startsWith("gemini"),
          windows,
        };
      });
      return { status: "ok", pools };
    } catch {
      return { status: "error", pools: [] };
    }
  }

  async function fetchQuota(providerId: string): Promise<ProviderQuota> {
    const fetchedAtMs = now();
    const base =
      providerId === ANTIGRAVITY_PROVIDER_ID
        ? await fetchAntigravity()
        : await fetchUsageLimits(providerId);
    return { ...base, fetchedAtMs };
  }

  async function refresh(
    providerId: string,
    opts: { force?: boolean } = {},
  ): Promise<ProviderQuota> {
    const cached = cache.get(providerId);
    if (!opts.force && cached && now() - cached.fetchedAtMs < CACHE_TTL_MS) {
      return cached;
    }
    const quota = await fetchQuota(providerId);
    cache.set(providerId, quota);
    return quota;
  }

  async function get(providerId: string): Promise<ProviderQuota> {
    return refresh(providerId);
  }

  return { get, refresh };
}
