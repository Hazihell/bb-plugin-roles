import { describe, expect, it } from "vitest";
import type { BlockRegistry, QuotaForCandidate } from "./blocks";
import type { Pool, ProviderQuota, QuotaReader } from "./quota";
import type { Role } from "./schema";
import { evaluateCandidates, formatRefusal, selectCandidate } from "./select";

function pool(windows: Pool["windows"]): Pool {
  return { id: "default", matches: () => true, windows };
}

function fakeQuotaReader(byProvider: Record<string, ProviderQuota>): QuotaReader {
  return {
    async get(providerId) {
      const quota = byProvider[providerId];
      if (quota === undefined) throw new Error(`no quota fixture for ${providerId}`);
      return quota;
    },
    async refresh(providerId) {
      return this.get(providerId);
    },
  };
}

function fakeBlocks(heldProviders: Set<string>): BlockRegistry {
  return {
    async record() {},
    async isHeld(providerId: string, _quotaForCandidate: QuotaForCandidate, _thresholdPercent: number) {
      return heldProviders.has(providerId);
    },
  };
}

function makeRole(): Role {
  return {
    id: "test-role",
    description: "A role for selection tests.",
    permissionMode: "full",
    candidates: [
      { provider: "p-status", model: "m1", reasoningLevel: "low" },
      { provider: "p-threshold", model: "m2", reasoningLevel: "low" },
      { provider: "p-blocked", model: "m3", reasoningLevel: "low" },
      { provider: "p-ok", model: "m4", reasoningLevel: "low" },
    ],
  };
}

describe("evaluateCandidates / selectCandidate", () => {
  it("skips on bad status, at the threshold, and on a held block; picks the first usable", async () => {
    const quota = fakeQuotaReader({
      "p-status": { status: "unauthenticated", pools: [], fetchedAtMs: 0 },
      "p-threshold": {
        status: "ok",
        pools: [pool([{ label: "5h", remainingFraction: 0.05, resetsAt: "2026-01-01T00:00:00Z" }])],
        fetchedAtMs: 0,
      },
      "p-blocked": {
        status: "ok",
        pools: [pool([{ label: "5h", remainingFraction: 1, resetsAt: null }])],
        fetchedAtMs: 0,
      },
      "p-ok": {
        status: "ok",
        pools: [pool([{ label: "5h", remainingFraction: 1, resetsAt: null }])],
        fetchedAtMs: 0,
      },
    });
    const blocks = fakeBlocks(new Set(["p-blocked"]));
    const role = makeRole();
    const opts = { quota, blocks, thresholdPercent: 5 };

    const evaluations = await evaluateCandidates(role, opts);
    expect(evaluations.map((e) => [e.candidate.provider, e.usable, e.reason])).toEqual([
      ["p-status", false, "status"],
      ["p-threshold", false, "threshold"],
      ["p-blocked", false, "blocked"],
      ["p-ok", true, undefined],
    ]);

    const chosen = await selectCandidate(role, opts);
    expect(chosen?.candidate.provider).toBe("p-ok");
    expect(chosen?.index).toBe(3);

    expect(await selectCandidate(role, opts, { after: 3 })).toBeNull();
  });

  it("treats remaining just above the threshold as usable", async () => {
    const quota = fakeQuotaReader({
      p1: {
        status: "ok",
        pools: [pool([{ label: "5h", remainingFraction: 0.06, resetsAt: null }])],
        fetchedAtMs: 0,
      },
    });
    const blocks = fakeBlocks(new Set());
    const role: Role = {
      id: "single",
      description: "d",
      permissionMode: "full",
      candidates: [{ provider: "p1", model: "m", reasoningLevel: "low" }],
    };
    const [evaluation] = await evaluateCandidates(role, { quota, blocks, thresholdPercent: 5 });
    expect(evaluation!.usable).toBe(true);
  });

  it("refuses with one line per candidate and its reset time when all are skipped", async () => {
    const quota = fakeQuotaReader({
      "p-status": { status: "expired", pools: [], fetchedAtMs: 0 },
      "p-threshold": {
        status: "ok",
        pools: [pool([{ label: "5h", remainingFraction: 0, resetsAt: "2026-02-01T00:00:00Z" }])],
        fetchedAtMs: 0,
      },
    });
    const blocks = fakeBlocks(new Set());
    const role: Role = {
      id: "all-skipped",
      description: "d",
      permissionMode: "full",
      candidates: [
        { provider: "p-status", model: "m1", reasoningLevel: "low" },
        { provider: "p-threshold", model: "m2", reasoningLevel: "low" },
      ],
    };
    const opts = { quota, blocks, thresholdPercent: 5 };
    expect(await selectCandidate(role, opts)).toBeNull();

    const evaluations = await evaluateCandidates(role, opts);
    expect(formatRefusal(evaluations)).toBe(
      [
        "p-status m1: status (resets unknown)",
        "p-threshold m2: threshold (resets 2026-02-01T00:00:00Z)",
      ].join("\n"),
    );
  });
});
