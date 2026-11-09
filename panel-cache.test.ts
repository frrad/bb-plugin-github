import { describe, expect, it, vi } from "vitest";
import { createReadCache, isSyncStale } from "./panel-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("panel read cache", () => {
  it("shares pending reads and keeps old results until new data arrives", async () => {
    const cache = createReadCache<string[]>();
    await cache.refresh(async () => ["cached"]);
    const next = deferred<string[]>();
    const load = vi.fn(() => next.promise);
    const one = cache.refresh(load);
    const two = cache.refresh(load);
    expect(two).toBe(one);
    expect(cache.getSnapshot().data).toEqual(["cached"]);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    next.resolve(["fresh"]);
    await one;
    expect(cache.getSnapshot()).toEqual({
      data: ["fresh"],
      error: null,
      refreshing: false,
    });
  });

  it("retains cached results after a failed refresh and recovers on retry", async () => {
    const cache = createReadCache<string[]>();
    await cache.refresh(async () => ["cached"]);
    await cache.refresh(async () => {
      throw new Error("offline");
    });
    expect(cache.getSnapshot()).toEqual({
      data: ["cached"],
      error: "offline",
      refreshing: false,
    });
    await cache.refresh(async () => ["recovered"]);
    expect(cache.getSnapshot()).toEqual({
      data: ["recovered"],
      error: null,
      refreshing: false,
    });
  });

  it("rechecks after an in-flight read if a realtime change arrived meanwhile", async () => {
    const cache = createReadCache<string[]>();
    const old = deferred<string[]>();
    const pending = cache.refresh(() => old.promise);
    const fresh = vi.fn(async () => ["fresh"]);
    void cache.refresh(fresh, true);
    void cache.refresh(fresh, true);
    old.resolve(["old"]);
    await pending;
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot().data).toEqual(["fresh"]);
    expect(cache.getSnapshot().refreshing).toBe(false);
  });
});

describe("automatic sync freshness", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  it("uses the most recent successful sync from the server or this window", () => {
    expect(isSyncStale(new Date(now - 599_999).toISOString(), null, now)).toBe(
      false,
    );
    expect(isSyncStale(new Date(now - 600_000).toISOString(), null, now)).toBe(
      true,
    );
    expect(
      isSyncStale(new Date(now - 900_000).toISOString(), now - 1_000, now),
    ).toBe(false);
    expect(
      isSyncStale(new Date(now - 1_000).toISOString(), now - 900_000, now),
    ).toBe(false);
  });
  it("refreshes when there is no usable timestamp", () => {
    expect(isSyncStale(null, null, now)).toBe(true);
    expect(isSyncStale("invalid", null, now)).toBe(true);
    expect(isSyncStale(new Date(now + 60_000).toISOString(), null, now)).toBe(
      true,
    );
  });
});
