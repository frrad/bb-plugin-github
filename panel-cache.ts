import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { githubRpcContract } from "./server.js";
import type { Item } from "./app-logic.js";

interface Snapshot<T> {
  data: T | null;
  error: string | null;
  refreshing: boolean;
}

// Shared by mounted sections and retained while navigating away from the page.
export function createReadCache<T>() {
  let snapshot: Snapshot<T> = { data: null, error: null, refreshing: false };
  let pending: Promise<void> | null = null;
  let queued: (() => Promise<T>) | null = null;
  const listeners = new Set<() => void>();
  function update(next: Snapshot<T>) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function refresh(load: () => Promise<T>, invalidate = false): Promise<void> {
    if (pending !== null) {
      // A change notification must not be lost behind an older read.
      if (invalidate) queued = load;
      return pending;
    }
    update({ ...snapshot, error: null, refreshing: true });
    pending = Promise.resolve()
      .then(load)
      .then(
        (data) => update({ data, error: null, refreshing: true }),
        (error: unknown) =>
          update({
            ...snapshot,
            error: error instanceof Error ? error.message : String(error),
          }),
      )
      .finally(() => {
        pending = null;
        const next = queued;
        queued = null;
        if (next !== null) return refresh(next);
        update({ ...snapshot, refreshing: false });
      });
    return pending;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    clear() {
      update({ data: null, error: null, refreshing: false });
    },
  };
}

export const panelCache = {
  issues: createReadCache<Item[]>(),
  pulls: createReadCache<Item[]>(),
  links:
    createReadCache<
      PluginRpcResult<(typeof githubRpcContract)["listLinks"]>["links"]
    >(),
  status:
    createReadCache<PluginRpcResult<(typeof githubRpcContract)["status"]>>(),
  viewer: createReadCache<string>(),
  sync: createReadCache<boolean>(),
};
