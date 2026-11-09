// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNotesStore,
  itemNoteKey,
  type NotesTransport,
  type ServerNote,
} from "./item-notes";

const identity = { kind: "pr" as const, repo: "acme/widgets", number: 42 };
const key = itemNoteKey(identity.kind, identity.repo, identity.number);
const stores: ReturnType<typeof createNotesStore>[] = [];
function store() {
  const value = createNotesStore();
  stores.push(value);
  return value;
}
function server(initial: ServerNote[] = []) {
  const notes = new Map(
    initial.map((note) => [
      itemNoteKey(note.kind, note.repo, note.number),
      note,
    ]),
  );
  const transport: NotesTransport = {
    load: vi.fn(async () => [...notes.values()]),
    save: vi.fn(async (input) => {
      const id = itemNoteKey(input.kind, input.repo, input.number);
      const existing = notes.get(id);
      const current = existing ?? { ...input, body: "", revision: 0 };
      if ((input.importOnly && existing) || current.revision !== input.revision)
        return {
          saved: false,
          note: { body: current.body, revision: current.revision },
        };
      const saved = { ...input, revision: current.revision + 1 };
      notes.set(id, saved);
      return {
        saved: true,
        note: { body: saved.body, revision: saved.revision },
      };
    }),
  };
  return { notes, transport };
}
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  for (const value of stores.splice(0)) value.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("server-backed notes", () => {
  it("saves edits and loads them in a separate client without browser storage", async () => {
    const { transport } = server();
    const first = store();
    first.getSnapshot(key);
    await first.refresh(transport);
    first.edit(key, "Review tests", transport);
    await first.save(key, transport);
    expect(first.getSnapshot(key)).toMatchObject({
      body: "Review tests",
      dirty: false,
      saving: false,
      revision: 1,
    });
    const second = store();
    second.getSnapshot(key);
    await second.refresh(transport);
    expect(second.getSnapshot(key).body).toBe("Review tests");
    expect(window.localStorage.length).toBe(0);
  });
  it("makes newly rendered rows editable after the initial note list has loaded", async () => {
    const { transport } = server();
    const first = store();
    await first.refresh(transport);
    expect(first.getSnapshot(key).loaded).toBe(true);
  });
  it("autosaves after a short typing pause", async () => {
    vi.useFakeTimers();
    const { transport, notes } = server();
    const first = store();
    await first.refresh(transport);
    first.edit(key, "A draft", transport);
    await vi.advanceTimersByTimeAsync(399);
    expect(transport.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(notes.get(key)?.body).toBe("A draft");
    expect(first.getSnapshot(key).dirty).toBe(false);
  });
  it("migrates browser notes only after the server acknowledges them", async () => {
    window.localStorage.setItem(key, "A browser note");
    const { transport, notes } = server();
    const first = store();
    await first.refresh(transport);
    expect(notes.get(key)?.body).toBe("A browser note");
    expect(transport.save).toHaveBeenCalledWith(
      expect.objectContaining({ importOnly: true, revision: 0 }),
    );
    expect(window.localStorage.getItem(key)).toBeNull();
  });
  it("preserves a conflicting browser note and can append it explicitly", async () => {
    window.localStorage.setItem(key, "Browser version");
    const { transport, notes } = server([
      { ...identity, body: "Server version", revision: 2 },
    ]);
    const first = store();
    await first.refresh(transport);
    expect(transport.save).not.toHaveBeenCalled();
    expect(first.getSnapshot(key)).toMatchObject({
      body: "Server version",
      backup: "Browser version",
    });
    expect(window.localStorage.getItem(key)).toBe("Browser version");
    first.appendBackup(key, transport);
    await first.save(key, transport);
    expect(notes.get(key)?.body).toBe("Server version\n\nBrowser version");
    expect(window.localStorage.getItem(key)).toBeNull();
  });
  it("retains the browser source if migration fails", async () => {
    window.localStorage.setItem(key, "Browser version");
    const { transport } = server();
    vi.mocked(transport.save).mockRejectedValueOnce(new Error("offline"));
    const first = store();
    await first.refresh(transport);
    expect(first.getSnapshot(key)).toMatchObject({
      body: "Browser version",
      dirty: true,
      saving: false,
      error: expect.any(String),
    });
    expect(window.localStorage.getItem(key)).toBe("Browser version");
    await first.save(key, transport);
    expect(window.localStorage.getItem(key)).toBeNull();
  });
  it("protects dirty edits from realtime reads and detects competing device edits", async () => {
    const { transport, notes } = server([
      { ...identity, body: "Original", revision: 1 },
    ]);
    const first = store();
    first.getSnapshot(key);
    await first.refresh(transport);
    first.edit(key, "Local edit", transport);
    notes.set(key, { ...identity, body: "Other device", revision: 2 });
    await first.refresh(transport);
    expect(first.getSnapshot(key).body).toBe("Local edit");
    await first.save(key, transport);
    expect(notes.get(key)?.body).toBe("Other device");
    expect(first.getSnapshot(key)).toMatchObject({
      body: "Local edit",
      conflict: { body: "Other device", revision: 2 },
    });
    first.useServer(key);
    expect(first.getSnapshot(key)).toMatchObject({
      body: "Other device",
      dirty: false,
      conflict: null,
    });
  });
  it("can explicitly keep the local version after a concurrent-device conflict", async () => {
    const { transport, notes } = server([
      { ...identity, body: "Original", revision: 1 },
    ]);
    const first = store();
    await first.refresh(transport);
    first.edit(key, "My edit", transport);
    notes.set(key, { ...identity, body: "Other edit", revision: 2 });
    await first.save(key, transport);
    await first.overwrite(key, transport);
    expect(notes.get(key)).toMatchObject({ body: "My edit", revision: 3 });
    expect(first.getSnapshot(key)).toMatchObject({
      dirty: false,
      conflict: null,
    });
  });
  it("does not lose text typed while an earlier save is in flight", async () => {
    const { transport } = server();
    const first = store();
    first.getSnapshot(key);
    await first.refresh(transport);
    let finish!: (value: {
      saved: boolean;
      note: { body: string; revision: number };
    }) => void;
    vi.mocked(transport.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    first.edit(key, "First draft", transport);
    const pending = first.save(key, transport);
    first.edit(key, "Latest draft", transport);
    finish({ saved: true, note: { body: "First draft", revision: 1 } });
    // Let the second write acknowledge the revision from the first one.
    vi.mocked(transport.save).mockResolvedValueOnce({
      saved: true,
      note: { body: "Latest draft", revision: 2 },
    });
    await pending;
    expect(first.getSnapshot(key)).toMatchObject({
      body: "Latest draft",
      revision: 2,
      dirty: false,
    });
  });
});
