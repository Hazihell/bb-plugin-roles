import { describe, expect, it } from "vitest";
import { createBlockRegistry, type KvLike } from "./blocks";
import type { Pool } from "./quota";

function makeKv(): KvLike {
  const rows = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return rows.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      rows.set(key, value);
    },
    async delete(key: string) {
      rows.delete(key);
    },
  };
}

function poolWithHeadroom(remainingFraction: number | null): Pool {
  return {
    id: "default",
    matches: () => true,
    windows: [{ label: "5h", remainingFraction, resetsAt: null }],
  };
}

const HOUR = 60 * 60 * 1000;

describe("createBlockRegistry", () => {
  it("is not held before any record exists", async () => {
    const registry = createBlockRegistry({ kv: makeKv(), now: () => 0 });
    const held = await registry.isHeld(
      "codex",
      { pool: poolWithHeadroom(1), fetchedAtMs: 0 },
      5,
    );
    expect(held).toBe(false);
  });

  it("a reset-time block releases exactly at that time", async () => {
    let now = 0;
    const kv = makeKv();
    const registry = createBlockRegistry({ kv, now: () => now });
    await registry.record("codex", 10_000);

    now = 9_999;
    expect(
      await registry.isHeld("codex", { pool: null, fetchedAtMs: now }, 5),
    ).toBe(true);

    now = 10_000;
    expect(
      await registry.isHeld("codex", { pool: null, fetchedAtMs: now }, 5),
    ).toBe(false);
  });

  it("a reset-less block does not release before an hour even with headroom", async () => {
    let now = 0;
    const kv = makeKv();
    const registry = createBlockRegistry({ kv, now: () => now });
    await registry.record("acp-antigravity", null);

    now = 30 * 60 * 1000; // t0 + 30min
    const held = await registry.isHeld(
      "acp-antigravity",
      { pool: poolWithHeadroom(1), fetchedAtMs: now },
      5,
    );
    expect(held).toBe(true);
  });

  it("a reset-less block releases after an hour once a fresh read shows headroom", async () => {
    let now = 0;
    const kv = makeKv();
    const registry = createBlockRegistry({ kv, now: () => now });
    await registry.record("acp-antigravity", null);

    now = HOUR + 60_000; // t0 + 61min
    const held = await registry.isHeld(
      "acp-antigravity",
      { pool: poolWithHeadroom(1), fetchedAtMs: now },
      5,
    );
    expect(held).toBe(false);
  });

  it("a reset-less block stays held past the hour when usage is unknown/error", async () => {
    let now = 0;
    const kv = makeKv();
    const registry = createBlockRegistry({ kv, now: () => now });
    await registry.record("acp-antigravity", null);

    now = HOUR + 60_000; // t0 + 61min
    const held = await registry.isHeld(
      "acp-antigravity",
      { pool: null, fetchedAtMs: now }, // status "error" → no matching pool
      5,
    );
    expect(held).toBe(true);
  });

  it("a reset-less block stays held when the usage read predates the observation", async () => {
    let now = 0;
    const kv = makeKv();
    const registry = createBlockRegistry({ kv, now: () => now });
    await registry.record("acp-antigravity", null);

    now = HOUR + 60_000;
    const held = await registry.isHeld(
      "acp-antigravity",
      // fetchedAtMs before the block was observed: stale, not proof of headroom.
      { pool: poolWithHeadroom(1), fetchedAtMs: 0 },
      5,
    );
    expect(held).toBe(true);
  });

  it("a new record renews observedAtMs and replaces resetsAtMs", async () => {
    let now = 0;
    const kv = makeKv();
    const registry = createBlockRegistry({ kv, now: () => now });
    await registry.record("codex", 1_000);

    now = 500;
    await registry.record("codex", null); // renew with no reset time

    now = 500 + HOUR - 1;
    expect(
      await registry.isHeld("codex", { pool: poolWithHeadroom(1), fetchedAtMs: now }, 5),
    ).toBe(true); // still under an hour from the renewed observation

    now = 500 + HOUR + 1;
    expect(
      await registry.isHeld("codex", { pool: poolWithHeadroom(1), fetchedAtMs: now }, 5),
    ).toBe(false);
  });

  it("a malformed stored record is logged and treated as not held, and deleted", async () => {
    const kv = makeKv();
    await kv.set("blocks/codex", { providerId: "codex", observedAtMs: "not-a-number" });
    const warnings: string[] = [];
    const registry = createBlockRegistry({ kv, now: () => 0, log: { warn: (message) => warnings.push(message) } });

    const held = await registry.isHeld("codex", { pool: poolWithHeadroom(1), fetchedAtMs: 0 }, 5);
    expect(held).toBe(false);
    expect(warnings.some((message) => message.includes("codex"))).toBe(true);
    expect(await kv.get("blocks/codex")).toBeUndefined();
  });

  describe("heldUntil", () => {
    it("returns null when there is no block", async () => {
      const registry = createBlockRegistry({ kv: makeKv(), now: () => 0 });
      expect(await registry.heldUntil("codex")).toBeNull();
    });

    it("returns the block's own reset time when it has one", async () => {
      const kv = makeKv();
      const registry = createBlockRegistry({ kv, now: () => 0 });
      await registry.record("codex", 10_000);

      expect(await registry.heldUntil("codex")).toEqual({ resetsAtMs: 10_000, hasResetTime: true });
    });

    it("returns observedAtMs + 1h and hasResetTime false when the block has no reset time", async () => {
      let now = 5_000;
      const kv = makeKv();
      const registry = createBlockRegistry({ kv, now: () => now });
      await registry.record("acp-antigravity", null);

      now = 6_000;
      expect(await registry.heldUntil("acp-antigravity")).toEqual({
        resetsAtMs: 5_000 + HOUR,
        hasResetTime: false,
      });
    });

    it("returns null once a reset-time block's own reset has passed", async () => {
      const kv = makeKv();
      let now = 0;
      const registry = createBlockRegistry({ kv, now: () => now });
      await registry.record("codex", 1_000);

      now = 1_000;
      expect(await registry.heldUntil("codex")).toBeNull();
    });
  });
});
