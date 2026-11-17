import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { githubRpcContract } from "../server.js";
import {
  itemNoteKey,
  itemNotes,
  type NoteIdentity,
  type NotesTransport,
} from "../item-notes.js";
import { Button } from "./ui/button.js";
import { Textarea } from "./ui/textarea.js";

export function useNotesTransport(): NotesTransport {
  const rpc = useRpc<typeof githubRpcContract>();
  return useMemo(
    () => ({
      load: () => rpc.call("listNotes").then((result) => result.notes),
      save: (input) => rpc.call("saveNote", input),
    }),
    [rpc],
  );
}

export function ItemNoteEditor({
  kind,
  repo,
  number,
  id: suppliedId,
  label = "Notes",
}: NoteIdentity & { id?: string; label?: string }) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const noteKey = itemNoteKey(kind, repo, number);
  const transport = useNotesTransport();
  const readNote = useCallback(() => itemNotes.getSnapshot(noteKey), [noteKey]);
  const subscribeNote = useCallback(
    (listener: () => void) => itemNotes.subscribe(noteKey, listener),
    [noteKey],
  );
  const note = useSyncExternalStore(subscribeNote, readNote);
  useEffect(() => {
    void itemNotes.refresh(transport);
  }, [transport]);
  useRealtime("notes-changed", () => {
    void itemNotes.refresh(transport);
  });
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Textarea
        id={id}
        value={note.body}
        rows={3}
        style={{
          fieldSizing: "content",
          minHeight: "5rem",
          maxHeight: "min(24rem, 50vh)",
          resize: "none",
          overflowY: "auto",
        }}
        maxLength={100_000}
        disabled={!note.loaded}
        onBlur={() => {
          void itemNotes.save(noteKey, transport);
        }}
        aria-label={`Notes for ${repo}#${number}`}
        placeholder="Add a note…"
        onChange={(event) =>
          itemNotes.edit(noteKey, event.target.value, transport)
        }
      />
      <p className="text-xs text-muted-foreground" role="status">
        {note.error ??
          (!note.loaded
            ? "Loading notes…"
            : note.saving
              ? "Saving…"
              : note.dirty
                ? "Unsaved changes"
                : "Saved on BB server")}
      </p>
      {note.conflict ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Server version</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border p-2 text-sm font-sans">
            {note.conflict.body || "(empty)"}
          </pre>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => itemNotes.useServer(noteKey)}
            >
              Use server version
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => itemNotes.overwrite(noteKey, transport)}
            >
              Save my version
            </Button>
          </div>
        </div>
      ) : note.error ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (note.loaded && note.dirty)
              void itemNotes.save(noteKey, transport);
            else void itemNotes.refresh(transport);
          }}
        >
          Retry
        </Button>
      ) : null}
      {note.backup ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          A different browser note was preserved.
          <Button
            size="sm"
            variant="outline"
            onClick={() => itemNotes.appendBackup(noteKey, transport)}
          >
            Append browser note
          </Button>
        </div>
      ) : null}
    </div>
  );
}
