// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  itemNoteKey,
  readItemNote,
  writeItemNote,
  subscribeItemNotes,
} from "./item-notes";

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("item notes storage", () => {
  it("keeps notes separate by kind, full repository, and number", () => {
    const key = itemNoteKey("pr", "acme/widgets", 42);
    expect(writeItemNote(key, "Review the tests")).toBe(true);
    expect(readItemNote(key)).toBe("Review the tests");
    expect(readItemNote(itemNoteKey("issue", "acme/widgets", 42))).toBe("");
    expect(readItemNote(itemNoteKey("pr", "other/widgets", 42))).toBe("");
    expect(readItemNote(itemNoteKey("pr", "acme/widgets", 43))).toBe("");
    expect(writeItemNote(key, "")).toBe(true);
    expect(window.localStorage.getItem(key)).toBeNull();
  });
  it("notifies matching subscribers in this window and on cross-window changes", () => {
    const key = itemNoteKey("issue", "acme/widgets", 7);
    const changed = vi.fn();
    const stop = subscribeItemNotes(key, changed);
    writeItemNote(itemNoteKey("pr", "acme/widgets", 7), "Other item");
    expect(changed).not.toHaveBeenCalled();
    writeItemNote(key, "A note");
    expect(changed).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    writeItemNote(key, "Updated");
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it("keeps typed notes in memory if persistence fails and can retry saving", () => {
    const key = itemNoteKey("pr", "acme/example", 9);
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    expect(writeItemNote(key, "Unsaved note")).toBe(false);
    expect(readItemNote(key)).toBe("Unsaved note");
    write.mockRestore();
    expect(writeItemNote(key, "Unsaved note")).toBe(true);
    expect(window.localStorage.getItem(key)).toBe("Unsaved note");
  });
});
