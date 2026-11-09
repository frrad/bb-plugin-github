# GitHub Fred (`bb-plugin-github-fred`)

GitHub issues and pull requests inside BB, with one-click agent dispatch.

Fred's standalone fork of BB's GitHub plugin. Its plugin id, panel route, CLI
command, and browser storage key use `github-fred`, so it can run alongside the
built-in `github` plugin.

Install the fork from GitHub:

```sh
bb plugin install https://github.com/frrad/bb-plugin-github
```

## What it does

- **Sidebar panel** (GitHub logo, full width): a stack of named searches across
  every tracked repo, with a Repo column in each list. Each search has its own Issues/Pull requests dropdown and filter.
  Use **Add search**, edit its name, collapse it with the chevron, reorder it with
  the up/down arrows, or remove it with the trash button. Names, filters, search
  types, order, and collapsed state are remembered in this browser. Your
  previous single search becomes the first section automatically. Direct issue
  and PR links still open their details. Issue searches include a New issue form.
  Click a column header to cycle ascending, descending, and original order.
  Drag the divider at a header's right edge to resize that column; double-click
  it to reset its width. Focus a divider and use the arrow keys to resize with
  the keyboard. Sorting and widths are saved separately for each search.
- **Issue detail**: markdown body, comments, comment box, status,
  assignee, and label editing, plus "Send agent".
  Deep-linkable via the URL hash: `#/issues/<owner>/<repo>/<number>`.
- **Send agent / Review with agent**: spawns a BB worker thread on the issue
  (or a review thread on the PR) in the repo's BB project. The issue/PR then
  shows a ⚡ pill linking to the thread.
- **Homepage section**: recent open issues with the same Send agent buttons.
- **Mentions**: `@` or `#` in any composer completes GitHub issues and PRs; the
  selected item's title/body/state is attached as agent context at send time.
- **`bb github-fred` CLI**: `repos`, `issues [repo]`, `prs [repo]`, `sync` — also
  discoverable by agents through the plugin-commands skill. Each command takes
  `--json` (`{"ok":true,…}` on success, `{"ok":false,"error":{…}}` on failure)
  and `--help`, which prints its arguments and options and exits 0.

## Auth

Uses the GitHub CLI. If `gh auth status` passes, the plugin works; otherwise
it reports needs-configuration. No tokens are stored by the plugin.

## Which repos are tracked

- Every BB project source whose checkout has a GitHub `origin` remote
  (repo → project mapping is also how spawn picks the project).
- Plus the `extraRepos` setting: comma-separated `owner/repo` list. Entries that
  are not `owner/repo` — a `owner/*` wildcard, a bare owner, a typo — are not
  tracked; `bb github-fred repos` names them on stderr and the plugin log warns once
  per distinct set. Wildcards are not supported.
- `defaultProject` setting: where threads spawn for repos with no project.

```
bb plugin config github-fred set extraRepos "owner/repo, owner/other"
bb plugin reload github-fred
```

A background service refreshes immediately on startup, then waits 15 minutes
after each completed sync. Each tracked repository uses one bounded `gh api graphql`
request per sweep, using the existing GitHub CLI authentication. Two repositories
are fetched concurrently, respecting BB's GitHub process limit. Refresh requests
share an active sweep, and the refresh button shows completed/total repositories
and any failed repository count. Failed repositories keep their cached rows. It fetches
100 open and 50 closed issues, plus 50 open and 30 closed or merged PRs,
ordered by creation time descending. Labels and assignees are each limited to
100 per item, matching the previous list commands. Repositories with Issues
disabled still sync PRs. Failed or incomplete repository responses retain that
repository’s cached rows.

Batching reduces list-fetch process invocations from four to one per repository
(75%). This does not measure GraphQL rate-limit point savings.
Background data may take 15 minutes plus sync time to refresh. Opening the panel
starts a background GitHub sync only if the last successful sync is at least ten
minutes old (or no sync time is known). While this app window stays open, previously
loaded rows, repository status, and thread links are kept in memory so returning
to the page shows cached results immediately. Reads revalidate in the background;
failed reads retain the previous results.

The existing Refresh button, the `refresh` RPC, or `bb github-fred sync` always
starts a sync immediately, regardless of data age. The button spins until the
GitHub sync and list revalidation finish; this can take longer than showing cached rows because it queries each
tracked repository. Automatic and manual page refreshes share in-flight work.

Transient authentication failures and failures across all repositories retain
the existing retry backoff: 30 seconds, doubling to a five-minute cap, reset
after a successful sync. Partial repository failures use the normal interval.
The interval is internal policy; there is no polling setting.

## Development

Requires Node.js 22 or newer and npm. No BB monorepo checkout is needed.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

The pinned `bb-app` development dependency supplies the `bb` build CLI, so the
build does not need a running BB server or a global BB installation. Build output
is generated in `dist/`. Runtime libraries needed for a Git install are declared
in `dependencies`; development dependencies supply types, tests, and the CLI. The SDK is a runtime
dependency because the backend bundles its process and host helpers.

UI components are vendored under `components/ui/` and `lib/` from BB's
MIT-licensed registry, pinned in `components.json` to `desktop-v0.48.1`. The public
SDK is pinned to `0.6.104`. To add UI components, use
`npx shadcn add @bb/<component>`, then run `npm install`.

When updating BB/SDK versions, update the pinned CLI, SDK, engine range, and
registry tag together. In BB 0.48.1, `bb plugin types` recommends moving the SDK
into `devDependencies`. Keep it in `dependencies` here: the backend imports
`@get-bb/plugin-sdk/process` and `@get-bb/plugin-sdk/host`, which the build bundles
from the installed SDK. Git installs omit development dependencies.

For live development in BB:

```sh
bb plugin install .
bb plugin dev
```

This fork was split from `get-bb/bb`'s `plugins/github` at upstream commit
`55135d1e50`, retaining its history and MIT license.
