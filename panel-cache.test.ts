import { describe, expect, it, vi } from "vitest";
import { createReadCache } from "./panel-cache";

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
