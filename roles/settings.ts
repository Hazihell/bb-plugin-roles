/** Mirrors the `smartZoneTokens` setting default in server.ts, for callers
 * reading a settings object written before the setting existed. */
export const DEFAULT_SMART_ZONE_TOKENS = 120_000;

export const DEFAULT_DISABLED_ROLES = "[]";

export function parseDisabledRoles(value: string | undefined): Set<string> {
  if (value === undefined) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((id): id is string => typeof id === "string")) {
      return new Set();
    }
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

export function serializeDisabledRoles(roleIds: Iterable<string>): string {
  return JSON.stringify([...new Set(roleIds)].sort());
}
