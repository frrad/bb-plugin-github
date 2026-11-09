const PREFIX = "bb-plugin-github-fred:note:";
export interface NoteIdentity {
  kind: "issue" | "pr";
  repo: string;
  number: number;
}
export interface NoteRecord {
  body: string;
  revision: number;
}
export interface ServerNote extends NoteIdentity, NoteRecord {}
export interface NotesTransport {
  load(): Promise<ServerNote[]>;
  save(
    input: NoteIdentity & NoteRecord & { importOnly?: boolean },
  ): Promise<{ saved: boolean; note: NoteRecord }>;
}
export interface NoteSnapshot extends NoteRecord {
  loaded: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  conflict: NoteRecord | null;
  backup: string | null;
}
export function itemNoteKey(
  kind: "issue" | "pr",
  repo: string,
  number: number,
) {
  return `${PREFIX}${kind}:${repo}#${number}`;
}
function identity(key: string): NoteIdentity {
  const match = key
    .slice(PREFIX.length)
    .match(/^(issue|pr):([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (!key.startsWith(PREFIX) || !match)
    throw new Error("Invalid note identity");
  return {
    kind: match[1] as "issue" | "pr",
    repo: match[2],
    number: Number(match[3]),
  };
}
function browserNotes(): Map<string, string> {
  const notes = new Map<string, string>();
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        identity(key);
      } catch {
        continue;
      }
      const body = window.localStorage.getItem(key);
      if (body) notes.set(key, body);
    }
  } catch {}
  return notes;
}
function removeBrowserNote(key: string, body: string) {
  try {
    if (window.localStorage.getItem(key) === body)
      window.localStorage.removeItem(key);
  } catch {}
}

export function createNotesStore(
  options: {
    legacy?: () => Map<string, string>;
    removeLegacy?: (key: string, body: string) => void;
    delay?: number;
  } = {},
) {
  const legacy = options.legacy ?? browserNotes;
  const removeLegacy = options.removeLegacy ?? removeBrowserNote;
  const entries = new Map<
    string,
    {
      snapshot: NoteSnapshot;
      timer?: ReturnType<typeof setTimeout>;
      legacyToClear?: string;
    }
  >();
  const listeners = new Map<string, Set<() => void>>();
  let pending: Promise<void> | null = null;
  let reload = false;
  let generation = 0;
  let loaded = false;
  let loadError: string | null = null;
  function entry(key: string) {
    let value = entries.get(key);
    if (!value) {
      value = {
        snapshot: {
          body: "",
          revision: 0,
          loaded,
          dirty: false,
          saving: false,
          error: loadError,
          conflict: null,
          backup: null,
        },
      };
      entries.set(key, value);
    }
    return value;
  }
  function update(key: string, patch: Partial<NoteSnapshot>) {
    const value = entry(key);
    value.snapshot = { ...value.snapshot, ...patch };
    for (const listener of listeners.get(key) ?? []) listener();
  }
  async function save(
    key: string,
    transport: NotesTransport,
    importOnly = false,
  ): Promise<void> {
    const value = entry(key);
    clearTimeout(value.timer);
    const sent = value.snapshot;
    if (!sent.loaded || !sent.dirty || sent.saving || sent.conflict) return;
    const started = generation;
    update(key, { saving: true, error: null });
    try {
      const result = await transport.save({
        ...identity(key),
        body: sent.body,
        revision: sent.revision,
        importOnly,
      });
      if (generation !== started) return;
      const current = value.snapshot;
      if (!result.saved && result.note.body !== sent.body) {
        if (importOnly && current.body === sent.body) {
          update(key, {
            ...result.note,
            saving: false,
            dirty: false,
            backup: sent.body,
          });
          value.legacyToClear = undefined;
        } else {
          update(key, {
            saving: false,
            conflict: result.note,
            error: "This note changed elsewhere. Choose which version to keep.",
          });
        }
        return;
      }
      if (value.legacyToClear !== undefined) {
        removeLegacy(key, value.legacyToClear);
        value.legacyToClear = undefined;
      }
      const dirty = current.body !== sent.body;
      update(key, {
        revision: result.note.revision,
        saving: false,
        dirty,
        error: null,
      });
      if (dirty) await save(key, transport);
    } catch {
      if (generation === started)
        update(key, {
          saving: false,
          error: "Could not save to BB. Keep this window open and retry.",
        });
    }
  }
  function edit(key: string, body: string, transport: NotesTransport) {
    const value = entry(key);
    update(key, {
      body,
      dirty: true,
      error: value.snapshot.conflict ? value.snapshot.error : null,
    });
    clearTimeout(value.timer);
    value.timer = setTimeout(() => {
      void save(key, transport);
    }, options.delay ?? 400);
  }
  function refresh(transport: NotesTransport): Promise<void> {
    if (pending) {
      reload = true;
      return pending;
    }
    const started = generation;
    pending = (async () => {
      try {
        const notes = await transport.load();
        if (generation !== started) return;
        loaded = true;
        loadError = null;
        const local = legacy();
        const remote = new Map(
          notes.map((note) => [
            itemNoteKey(note.kind, note.repo, note.number),
            note,
          ]),
        );
        for (const key of new Set([
          ...entries.keys(),
          ...remote.keys(),
          ...local.keys(),
        ])) {
          const value = entry(key);
          if (value.snapshot.dirty || value.snapshot.saving) continue;
          const note = remote.get(key) ?? { body: "", revision: 0 };
          if (note.revision < value.snapshot.revision) continue;
          const backup = local.get(key);
          update(key, {
            body: note.body,
            revision: note.revision,
            loaded: true,
            error: null,
            backup: backup && backup !== note.body ? backup : null,
          });
          if (backup === undefined) continue;
          if (backup === note.body) {
            removeLegacy(key, backup);
            continue;
          }
          if (note.revision > 0) continue;
          value.legacyToClear = backup;
          update(key, { body: backup, dirty: true, backup: null });
          await save(key, transport, true);
          if (generation !== started) return;
        }
      } catch {
        if (generation === started)
          loadError = "Could not load notes from BB. Retry when connected.";
        if (generation === started)
          for (const key of entries.keys())
            update(key, {
              error: "Could not load notes from BB. Retry when connected.",
            });
      }
    })().finally(() => {
      if (generation !== started) return;
      pending = null;
      if (reload) {
        reload = false;
        return refresh(transport);
      }
    });
    return pending;
  }
  return {
    getSnapshot: (key: string) => entry(key).snapshot,
    subscribe(key: string, listener: () => void) {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(key);
      };
    },
    edit,
    save,
    refresh,
    useServer(key: string) {
      const note = entry(key).snapshot.conflict;
      if (note)
        update(key, { ...note, dirty: false, conflict: null, error: null });
    },
    overwrite(key: string, transport: NotesTransport) {
      const note = entry(key).snapshot.conflict;
      if (note) {
        update(key, { revision: note.revision, conflict: null });
        return save(key, transport);
      }
    },
    appendBackup(key: string, transport: NotesTransport) {
      const value = entry(key),
        note = value.snapshot;
      if (note.backup === null) return;
      value.legacyToClear = note.backup;
      update(key, { backup: null });
      edit(
        key,
        [note.body, note.backup].filter(Boolean).join("\n\n"),
        transport,
      );
    },
    clear() {
      generation++;
      loaded = false;
      loadError = null;
      pending = null;
      reload = false;
      for (const value of entries.values()) clearTimeout(value.timer);
      entries.clear();
    },
  };
}
export const itemNotes = createNotesStore();
