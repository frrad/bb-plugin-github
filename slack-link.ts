/** Accept message permalinks only; the plugin never fetches the pasted URL. */
export function normalizeSlackLink(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      !/^\/archives\/[CDG][A-Z0-9]+\/p\d{16,20}\/?$/.test(url.pathname)
    )
      throw new Error();
    const thread = url.searchParams.get("thread_ts");
    if (thread !== null && !/^\d{10,14}\.\d{6}$/.test(thread))
      throw new Error();
    const clean = new URL(url.origin + url.pathname.replace(/\/$/, ""));
    if (thread) clean.searchParams.set("thread_ts", thread);
    return clean.toString();
  } catch {
    throw new Error(
      "Paste a Slack message link (https://your-workspace.slack.com/archives/…/p…).",
    );
  }
}
