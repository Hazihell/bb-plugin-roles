import { describe, expect, it, vi } from "vitest";
import { createQuotaReader, type QuotaSdk } from "./quota";

// The live Antigravity report sample from cast.md (2026-09-08).
const ANTIGRAVITY_REPORT = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0,
              reset_time: "2026-09-10T19:35:41Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              disabled: true,
              remaining_fraction: 1,
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-09-15T15:34:56Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "2026-09-08T20:34:56Z",
            },
          ],
        },
      ],
    },
  },
});

function makeSdk(overrides: Partial<QuotaSdk["system"]> = {}): QuotaSdk {
  return {
    system: {
      usageLimits: vi.fn(async () => ({})),
      providerStates: vi.fn(async () => ({ providers: [] })),
      ...overrides,
    },
  };
}

describe("createQuotaReader — Antigravity", () => {
  it("maps the Gemini group to zero remaining and the other group to full", async () => {
    const exec = vi.fn(async () => ({ stdout: ANTIGRAVITY_REPORT }));
    const reader = createQuotaReader({ sdk: makeSdk(), exec });

    const quota = await reader.get("acp-antigravity");
    expect(quota.status).toBe("ok");

    const gemini = quota.pools.find((pool) => pool.id === "Gemini Models")!;
    expect(gemini.windows).toHaveLength(1); // the disabled 5h bucket is skipped
    expect(gemini.windows[0]).toMatchObject({
      remainingFraction: 0,
      resetsAt: "2026-09-10T19:35:41Z",
    });
    expect(gemini.matches("gemini-3.8-flash-medium")).toBe(true);
    expect(gemini.matches("claude-opus-5")).toBe(false);

    const other = quota.pools.find((pool) => pool.id === "Claude and GPT models")!;
    expect(other.windows.every((window) => window.remainingFraction === 1)).toBe(
      true,
    );
    expect(other.matches("claude-opus-5")).toBe(true);
    expect(other.matches("gemini-3.8-flash-medium")).toBe(false);

    expect(exec).toHaveBeenCalledWith("agy", [
      "-p",
      "/usage",
      "--output-format",
      "json",
    ]);
  });

  it("reports not_installed when the binary is missing", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    });
    const reader = createQuotaReader({ sdk: makeSdk(), exec });
    const quota = await reader.get("acp-antigravity");
    expect(quota.status).toBe("not_installed");
    expect(quota.pools).toEqual([]);
  });

  it("reports error on any other exec or parse failure", async () => {
    const exec = vi.fn(async () => ({ stdout: "not json" }));
    const reader = createQuotaReader({ sdk: makeSdk(), exec });
    const quota = await reader.get("acp-antigravity");
    expect(quota.status).toBe("error");
  });
});

describe("createQuotaReader — usageLimits providers", () => {
  it("resolves ok status with remaining fractions from usedPercent", async () => {
    const sdk = makeSdk({
      providerStates: vi.fn(async () => ({
        providers: [{ providerId: "claude-code", status: "ready" }],
      })),
      usageLimits: vi.fn(async () => ({
        "claude-code": {
          status: "ok" as const,
          windows: [
            { label: "5h", resetsAt: "2026-09-08T20:00:00Z", usedPercent: 40 },
          ],
        },
      })),
    });
    const reader = createQuotaReader({ sdk, exec: vi.fn() });
    const quota = await reader.get("claude-code");
    expect(quota.status).toBe("ok");
    expect(quota.pools[0]!.windows[0]).toMatchObject({
      remainingFraction: 0.6,
      resetsAt: "2026-09-08T20:00:00Z",
    });
    expect(quota.pools[0]!.matches("anything")).toBe(true);
  });

  it("surfaces a non-ready provider status without calling usage windows usable", async () => {
    const sdk = makeSdk({
      providerStates: vi.fn(async () => ({
        providers: [{ providerId: "codex", status: "unauthenticated" }],
      })),
    });
    const reader = createQuotaReader({ sdk, exec: vi.fn() });
    const quota = await reader.get("codex");
    expect(quota.status).toBe("unauthenticated");
    expect(quota.pools).toEqual([]);
  });

  it("caches for 30s and force-refreshes on demand", async () => {
    let now = 0;
    const usageLimits = vi.fn(async () => ({
      "claude-code": { status: "ok" as const, windows: [] },
    }));
    const sdk = makeSdk({
      providerStates: vi.fn(async () => ({
        providers: [{ providerId: "claude-code", status: "ready" }],
      })),
      usageLimits,
    });
    const reader = createQuotaReader({ sdk, exec: vi.fn(), now: () => now });

    await reader.get("claude-code");
    now += 29_000;
    await reader.get("claude-code");
    expect(usageLimits).toHaveBeenCalledTimes(1);

    now += 2_000; // total 31s: cache expired
    await reader.get("claude-code");
    expect(usageLimits).toHaveBeenCalledTimes(2);

    await reader.refresh("claude-code", { force: true });
    expect(usageLimits).toHaveBeenCalledTimes(3);
  });
});
