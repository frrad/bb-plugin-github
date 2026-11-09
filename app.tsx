import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  Markdown,
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
  experimental_copyToClipboard,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
  type PluginRpcResult,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import {
  buildSuggestions,
  matchesQuery,
  parseQuery,
  parseSubPath,
  routeToSubPath,
  type Item,
  type Route,
  type Suggestion,
  type SuggestionIcon,
} from "./app-logic.js";
import type { githubRpcContract } from "./server.js";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  TABLE_COLUMNS,
  COLUMN_LABELS,
  defaultWidths,
  clampWidth,
  sortItems,
  type TableColumn,
  type TablePreferences,
} from "./table-layout.js";
import { panelCache, isSyncStale } from "./panel-cache.js";
import { EmptyState } from "./components/empty-state.js";
import { Icon } from "@/components/ui/icon";
import {
  SEARCHES_KEY,
  parseSavedSearches,
  moveSearch,
  type SavedSearch,
} from "./saved-searches.js";

type IssueDetail = PluginRpcResult<
  (typeof githubRpcContract)["getIssue"]
>["issue"];
type PullDetail = PluginRpcResult<
  (typeof githubRpcContract)["getPull"]
>["pull"];
type PullCheck = PullDetail["checks"][number];
type ReviewThread = PullDetail["reviewThreads"][number];
type PullFile = PullDetail["files"][number];
type Status = PluginRpcResult<(typeof githubRpcContract)["status"]>;
type RepoInfo = Status["repos"][number];
type LinksMap = PluginRpcResult<
  (typeof githubRpcContract)["listLinks"]
>["links"];
type ThreadLink = LinksMap[string][number];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const PANEL_PATH = "github-fred";
const TAB_KEY = "bb-plugin-github-fred:tab";

function useSubPathRoute(subPath: string): [Route, (route: Route) => void] {
  const bbNavigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const navigate = useCallback(
    (next: Route) => {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) });
    },
    [bbNavigate],
  );
  return [route, navigate];
}

function useItems(kind: "issue" | "pr"): {
  items: Item[] | null;
  error: string | null;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const cache = kind === "issue" ? panelCache.issues : panelCache.pulls;
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const load = useCallback(
    () => rpc.call("listItems", { kind }).then((result) => result.items),
    [rpc, kind],
  );
  useEffect(() => {
    void cache.refresh(load);
  }, [cache, load]);
  useRealtime("data-changed", () => {
    void cache.refresh(load, true);
  });
  return { items: state.data, error: state.error };
}

function useLinks(): LinksMap {
  const rpc = useRpc<typeof githubRpcContract>();
  const cache = panelCache.links;
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const load = useCallback(
    () => rpc.call("listLinks").then((result) => result.links),
    [rpc],
  );
  useEffect(() => {
    void cache.refresh(load);
  }, [cache, load]);
  useRealtime("links-changed", () => {
    void cache.refresh(load, true);
  });
  return state.data ?? {};
}

function useSpawn(): {
  spawn: (
    method: "startWork" | "startReview",
    repo: string,
    number: number,
  ) => void;
  spawningKey: string | null;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const navigate = useBbNavigate();
  const [spawningKey, setSpawningKey] = useState<string | null>(null);
  const spawn = useCallback(
    (method: "startWork" | "startReview", repo: string, number: number) => {
      setSpawningKey(`${repo}#${number}`);
      rpc
        .call(method, { repo, number })
        .then((result) => {
          navigate.toThread(result.threadId);
        })
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setSpawningKey(null));
    },
    [rpc, navigate],
  );
  return { spawn, spawningKey };
}

function useViewer(): string | null {
  const rpc = useRpc<typeof githubRpcContract>();
  const cache = panelCache.viewer;
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  useEffect(() => {
    if (cache.getSnapshot().data !== null) return;
    void cache.refresh(() => rpc.call("viewer").then((result) => result.login));
  }, [cache, rpc]);
  return state.data;
}

function Avatar({
  login,
  size = "size-5",
  className,
}: {
  login: string;
  size?: string;
  className?: string;
}) {
  return (
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=64`}
      alt={login}
      title={login}
      loading="lazy"
      className={`${size} shrink-0 rounded-full bg-muted ${className ?? ""}`}
    />
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 opacity-50"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-15.2-6.5L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15.2 6.5L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

function stateDotClass(kind: "issue" | "pr", state: string): string {
  if (state === "OPEN") return "bg-green-500";
  if (kind === "pr" && state === "MERGED") return "bg-purple-500";
  if (kind === "pr") return "bg-red-500";
  return "bg-purple-500";
}

function StateDot({ kind, state }: { kind: "issue" | "pr"; state: string }) {
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${stateDotClass(kind, state)}`}
    />
  );
}

function StateBadge({ kind, state }: { kind: "issue" | "pr"; state: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateDot kind={kind} state={state} />
      {state.toLowerCase()}
    </Badge>
  );
}

function ThreadPills({ links }: { links: ThreadLink[] | undefined }) {
  const navigate = useBbNavigate();
  if (links === undefined || links.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {links.map((link, index) => (
        <Badge
          key={link.threadId}
          title={`Open BB thread ${link.threadId}`}
          onClick={(event) => {
            event.stopPropagation();
            navigate.toThread(link.threadId);
          }}
          variant="secondary"
          className="cursor-pointer whitespace-nowrap hover:bg-accent"
        >
          ⚡ agent{links.length > 1 ? ` ${index + 1}` : ""}
        </Badge>
      ))}
    </span>
  );
}

function LabelChips({
  labels,
  className,
}: {
  labels: string[];
  className?: string;
}) {
  if (labels.length === 0) return null;
  return (
    <span className={`items-center gap-1 ${className ?? "flex shrink-0"}`}>
      {labels.slice(0, 3).map((label) => (
        <Badge
          key={label}
          variant="secondary"
          className="font-normal text-muted-foreground"
        >
          {label}
        </Badge>
      ))}
    </span>
  );
}

function useIssueMutations() {
  const rpc = useRpc<typeof githubRpcContract>();
  const setIssueState = useCallback(
    (repo: string, number: number, state: "open" | "closed") =>
      rpc
        .call("setIssueState", { repo, number, state })
        .then(() =>
          toast.success(
            state === "closed" ? `#${number} closed` : `#${number} reopened`,
          ),
        ),
    [rpc],
  );
  const setAssignees = useCallback(
    (repo: string, number: number, assignees: string[]) =>
      rpc.call("setAssignees", { repo, number, assignees }),
    [rpc],
  );
  const setLabels = useCallback(
    (repo: string, number: number, labels: string[]) =>
      rpc.call("setLabels", { repo, number, labels }),
    [rpc],
  );
  return { setIssueState, setAssignees, setLabels };
}

function FilterSuggestionIcon({ icon }: { icon: SuggestionIcon }) {
  if (icon.kind === "state") {
    return <StateDot kind={icon.itemKind} state={icon.state} />;
  }
  return <Avatar login={icon.login} size="size-4" />;
}

function FilterBar({
  value,
  onChange,
  items,
  repos,
  kind,
}: {
  value: string;
  onChange: (value: string) => void;
  items: Item[] | null;
  repos: RepoInfo[];
  kind: "issue" | "pr";
}) {
  const viewer = useViewer();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [highlight, setHighlight] = useState(0);

  const vocab = useMemo(() => {
    const users = new Set<string>();
    const labels = new Set<string>();
    for (const item of items ?? []) {
      if (item.author.length > 0) users.add(item.author);
      for (const login of item.assignees) users.add(login);
      for (const label of item.labels) labels.add(label);
    }
    return {
      users: [...users].sort((a, b) => a.localeCompare(b)),
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
      repos: repos.map((entry) => entry.repo),
    };
  }, [items, repos]);

  const upToCaret = value.slice(0, caret);
  const tokenStart = upToCaret.lastIndexOf(" ") + 1;
  const token = upToCaret.slice(tokenStart);
  const suggestions = useMemo(
    () => buildSuggestions(token, vocab, kind, viewer).slice(0, 8),
    [token, vocab, kind, viewer],
  );
  const active = Math.min(highlight, Math.max(0, suggestions.length - 1));

  const syncCaret = () =>
    setCaret(inputRef.current?.selectionStart ?? value.length);

  const accept = (suggestion: Suggestion) => {
    const next =
      value.slice(0, tokenStart) + suggestion.insert + value.slice(caret);
    onChange(next);
    const position = tokenStart + suggestion.insert.length;
    setCaret(position);
    setHighlight(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || suggestions.length === 0) {
      if (event.key === "ArrowDown") setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((active + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((active - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(suggestions[active]);
    }
  };

  return (
    <div className="group/filter relative">
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlight(0);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={syncCaret}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        aria-label="Search filter"
        placeholder="Filter — is:open assignee:@me label:bug, or plain text"
        className="flex h-8 w-full rounded-md border border-transparent bg-transparent px-3 py-1 pr-8 text-sm transition-colors placeholder:text-muted-foreground hover:border-input focus-visible:border-input focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        spellCheck={false}
        autoComplete="off"
      />
      {value.length > 0 ? (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/filter:opacity-100 group-focus-within/filter:opacity-100"
          onMouseDown={(event) => {
            event.preventDefault();
            onChange("");
            setCaret(0);
            inputRef.current?.focus();
          }}
          aria-label="Clear filter"
        >
          ✕
        </button>
      ) : null}
      {open && suggestions.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.insert}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                index === active
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(suggestion);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              {suggestion.icon !== undefined ? (
                <FilterSuggestionIcon icon={suggestion.icon} />
              ) : null}
              <span className="min-w-0 truncate font-medium">
                {suggestion.label}
              </span>
              {suggestion.hint !== undefined ? (
                <span className="ml-auto shrink-0 pl-4 text-xs text-muted-foreground">
                  {suggestion.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const COL = {
  id: "min-w-0 truncate",
  repo: "hidden min-w-0 truncate @[48rem]:block",
  assignee: "min-w-0",
  status: "min-w-0",
  updated: "hidden min-w-0 truncate text-right @[48rem]:block",
  actions: "ml-auto flex shrink-0 items-center justify-end gap-1 @[48rem]:ml-0",
} as const;

function AssigneeCell({ assignees }: { assignees: string[] }) {
  if (assignees.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return (
    <span
      className="flex items-center -space-x-1.5"
      title={assignees.join(", ")}
    >
      {assignees.slice(0, 3).map((login) => (
        <Avatar key={login} login={login} className="ring-1 ring-card" />
      ))}
      {assignees.length > 3 ? (
        <span className="pl-2.5 text-xs text-muted-foreground">
          +{assignees.length - 3}
        </span>
      ) : null}
    </span>
  );
}

function StatusCell({ item }: { item: Item }) {
  const { setIssueState } = useIssueMutations();
  const [pending, setPending] = useState(false);
  if (item.kind === "pr") {
    return <StateBadge kind="pr" state={item.state} />;
  }
  const change = (next: "open" | "closed") => {
    if ((item.state === "OPEN") === (next === "open")) return;
    setPending(true);
    setIssueState(item.repo, item.number, next)
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPending(false));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={pending}>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs font-normal"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Change issue #${item.number} state, currently ${item.state.toLowerCase()}`}
          aria-busy={pending}
        >
          <StateDot kind="issue" state={item.state} />
          <span>{pending ? "…" : item.state.toLowerCase()}</span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => change("open")}>
          <StateDot kind="issue" state="OPEN" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => change("closed")}>
          <StateDot kind="issue" state="CLOSED" />
          Closed
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowMenu({ item }: { item: Item }) {
  const navigate = useBbNavigate();
  const viewer = useViewer();
  const { setIssueState, setAssignees } = useIssueMutations();
  const assignedToMe = viewer !== null && item.assignees.includes(viewer);

  const toggleSelfAssign = () => {
    if (viewer === null) return;
    const next = assignedToMe
      ? item.assignees.filter((login) => login !== viewer)
      : [...item.assignees, viewer];
    setAssignees(item.repo, item.number, next)
      .then(() =>
        toast.success(
          assignedToMe
            ? `Unassigned from #${item.number}`
            : `Assigned to #${item.number}`,
        ),
      )
      .catch((error: unknown) => toast.error(errorText(error)));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          ⋮
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {item.kind === "issue" && viewer !== null ? (
          <DropdownMenuItem onSelect={toggleSelfAssign}>
            {assignedToMe ? "Unassign me" : "Assign to me"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? (
          <DropdownMenuItem
            onSelect={() =>
              setIssueState(
                item.repo,
                item.number,
                item.state === "OPEN" ? "closed" : "open",
              ).catch((error: unknown) => toast.error(errorText(error)))
            }
          >
            {item.state === "OPEN" ? "Close issue" : "Reopen issue"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          onSelect={() => {
            navigate.openUrl(item.url);
          }}
        >
          Open on GitHub ↗
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void experimental_copyToClipboard({ text: item.url }).then(
              (copied) => {
                if (copied) toast.success("Link copied");
                else toast.error("Could not copy the link");
              },
            );
          }}
        >
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemRow({
  item,
  links,
  onOpen,
}: {
  item: Item;
  links: ThreadLink[] | undefined;
  onOpen: () => void;
}) {
  const { spawn, spawningKey } = useSpawn();
  const busy = spawningKey === `${item.repo}#${item.number}`;
  return (
    <div
      role="row"
      className="grid cursor-pointer grid-cols-1 gap-y-2 px-3 py-3 hover:bg-accent/50 @[48rem]:grid @[48rem]:grid-cols-[var(--table-columns)] @[48rem]:items-center @[48rem]:gap-3 @[48rem]:py-2"
      onClick={onOpen}
    >
      <span
        role="cell"
        className="flex min-w-0 flex-col items-start gap-1.5 @[48rem]:order-2 @[48rem]:flex-1 @[48rem]:flex-row @[48rem]:items-center @[48rem]:gap-2"
      >
        <span className="min-w-0 flex-1 line-clamp-3 text-sm font-medium leading-snug text-foreground @[48rem]:line-clamp-1 @[48rem]:leading-normal">
          {item.title}
        </span>
        <span
          className="text-xs text-muted-foreground @[48rem]:hidden"
          title={item.repo}
        >
          {item.repo.split("/").pop()}
        </span>
        <LabelChips
          labels={item.labels}
          className="hidden shrink-0 @[60rem]:flex"
        />
        <ThreadPills links={links} />
      </span>
      <span
        role="presentation"
        className="flex min-w-0 items-center gap-2 @[48rem]:contents"
      >
        <span
          role="cell"
          className={`${COL.id} font-mono text-xs text-muted-foreground @[48rem]:order-1`}
        >
          #{item.number}
        </span>
        <span
          role="cell"
          className={`${COL.repo} text-xs text-muted-foreground @[48rem]:order-3`}
          title={item.repo}
        >
          {item.repo.split("/").pop()}
        </span>
        <span
          role="cell"
          className={`${COL.assignee} ${item.assignees.length === 0 ? "hidden @[48rem]:flex" : "flex"} text-xs text-muted-foreground @[48rem]:order-4`}
        >
          <AssigneeCell assignees={item.assignees} />
        </span>
        <span role="cell" className={`${COL.status} @[48rem]:order-5`}>
          <StatusCell item={item} />
        </span>
        <span
          role="cell"
          className={`${COL.updated} text-xs text-muted-foreground @[48rem]:order-6`}
        >
          {relativeTime(item.updatedAt)}
        </span>
        <span role="cell" className={`${COL.actions} @[48rem]:order-7`}>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={spawningKey !== null}
            onClick={(event) => {
              event.stopPropagation();
              spawn(
                item.kind === "issue" ? "startWork" : "startReview",
                item.repo,
                item.number,
              );
            }}
          >
            {busy ? "…" : item.kind === "issue" ? "Start" : "Review"}
          </Button>
          {item.kind === "pr" ? (
            <>
              <Button size="sm" variant="outline" className="h-7" asChild>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open on GitHub in your browser"
                  onClick={(event) => event.stopPropagation()}
                >
                  GitHub
                </a>
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="size-7"
                aria-label="Copy GitHub link"
                onClick={(event) => {
                  event.stopPropagation();
                  void experimental_copyToClipboard({ text: item.url }).then(
                    (copied) => {
                      if (copied) toast.success("Link copied");
                      else toast.error("Could not copy the link");
                    },
                  );
                }}
              >
                <Icon name="Link" className="size-3.5" />
              </Button>
            </>
          ) : (
            <RowMenu item={item} />
          )}
        </span>
      </span>
    </div>
  );
}

function TableSkeleton() {
  return (
    <DelayedLoading>
      <div className="divide-y divide-border">
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="grid grid-cols-1 gap-y-3 px-3 py-3 @[48rem]:grid @[48rem]:grid-cols-[var(--table-columns)] @[48rem]:items-center @[48rem]:gap-3"
          >
            <Skeleton className="h-3 w-4/5 @[48rem]:order-2 @[48rem]:flex-1" />
            <span className="flex items-center gap-2 @[48rem]:contents">
              <span className={`${COL.id} @[48rem]:order-1`}>
                <Skeleton className="h-3 w-10" />
              </span>
              <span className={`${COL.repo} @[48rem]:order-3`}>
                <Skeleton className="h-3 w-24" />
              </span>
              <span className={`${COL.assignee} flex @[48rem]:order-4`}>
                <Skeleton className="size-5 rounded-full @[48rem]:h-3 @[48rem]:w-16" />
              </span>
              <span className={`${COL.status} @[48rem]:order-5`}>
                <Skeleton className="h-3 w-16" />
              </span>
              <span className={`${COL.updated} @[48rem]:order-6`}>
                <Skeleton className="ml-auto h-3 w-12" />
              </span>
              <span className={`${COL.actions} @[48rem]:order-7`}>
                <Skeleton className="h-7 w-20" />
              </span>
            </span>
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

function DetailSkeleton() {
  return (
    <DelayedLoading>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    </DelayedLoading>
  );
}

function ItemsTable({
  kind,
  items,
  error,
  hasFilter,
  onOpenItem,
  preferences,
  onPreferencesChange,
}: {
  kind: "issue" | "pr";
  items: Item[] | null;
  error: string | null;
  hasFilter: boolean;
  onOpenItem: (repo: string, number: number) => void;
  preferences?: TablePreferences;
  onPreferencesChange: (preferences: TablePreferences) => void;
}) {
  const links = useLinks();
  const [preview, setPreview] = useState<Partial<Record<TableColumn, number>>>(
    {},
  );
  const drag = useRef<{
    column: TableColumn;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);
  const widths = { ...defaultWidths(kind), ...preferences?.widths, ...preview };
  for (const column of TABLE_COLUMNS)
    widths[column] = clampWidth(column, widths[column], kind);
  const columns = TABLE_COLUMNS.map((column) =>
    column === "title" &&
    preferences?.widths?.title === undefined &&
    preview.title === undefined
      ? "minmax(120px, 1fr)"
      : `${widths[column]}px`,
  ).join(" ");
  const minimum = TABLE_COLUMNS.reduce(
    (total, column) =>
      total +
      (column === "title" &&
      preferences?.widths?.title === undefined &&
      preview.title === undefined
        ? 120
        : widths[column]),
    24 + 6 * 12,
  );
  const sorted = useMemo(
    () => (items === null ? null : sortItems(items, preferences?.sort)),
    [items, preferences?.sort],
  );
  const saveWidth = (column: TableColumn, width: number) =>
    onPreferencesChange({
      ...preferences,
      widths: {
        ...preferences?.widths,
        [column]: clampWidth(column, width, kind),
      },
    });

  let body: React.ReactNode;
  if (error !== null && items === null) {
    body = <EmptyState message={error} />;
  } else if (items === null) {
    body = <TableSkeleton />;
  } else if (items.length === 0) {
    body = (
      <EmptyState
        message={
          hasFilter
            ? `No ${kind === "issue" ? "issues" : "pull requests"} match this filter.`
            : `No ${kind === "issue" ? "issues" : "pull requests"} in the tracked repos.`
        }
      />
    );
  } else {
    body = (
      <div className="divide-y divide-border">
        {sorted!.map((item) => (
          <ItemRow
            key={`${item.repo}#${item.number}`}
            item={item}
            links={links[`${kind}:${item.repo}#${item.number}`]}
            onOpen={() => onOpenItem(item.repo, item.number)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      role="table"
      className="@container overflow-hidden rounded-lg border border-border bg-card"
      style={
        {
          "--table-columns": columns,
          "--table-min-width": `${minimum}px`,
        } as React.CSSProperties
      }
    >
      <div className="overflow-x-auto">
        <div className="@[48rem]:min-w-[var(--table-min-width)]">
          <div
            role="row"
            className="hidden grid-cols-[var(--table-columns)] items-center gap-3 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground @[48rem]:grid"
          >
            {TABLE_COLUMNS.map((column) => (
              <div
                key={column}
                role="columnheader"
                aria-sort={
                  column === preferences?.sort?.column
                    ? preferences.sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className="relative min-w-0"
              >
                {column === "actions" ? (
                  <span className="sr-only">Actions</span>
                ) : (
                  <button
                    className="flex w-full min-w-0 items-center gap-1 truncate rounded py-1 text-left uppercase hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => {
                      const current = preferences?.sort;
                      const sort =
                        current?.column !== column
                          ? { column, direction: "asc" as const }
                          : current.direction === "asc"
                            ? { column, direction: "desc" as const }
                            : undefined;
                      onPreferencesChange({ ...preferences, sort });
                    }}
                  >
                    {COLUMN_LABELS[column]}
                    {preferences?.sort?.column === column ? (
                      <span aria-hidden="true">
                        {preferences.sort.direction === "asc" ? "↑" : "↓"}
                      </span>
                    ) : null}
                  </button>
                )}
                <div
                  role="separator"
                  tabIndex={0}
                  aria-label={`Resize ${COLUMN_LABELS[column]} column`}
                  aria-orientation="vertical"
                  title="Drag to resize; double-click to reset. Arrow keys also resize."
                  aria-valuemin={clampWidth(column, 0, kind)}
                  aria-valuemax={1200}
                  aria-valuenow={widths[column]}
                  className="absolute -right-2 top-0 h-full w-2 cursor-col-resize touch-none select-none border-r border-border hover:border-foreground focus-visible:border-foreground focus-visible:outline-none"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const width =
                      event.currentTarget.parentElement?.getBoundingClientRect()
                        .width || widths[column];
                    drag.current = {
                      column,
                      startX: event.clientX,
                      startWidth: width,
                      width,
                    };
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const active = drag.current;
                    if (!active || active.column !== column) return;
                    active.width = clampWidth(
                      column,
                      active.startWidth + event.clientX - active.startX,
                      kind,
                    );
                    setPreview({ [column]: active.width });
                  }}
                  onPointerUp={(event) => {
                    const active = drag.current;
                    if (!active || active.column !== column) return;
                    drag.current = null;
                    saveWidth(column, active.width);
                    setPreview({});
                    if (
                      event.currentTarget.hasPointerCapture?.(event.pointerId)
                    )
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                    setPreview({});
                  }}
                  onLostPointerCapture={() => {
                    drag.current = null;
                    setPreview({});
                  }}
                  onDoubleClick={() => {
                    const next = { ...preferences?.widths };
                    delete next[column];
                    onPreferencesChange({ ...preferences, widths: next });
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "ArrowLeft" &&
                      event.key !== "ArrowRight" &&
                      event.key !== "Home"
                    )
                      return;
                    event.preventDefault();
                    saveWidth(
                      column,
                      event.key === "Home"
                        ? defaultWidths(kind)[column]
                        : widths[column] +
                            (event.key === "ArrowRight" ? 16 : -16),
                    );
                  }}
                />
              </div>
            ))}
          </div>
          {error !== null && items !== null ? (
            <p
              role="status"
              className="px-3 py-2 text-xs text-muted-foreground"
            >
              Showing cached results. Could not refresh: {error}
            </p>
          ) : null}
          {body}
        </div>
      </div>
    </div>
  );
}

function SidebarHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function AssigneePicker({
  repo,
  assignees,
  onToggle,
}: {
  repo: string;
  assignees: string[];
  onToggle: (login: string, assigned: boolean) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const viewer = useViewer();
  const [users, setUsers] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (users !== null) return;
    rpc.call("assignableUsers", { repo }).then(
      (result) => setUsers(result.users),
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc, repo, users]);

  const ordered =
    users === null
      ? null
      : [...users].sort((a, b) => Number(b === viewer) - Number(a === viewer));

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto"
      >
        <DropdownMenuLabel>Assignees</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No assignable users</DropdownMenuItem>
        ) : (
          ordered.map((login) => (
            <DropdownMenuCheckboxItem
              key={login}
              checked={assignees.includes(login)}
              onCheckedChange={(checked) => onToggle(login, checked)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Avatar login={login} size="size-4" />
                <span className="truncate">
                  {login}
                  {login === viewer ? " (you)" : ""}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelPicker({
  repo,
  labels,
  onToggle,
}: {
  repo: string;
  labels: string[];
  onToggle: (label: string, enabled: boolean) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [available, setAvailable] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (available !== null) return;
    rpc.call("repositoryLabels", { repo }).then(
      (result) => setAvailable(result.labels),
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc, repo, available]);

  const ordered =
    available === null
      ? null
      : [...new Set([...labels, ...available])].sort((a, b) =>
          a.localeCompare(b),
        );

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto"
      >
        <DropdownMenuLabel>Labels</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No labels in repo</DropdownMenuItem>
        ) : (
          ordered.map((label) => (
            <DropdownMenuCheckboxItem
              key={label}
              checked={labels.includes(label)}
              onCheckedChange={(checked) => onToggle(label, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="min-w-0 truncate">{label}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IssueDetailView({
  repo,
  number,
  onBack,
}: {
  repo: string;
  number: number;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const { setIssueState, setAssignees, setLabels } = useIssueMutations();
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(() => {
    rpc.call("getIssue", { repo, number }).then(
      (result) => {
        setDetail(result.issue);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, repo, number]);
  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

  const changeState = useCallback(
    (next: "open" | "closed") => {
      setDetail((prev) =>
        prev === null
          ? prev
          : { ...prev, state: next === "closed" ? "CLOSED" : "OPEN" },
      );
      setIssueState(repo, number, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setIssueState, repo, number, load],
  );

  const toggleAssignee = useCallback(
    (login: string, assigned: boolean) => {
      let next: string[] = [];
      setDetail((prev) => {
        if (prev === null) return prev;
        next = assigned
          ? [...new Set([...prev.assignees, login])]
          : prev.assignees.filter((entry) => entry !== login);
        return { ...prev, assignees: next };
      });
      setAssignees(repo, number, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setAssignees, repo, number, load],
  );

  const toggleLabel = useCallback(
    (label: string, enabled: boolean) => {
      let next: string[] = [];
      setDetail((prev) => {
        if (prev === null) return prev;
        next = enabled
          ? [...new Set([...prev.labels, label])]
          : prev.labels.filter((entry) => entry !== label);
        return { ...prev, labels: next };
      });
      setLabels(repo, number, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setLabels, repo, number, load],
  );

  const postComment = useCallback(() => {
    if (comment.trim().length === 0) return;
    setPosting(true);
    rpc
      .call("commentIssue", { repo, number, body: comment })
      .then(() => {
        setComment("");
        load();
      })
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setPosting(false));
  }, [rpc, repo, number, comment, load]);

  if (error !== null) return <EmptyState message={error} />;
  if (detail === null) {
    return <DetailSkeleton />;
  }

  const issueLinks = links[`issue:${repo}#${number}`];
  return (
    <div className="@container/github-detail flex flex-col gap-4">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onBack}>
          ← Issues
        </Button>
        <span>
          {repo} · #{number}
        </span>
        <span className="flex-1" />
        <UrlLink href={detail.url} className="underline hover:text-foreground">
          Open on GitHub ↗
        </UrlLink>
      </div>

      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-xl font-semibold text-foreground">
          {detail.title}{" "}
          <span className="font-normal text-muted-foreground">
            #{detail.number}
          </span>
        </h2>
        <Button
          size="sm"
          disabled={spawningKey !== null}
          onClick={() => spawn("startWork", repo, number)}
        >
          {spawningKey !== null ? "Starting…" : "Send agent"}
        </Button>
      </div>

      <div className="flex flex-col gap-6 @min-[56rem]/github-detail:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
              <Avatar login={detail.author} />
              <span className="font-medium text-foreground">
                {detail.author}
              </span>
              opened this issue · updated {relativeTime(detail.updatedAt)}
            </div>
            <div className="p-4">
              {detail.body.length > 0 ? (
                <Markdown content={detail.body} className="text-sm" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  (no description)
                </p>
              )}
            </div>
          </div>

          {detail.comments.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-muted-foreground">
                Activity · {detail.comments.length}
              </h3>
              {detail.comments.map((entry, index) => (
                <div
                  key={index}
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <Avatar login={entry.author} />
                    <span className="font-medium text-foreground">
                      {entry.author}
                    </span>{" "}
                    · {relativeTime(entry.createdAt)}
                  </p>
                  <Markdown content={entry.body} className="text-sm" />
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Leave a comment…"
              rows={3}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={posting || comment.trim().length === 0}
                onClick={postComment}
              >
                {posting ? "Posting…" : "Comment"}
              </Button>
            </div>
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-5 @min-[56rem]/github-detail:w-56">
          <div className="flex flex-col gap-2">
            <SidebarHeading>Status</SidebarHeading>
            <Select
              value={detail.state === "OPEN" ? "open" : "closed"}
              onValueChange={(value) =>
                changeState(value === "closed" ? "closed" : "open")
              }
            >
              <SelectTrigger className="h-8 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">
                  <span className="flex items-center gap-2">
                    <StateDot kind="issue" state="OPEN" /> Open
                  </span>
                </SelectItem>
                <SelectItem value="closed">
                  <span className="flex items-center gap-2">
                    <StateDot kind="issue" state="CLOSED" /> Closed
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <SidebarHeading>Assignees</SidebarHeading>
              <AssigneePicker
                repo={repo}
                assignees={detail.assignees}
                onToggle={toggleAssignee}
              />
            </div>
            {detail.assignees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one assigned</p>
            ) : (
              detail.assignees.map((login) => (
                <p
                  key={login}
                  className="flex items-center gap-2 text-sm text-foreground"
                >
                  <Avatar login={login} />
                  <span className="truncate">{login}</span>
                </p>
              ))
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <SidebarHeading>Labels</SidebarHeading>
              <LabelPicker
                repo={repo}
                labels={detail.labels}
                onToggle={toggleLabel}
              />
            </div>
            {detail.labels.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet</p>
            ) : (
              <LabelChips labels={detail.labels} className="flex flex-wrap" />
            )}
          </div>

          {issueLinks !== undefined && issueLinks.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Agents</SidebarHeading>
              <ThreadPills links={issueLinks} />
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function pullStateBadgeParts(state: string): { dot: string; label: string } {
  if (state === "DRAFT")
    return { dot: "bg-muted-foreground/60", label: "draft" };
  if (state === "OPEN") return { dot: "bg-green-500", label: "open" };
  if (state === "MERGED") return { dot: "bg-purple-500", label: "merged" };
  return { dot: "bg-red-500", label: "closed" };
}

function PullStateBadge({ state }: { state: string }) {
  const { dot, label } = pullStateBadgeParts(state);
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      {label}
    </Badge>
  );
}

const REVIEW_STATE_LABELS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "review requested",
};

function reviewStateClass(state: string): string {
  if (state === "APPROVED") return "text-green-600 dark:text-green-400";
  if (state === "CHANGES_REQUESTED") return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

function ReviewDecisionBadge({ decision }: { decision: string }) {
  if (decision === "APPROVED") {
    return (
      <Badge className="bg-green-600 text-white hover:bg-green-600">
        approved
      </Badge>
    );
  }
  if (decision === "CHANGES_REQUESTED") {
    return <Badge variant="destructive">changes requested</Badge>;
  }
  if (decision === "REVIEW_REQUIRED") {
    return <Badge variant="secondary">review required</Badge>;
  }
  return null;
}

function checkDotClass(status: PullCheck["status"]): string {
  if (status === "success") return "bg-green-500";
  if (status === "failure") return "bg-red-500";
  if (status === "pending") return "animate-pulse bg-yellow-500";
  return "bg-muted-foreground/50";
}

function ChecksSection({ checks }: { checks: PullCheck[] }) {
  const [open, setOpen] = useState(() =>
    checks.some((check) => check.status === "failure"),
  );
  if (checks.length === 0) return null;
  const passing = checks.filter((check) => check.status === "success").length;
  const failing = checks.filter((check) => check.status === "failure").length;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span
          className={`size-2 shrink-0 rounded-full ${
            failing > 0
              ? "bg-red-500"
              : passing === checks.length
                ? "bg-green-500"
                : "animate-pulse bg-yellow-500"
          }`}
        />
        <span className="font-medium text-foreground">Checks</span>
        <span className="text-xs text-muted-foreground">
          {passing}/{checks.length} passing
          {failing > 0 ? ` · ${failing} failing` : ""}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="divide-y divide-border border-t border-border">
          {checks.map((check, index) => (
            <div
              key={`${check.name}-${index}`}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${checkDotClass(check.status)}`}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {check.name}
              </span>
              {check.url.length > 0 ? (
                <UrlLink
                  href={check.url}
                  className="shrink-0 text-muted-foreground underline hover:text-foreground"
                >
                  details ↗
                </UrlLink>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileDiffCard({
  environmentId,
  file,
  url,
}: {
  environmentId: string | null;
  file: PullFile;
  url: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="relative flex w-full select-none items-center gap-2 px-3 py-2 hover:bg-accent/50">
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground after:absolute after:inset-0 after:content-['']"
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path} diff`}
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "▾" : "▸"}
        </button>
        {environmentId === null || file.status === "removed" ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {file.path}
          </span>
        ) : (
          <FileLink
            className="relative min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:underline"
            target={{
              kind: "workspace",
              environmentId,
              path: file.path,
            }}
          >
            {file.path}
          </FileLink>
        )}
        {file.status !== "modified" ? (
          <Badge
            variant="secondary"
            className="shrink-0 font-normal text-muted-foreground"
          >
            {file.status}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-green-600 dark:text-green-400">
          +{file.additions}
        </span>
        <span className="shrink-0 text-xs text-red-600 dark:text-red-400">
          −{file.deletions}
        </span>
      </div>
      {open ? (
        file.patch !== null ? (
          <div className="border-t border-border">
            <Diff patch={file.patch} path={file.path} />
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Diff too large to inline —{" "}
            <UrlLink href={`${url}/files`} className="underline">
              view on GitHub ↗
            </UrlLink>
          </p>
        )
      ) : null}
    </div>
  );
}

function ReviewThreadCard({ thread }: { thread: ReviewThread }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <p className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{thread.path}</span>
        {thread.line !== null ? (
          <span className="shrink-0">:{thread.line}</span>
        ) : null}
      </p>
      {thread.diffHunk.length > 0 ? (
        <div className="border-b border-border">
          <Diff patch={thread.diffHunk} path={thread.path} />
        </div>
      ) : null}
      <div className="flex flex-col gap-3 p-3">
        {thread.comments.map((entry, index) => (
          <div key={index}>
            <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Avatar login={entry.author} size="size-4" />
              <span className="font-medium text-foreground">
                {entry.author}
              </span>{" "}
              · {relativeTime(entry.createdAt)}
            </p>
            <Markdown content={entry.body} className="text-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

type PullTimelineEntry =
  | { type: "comment"; author: string; body: string; createdAt: string }
  | {
      type: "review";
      author: string;
      state: string;
      body: string;
      createdAt: string;
    };

function PullTimeline({ pull }: { pull: PullDetail }) {
  const entries = useMemo<PullTimelineEntry[]>(() => {
    const merged: PullTimelineEntry[] = [
      ...pull.comments.map((comment) => ({
        type: "comment" as const,
        ...comment,
      })),
      ...pull.reviews
        .filter(
          (review) => review.body.length > 0 || review.state !== "COMMENTED",
        )
        .map((review) => ({ type: "review" as const, ...review })),
    ];
    return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [pull]);
  if (entries.length === 0 && pull.reviewThreads.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">
        Activity · {entries.length + pull.reviewThreads.length}
      </h3>
      {entries.map((entry, index) => (
        <div
          key={index}
          className="rounded-lg border border-border bg-card p-3"
        >
          <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar login={entry.author} />
            <span className="font-medium text-foreground">{entry.author}</span>
            {entry.type === "review" ? (
              <span className={`font-medium ${reviewStateClass(entry.state)}`}>
                {REVIEW_STATE_LABELS[entry.state] ?? entry.state.toLowerCase()}
              </span>
            ) : null}
            · {relativeTime(entry.createdAt)}
          </p>
          {entry.body.length > 0 ? (
            <Markdown content={entry.body} className="text-sm" />
          ) : null}
        </div>
      ))}
      {pull.reviewThreads.map((thread, index) => (
        <ReviewThreadCard key={index} thread={thread} />
      ))}
    </div>
  );
}

function PullReviewersList({ pull }: { pull: PullDetail }) {
  const rows = useMemo(() => {
    const latest = new Map<string, { login: string; state: string }>();
    for (const review of pull.reviews) {
      if (review.author.length > 0) {
        latest.set(review.author, {
          login: review.author,
          state: review.state,
        });
      }
    }
    for (const login of pull.reviewRequests) {
      latest.set(login, { login, state: "PENDING" });
    }
    return [...latest.values()];
  }, [pull]);
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">No reviewers</p>;
  return (
    <>
      {rows.map((row) => (
        <p
          key={row.login}
          className="flex items-center gap-2 text-sm text-foreground"
        >
          <Avatar login={row.login} />
          <span className="min-w-0 truncate">{row.login}</span>
          <span
            className={`ml-auto shrink-0 text-xs ${reviewStateClass(row.state)}`}
          >
            {REVIEW_STATE_LABELS[row.state] ?? row.state.toLowerCase()}
          </span>
        </p>
      ))}
    </>
  );
}

function PullCommentBox({
  repo,
  number,
  onPosted,
}: {
  repo: string;
  number: number;
  onPosted: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const post = useCallback(() => {
    if (comment.trim().length === 0) return;
    setPosting(true);
    rpc
      .call("commentPull", { repo, number, body: comment })
      .then(() => {
        setComment("");
        onPosted();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  }, [rpc, repo, number, comment, onPosted]);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Leave a comment…"
        rows={3}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={posting || comment.trim().length === 0}
          onClick={post}
        >
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function PullDetailView({
  repo,
  number,
  onBack,
  backLabel = "Pull requests",
  compact = false,
  workspaceEnvironmentId = null,
}: {
  repo: string;
  number: number;
  onBack?: () => void;
  backLabel?: string;
  compact?: boolean;
  workspaceEnvironmentId?: string | null;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const [pull, setPull] = useState<PullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("getPull", { repo, number }).then(
      (result) => {
        setPull(result.pull);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, repo, number]);
  useEffect(() => {
    setPull(null);
    load();
  }, [load]);

  if (error !== null) return <EmptyState message={error} />;
  if (pull === null) {
    return <DetailSkeleton />;
  }

  const pullLinks = links[`pr:${repo}#${number}`];
  const mainColumn = (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <ChecksSection checks={pull.checks} />

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          <Avatar login={pull.author} />
          <span className="font-medium text-foreground">{pull.author}</span>
          opened this pull request · updated {relativeTime(pull.updatedAt)}
        </div>
        <div className="p-4">
          {pull.body.length > 0 ? (
            <Markdown content={pull.body} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">(no description)</p>
          )}
        </div>
      </div>

      <PullTimeline pull={pull} />

      {pull.files.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            Files changed · {pull.files.length}
            <span className="ml-2 font-normal">
              <span className="text-green-600 dark:text-green-400">
                +{pull.additions}
              </span>{" "}
              <span className="text-red-600 dark:text-red-400">
                −{pull.deletions}
              </span>
            </span>
          </h3>
          {pull.files.map((file) => (
            <FileDiffCard
              key={file.path}
              environmentId={workspaceEnvironmentId}
              file={file}
              url={pull.url}
            />
          ))}
        </div>
      ) : null}

      <PullCommentBox repo={repo} number={number} onPosted={load} />
    </div>
  );

  return (
    <div className="@container/github-detail flex flex-col gap-4">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {onBack !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={onBack}
          >
            ← {backLabel}
          </Button>
        ) : null}
        <span className="min-w-0 truncate">
          {repo} · #{number}
        </span>
        <span className="flex-1" />
        <UrlLink
          href={pull.url}
          className="shrink-0 underline hover:text-foreground"
        >
          Open on GitHub ↗
        </UrlLink>
      </div>

      <div className="flex items-start gap-3">
        <h2
          className={`min-w-0 flex-1 font-semibold text-foreground ${compact ? "text-base" : "text-xl"}`}
        >
          {pull.title}{" "}
          <span className="font-normal text-muted-foreground">
            #{pull.number}
          </span>
        </h2>
        <Button
          size="sm"
          disabled={spawningKey !== null}
          onClick={() => spawn("startReview", repo, number)}
        >
          {spawningKey !== null ? "Starting…" : "Review with agent"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PullStateBadge state={pull.state} />
        <ReviewDecisionBadge decision={pull.reviewDecision} />
        <span className="font-mono">
          {pull.baseRefName} ← {pull.headRefName}
        </span>
        <span>
          <span className="text-green-600 dark:text-green-400">
            +{pull.additions}
          </span>{" "}
          <span className="text-red-600 dark:text-red-400">
            −{pull.deletions}
          </span>{" "}
          · {pull.changedFiles} file{pull.changedFiles === 1 ? "" : "s"}
        </span>
        <LabelChips labels={pull.labels} className="flex flex-wrap" />
        <ThreadPills links={pullLinks} />
      </div>

      {compact ? (
        mainColumn
      ) : (
        <div className="flex flex-col gap-6 @min-[56rem]/github-detail:flex-row">
          {mainColumn}
          <aside className="flex w-full shrink-0 flex-col gap-5 @min-[56rem]/github-detail:w-56">
            <div className="flex flex-col gap-1">
              <SidebarHeading>Reviewers</SidebarHeading>
              <PullReviewersList pull={pull} />
            </div>
            <div className="flex flex-col gap-1">
              <SidebarHeading>Assignees</SidebarHeading>
              {pull.assignees.length === 0 ? (
                <p className="text-sm text-muted-foreground">No one assigned</p>
              ) : (
                pull.assignees.map((login) => (
                  <p
                    key={login}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <Avatar login={login} />
                    <span className="truncate">{login}</span>
                  </p>
                ))
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Labels</SidebarHeading>
              {pull.labels.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet</p>
              ) : (
                <LabelChips labels={pull.labels} className="flex flex-wrap" />
              )}
            </div>
            {pullLinks !== undefined && pullLinks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <SidebarHeading>Agents</SidebarHeading>
                <ThreadPills links={pullLinks} />
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

function PullPickerList({
  onPick,
}: {
  onPick: (repo: string, number: number) => void;
}) {
  const { items, error } = useItems("pr");
  if (error !== null) return <EmptyState message={error} />;
  if (items === null) {
    return (
      <DelayedLoading>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      </DelayedLoading>
    );
  }
  const open = items.filter((item) => item.state === "OPEN");
  if (open.length === 0) {
    return <EmptyState message="No open pull requests in the tracked repos." />;
  }
  return (
    <div className="@container/github-picker overflow-hidden rounded-lg border border-border bg-card">
      <div className="divide-y divide-border">
        {open.map((item) => (
          <button
            key={`${item.repo}#${item.number}`}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
            onClick={() => onPick(item.repo, item.number)}
          >
            <StateDot kind="pr" state={item.state} />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              #{item.number}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {item.title}
            </span>
            <span className="hidden shrink-0 text-xs text-muted-foreground @min-[32rem]/github-picker:block">
              {item.repo}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PullPanelTab({ threadId }: ExperimentalThreadActionTabProps) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [resolved, setResolved] = useState(false);
  const [selected, setSelected] = useState<{
    repo: string;
    number: number;
    environmentId: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("pullForThread", { threadId }).then(
      (result) => {
        if (cancelled) return;
        if (result.pull !== null) setSelected(result.pull);
        setResolved(true);
      },
      () => {
        if (!cancelled) setResolved(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  if (!resolved) {
    return <DetailSkeleton />;
  }
  if (selected === null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          No pull request is linked to this thread yet — pick one:
        </p>
        <PullPickerList
          onPick={(repo, number) =>
            setSelected({ repo, number, environmentId: null })
          }
        />
      </div>
    );
  }
  return (
    <PullDetailView
      repo={selected.repo}
      number={selected.number}
      compact
      workspaceEnvironmentId={selected.environmentId}
      backLabel="All PRs"
      onBack={() => setSelected(null)}
    />
  );
}

function NewIssueForm({
  repos,
  onCreated,
  onCancel,
}: {
  repos: RepoInfo[];
  onCreated: (repo: string, number: number | null) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [repo, setRepo] = useState(repos[0]?.repo ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [creating, setCreating] = useState(false);

  const create = useCallback(() => {
    setCreating(true);
    rpc
      .call("createIssue", { repo, title, body })
      .then((result) => {
        toast.success("Issue created");
        onCreated(repo, result.number);
      })
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setCreating(false));
  }, [rpc, repo, title, body, onCreated]);

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground">New issue</h2>
      <Select value={repo} onValueChange={setRepo}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Repository" />
        </SelectTrigger>
        <SelectContent>
          {repos.map((entry) => (
            <SelectItem key={entry.repo} value={entry.repo}>
              {entry.repo}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
      />
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Description (markdown)"
        rows={8}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={creating || title.trim().length === 0 || repo.length === 0}
          onClick={create}
        >
          {creating ? "Creating…" : "Create issue"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function useStatus(): { status: Status | null } {
  const rpc = useRpc<typeof githubRpcContract>();
  const cache = panelCache.status;
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot);
  const load = useCallback(() => rpc.call("status"), [rpc]);
  useEffect(() => {
    void cache.refresh(load);
  }, [cache, load]);
  useRealtime("data-changed", () => {
    void cache.refresh(load, true);
  });
  return { status: state.data };
}

function useRefresh() {
  const rpc = useRpc<typeof githubRpcContract>();
  const state = useSyncExternalStore(
    panelCache.sync.subscribe,
    panelCache.sync.getSnapshot,
  );
  const refresh = useCallback(
    () =>
      panelCache.sync.refresh(async () => {
        await rpc.call("refresh");
        const syncedAt = Date.now();
        // Also reconcile directly, in case the realtime sync signal was missed.
        await Promise.all([
          panelCache.issues.refresh(
            () =>
              rpc
                .call("listItems", { kind: "issue" })
                .then((result) => result.items),
            true,
          ),
          panelCache.pulls.refresh(
            () =>
              rpc
                .call("listItems", { kind: "pr" })
                .then((result) => result.items),
            true,
          ),
          panelCache.status.refresh(() => rpc.call("status"), true),
          panelCache.links.refresh(
            () => rpc.call("listLinks").then((result) => result.links),
            true,
          ),
        ]);
        return syncedAt;
      }),
    [rpc],
  );
  const refreshIfStale = useCallback(async () => {
    // Read the server timestamp first, including syncs from other windows or the service.
    await panelCache.status.refresh(() => rpc.call("status"));
    if (
      isSyncStale(
        panelCache.status.getSnapshot().data?.lastSyncedAt,
        panelCache.sync.getSnapshot().data,
      )
    ) {
      await refresh();
    }
  }, [rpc, refresh]);
  return {
    refresh,
    refreshIfStale,
    syncing: state.refreshing,
    failed: state.error !== null,
  };
}

function useSyncProgress() {
  type Progress = PluginRpcResult<(typeof githubRpcContract)["syncProgress"]>;
  const rpc = useRpc<typeof githubRpcContract>();
  const [progress, setProgress] = useState<Progress | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const requested = revision.current;
    rpc.call("syncProgress").then(
      (result) => {
        if (!cancelled && revision.current === requested) setProgress(result);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  useRealtime("sync-progress", (payload) => {
    if (payload === null || typeof payload !== "object") return;
    const value = payload as Record<string, unknown>;
    if (
      typeof value.running !== "boolean" ||
      ![value.completed, value.total, value.failed].every(
        (n) => typeof n === "number" && Number.isInteger(n) && n >= 0,
      ) ||
      (value.completed as number) > (value.total as number) ||
      (value.failed as number) > (value.completed as number)
    )
      return;
    revision.current += 1;
    setProgress(value as unknown as Progress);
  });
  return progress;
}

function PanelHeader() {
  const { status } = useStatus();
  const { refresh, syncing: refreshing, failed } = useRefresh();
  const progress = useSyncProgress();
  const syncing = refreshing || progress?.running === true;
  const progressText =
    syncing && progress?.running && progress.total > 0
      ? `${progress.completed} of ${progress.total} repos${progress.failed > 0 ? ` · ${progress.failed} failed` : ""}`
      : null;
  return (
    <>
      <span className="hidden text-xs text-muted-foreground @min-[40rem]/page-header:inline">
        {failed ? (
          "Sync failed — check `gh auth status`"
        ) : status === null ? (
          <DelayedLoading>Loading…</DelayedLoading>
        ) : status.ghOk ? (
          `${status.repos.length} repo${status.repos.length === 1 ? "" : "s"} · synced ${
            status.lastSyncedAt !== null
              ? relativeTime(status.lastSyncedAt)
              : "never"
          }`
        ) : status.ghState === "unavailable" ? (
          "GitHub CLI unavailable — retrying"
        ) : (
          "GitHub CLI not authenticated"
        )}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="size-8 gap-1.5 px-0 @min-[32rem]/page-header:h-8 @min-[32rem]/page-header:w-auto @min-[32rem]/page-header:px-3"
        disabled={syncing}
        onClick={refresh}
        aria-label={
          syncing
            ? `Syncing GitHub data${progressText ? `: ${progressText}` : ""}`
            : "Refresh GitHub data"
        }
      >
        <RefreshIcon className={syncing ? "animate-spin" : undefined} />
        <span className="hidden @min-[32rem]/page-header:inline">
          {syncing ? (progressText ?? "Syncing…") : "Refresh"}
        </span>
      </Button>
    </>
  );
}

const QUERY_KEY = "bb-plugin-github-fred:query";
const DEFAULT_QUERY = "is:open ";

function GithubPanel({ subPath }: PluginNavPanelProps) {
  const [route, navigate] = useSubPathRoute(subPath);
  const { status } = useStatus();
  const { refreshIfStale } = useRefresh();
  useEffect(() => {
    void refreshIfStale();
  }, [refreshIfStale]);
  const [searches, setSearches] = useState<SavedSearch[]>(() => {
    let query = DEFAULT_QUERY;
    let kind: SavedSearch["kind"] = "issue";
    try {
      const saved = parseSavedSearches(
        window.localStorage.getItem(SEARCHES_KEY),
      );
      if (saved !== null) return saved;
      query = window.localStorage.getItem(QUERY_KEY) ?? DEFAULT_QUERY;
      kind = window.localStorage.getItem(TAB_KEY) === "pulls" ? "pr" : "issue";
    } catch {}
    if (subPath === "issues" || subPath === "pulls") {
      kind = subPath === "pulls" ? "pr" : "issue";
    }
    return [
      { id: "initial", name: "My search", kind, query, collapsed: false },
    ];
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SEARCHES_KEY, JSON.stringify(searches));
    } catch {}
  }, [searches]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <GithubPanelBody
          route={route}
          navigate={navigate}
          status={status}
          searches={searches}
          setSearches={setSearches}
        />
      </div>
    </div>
  );
}

function GithubPanelBody({
  route,
  navigate,
  status,
  searches,
  setSearches,
}: {
  route: Route;
  navigate: (route: Route) => void;
  status: Status | null;
  searches: SavedSearch[];
  setSearches: React.Dispatch<React.SetStateAction<SavedSearch[]>>;
}) {
  const openItem = useCallback(
    (itemKind: "issue" | "pr", repo: string, number: number) => {
      navigate(
        itemKind === "pr"
          ? { view: "pull", repo, number }
          : { view: "issue", repo, number },
      );
    },
    [navigate],
  );
  if (status !== null && status.ghState === "unavailable") {
    return (
      <EmptyState
        message={`GitHub CLI could not reach GitHub. Check your network or keychain; the plugin retries by itself. (${status.ghError ?? ""})`}
      />
    );
  }
  if (status !== null && !status.ghOk) {
    return (
      <EmptyState
        message={`GitHub CLI is not available or not authenticated. Install it from cli.github.com, run \`gh auth login\`, then reload the plugin. (${status.ghError ?? ""})`}
      />
    );
  }
  if (status !== null && status.repos.length === 0) {
    return (
      <EmptyState message="No GitHub repos tracked yet. Create a BB project whose checkout has a GitHub origin remote, or add repos via the extraRepos plugin setting." />
    );
  }

  if (route.view === "issue") {
    return (
      <IssueDetailView
        repo={route.repo}
        number={route.number}
        onBack={() => navigate({ view: "issues" })}
      />
    );
  }
  if (route.view === "pull") {
    return (
      <PullDetailView
        repo={route.repo}
        number={route.number}
        onBack={() => navigate({ view: "pulls" })}
      />
    );
  }
  if (route.view === "new") {
    return (
      <NewIssueForm
        repos={status?.repos ?? []}
        onCreated={(repo, number) =>
          navigate(
            number !== null
              ? { view: "issue", repo, number }
              : { view: "issues" },
          )
        }
        onCancel={() => navigate({ view: "issues" })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {searches.map((search, index) => (
        <SearchSection
          key={search.id}
          search={search}
          first={index === 0}
          last={index === searches.length - 1}
          repos={status?.repos ?? []}
          onChange={(patch) =>
            setSearches((current) =>
              current.map((entry) =>
                entry.id === search.id ? { ...entry, ...patch } : entry,
              ),
            )
          }
          onMove={(offset) =>
            setSearches((current) => moveSearch(current, search.id, offset))
          }
          onRemove={() =>
            setSearches((current) =>
              current.filter((entry) => entry.id !== search.id),
            )
          }
          onOpenItem={(repo, number) => openItem(search.kind, repo, number)}
          onNewIssue={() => navigate({ view: "new" })}
        />
      ))}
      {searches.length === 0 ? (
        <EmptyState message="No searches yet. Add a search to start browsing issues and pull requests." />
      ) : null}
      <Button
        variant="outline"
        className="self-start"
        onClick={() =>
          setSearches((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              name: `Search ${current.length + 1}`,
              kind: "pr",
              query: DEFAULT_QUERY,
              collapsed: false,
            },
          ])
        }
      >
        <Icon name="Plus" /> Add search
      </Button>
    </div>
  );
}

function SearchSection({
  search,
  first,
  last,
  repos,
  onChange,
  onMove,
  onRemove,
  onOpenItem,
  onNewIssue,
}: {
  search: SavedSearch;
  first: boolean;
  last: boolean;
  repos: RepoInfo[];
  onChange: (patch: Partial<SavedSearch>) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
  onOpenItem: (repo: string, number: number) => void;
  onNewIssue: () => void;
}) {
  const { items, error } = useItems(search.kind);
  const viewer = useViewer();
  const parsed = useMemo(() => parseQuery(search.query), [search.query]);
  const filtered = useMemo(
    () =>
      items === null
        ? null
        : items.filter((item) => matchesQuery(item, parsed, viewer)),
    [items, parsed, viewer],
  );
  const name = search.name.trim() || "Untitled search";
  return (
    <section
      aria-label={name}
      className="@container/search-section rounded-lg border border-border bg-card p-3 space-y-3"
    >
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label={`${search.collapsed ? "Expand" : "Collapse"} ${name}`}
          aria-expanded={!search.collapsed}
          aria-controls={`search-${search.id}`}
          onClick={() => onChange({ collapsed: !search.collapsed })}
        >
          <Icon name={search.collapsed ? "ChevronRight" : "ChevronDown"} />
        </Button>
        <Input
          aria-label="Search name"
          value={search.name}
          placeholder="Search name"
          className="h-8 min-w-0 flex-1 border-transparent font-medium shadow-none hover:border-input @min-[48rem]/search-section:w-40 @min-[48rem]/search-section:flex-none"
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <div className="group/search-type relative shrink-0">
          <select
            aria-label="Search type"
            value={search.kind}
            onChange={(event) =>
              onChange({ kind: event.target.value === "pr" ? "pr" : "issue" })
            }
            className="h-8 max-w-36 cursor-pointer appearance-none rounded-md border border-transparent bg-transparent pl-2 pr-7 text-xs transition-colors hover:border-input focus-visible:border-input focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="issue">Issues</option>
            <option value="pr">Pull requests</option>
          </select>
          <Icon
            name="ChevronDown"
            className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover/search-type:opacity-100 group-focus-within/search-type:opacity-100"
          />
        </div>
        <div className="order-last min-w-0 basis-full @min-[48rem]/search-section:order-none @min-[48rem]/search-section:flex-1 @min-[48rem]/search-section:basis-64">
          <FilterBar
            value={search.query}
            onChange={(query) => onChange({ query })}
            items={items}
            repos={repos}
            kind={search.kind}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Move search up"
          disabled={first}
          onClick={() => onMove(-1)}
        >
          <Icon name="ArrowUp" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Move search down"
          disabled={last}
          onClick={() => onMove(1)}
        >
          <Icon name="ArrowDown" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Remove search"
          onClick={onRemove}
        >
          <Icon name="Trash2" />
        </Button>
      </div>
      <div
        id={`search-${search.id}`}
        hidden={search.collapsed}
        className="space-y-3"
      >
        {search.kind === "issue" ? (
          <div className="flex justify-end">
            <Button size="sm" onClick={onNewIssue}>
              New issue
            </Button>
          </div>
        ) : null}
        <ItemsTable
          kind={search.kind}
          items={filtered}
          error={error}
          hasFilter={search.query.trim().length > 0}
          preferences={search.table}
          onPreferencesChange={(table) => onChange({ table })}
          onOpenItem={onOpenItem}
        />
      </div>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "github-fred",
    title: "GitHub Fred",
    icon: "Github",
    path: "github-fred",
    component: GithubPanel,
    headerContent: PanelHeader,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "pull",
    title: "GitHub Fred PR",
    icon: "Github",
    component: PullPanelTab,
  });
});
