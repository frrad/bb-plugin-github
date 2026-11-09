const PREFIX = "bb-plugin-github-fred:note:";
const CHANGE_EVENT = "bb-plugin-github-fred:notes-changed";
// Keep editing usable if browser storage is unavailable or full.
const unsaved = new Map<string, string>();

export function itemNoteKey(
  kind: "issue" | "pr",
  repo: string,
  number: number,
): string {
  return `${PREFIX}${kind}:${repo}#${number}`;
}
export function readItemNote(key: string): string {
  if (unsaved.has(key)) return unsaved.get(key)!;
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
export function writeItemNote(key: string, note: string): boolean {
  let saved = true;
  try {
    if (note.length > 0) window.localStorage.setItem(key, note);
    else window.localStorage.removeItem(key);
    unsaved.delete(key);
  } catch {
    saved = false;
    unsaved.set(key, note);
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
  return saved;
}
export function subscribeItemNotes(
  key: string,
  listener: () => void,
): () => void {
  const onChange = (event: Event) => {
    if ((event as CustomEvent<string>).detail === key) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    if (event.key === null) unsaved.clear();
    else unsaved.delete(event.key);
    listener();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
