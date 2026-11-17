export interface ThreadPullIdentity {
  repo: string;
  number: number;
}
interface Entry extends ThreadPullIdentity {
  threadId: string;
  at: number;
}
const KEY = "bb-plugin-github-fred:thread-pulls:v1";
const MAX_AGE = 5 * 60_000;

/** Keep recent associations through navigation and frontend plugin reloads. */
export function createThreadPullCache() {
  let entries: Entry[] = [];
  function read() {
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
      if (Array.isArray(raw)) {
        entries = raw
          .filter(
            (entry): entry is Entry =>
              entry !== null &&
              typeof entry === "object" &&
              typeof entry.threadId === "string" &&
              entry.threadId.length <= 200 &&
              typeof entry.repo === "string" &&
              /^[\w.-]+\/[\w.-]+$/.test(entry.repo) &&
              Number.isSafeInteger(entry.number) &&
              entry.number > 0 &&
              typeof entry.at === "number" &&
              entry.at <= Date.now() &&
              Date.now() - entry.at < MAX_AGE,
          )
          .slice(-100);
      }
    } catch {
      /* Storage can be unavailable; retain this window's memory copy. */
    }
    return entries.filter((entry) => Date.now() - entry.at < MAX_AGE);
  }
  function write(next: Entry[]) {
    entries = next;
    try {
      sessionStorage.setItem(KEY, JSON.stringify(entries));
    } catch {}
  }
  return {
    get(threadId: string): ThreadPullIdentity | null {
      const entry = read().find((entry) => entry.threadId === threadId);
      return entry ? { repo: entry.repo, number: entry.number } : null;
    },
    set(threadId: string, pull: ThreadPullIdentity | null) {
      const next = read().filter((entry) => entry.threadId !== threadId);
      if (pull) next.push({ threadId, ...pull, at: Date.now() });
      write(next.slice(-100));
    },
    clear() {
      write([]);
    },
  };
}
export const threadPullCache = createThreadPullCache();
