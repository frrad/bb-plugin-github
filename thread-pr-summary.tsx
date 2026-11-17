import { useEffect, useState, type ReactNode } from "react";
import { UrlLink, experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "./components/ui/button.js";
import { Icon } from "./components/ui/icon.js";
import { SlackLogo } from "./components/slack-logo.js";
import {
  summaryPosition,
  type SummaryPosition,
} from "./thread-summary-layout.js";

/** BB has no left transcript slot. Measure its DOM without changing its layout. */
export function useSummaryPosition(threadId: string): SummaryPosition | null {
  const [position, setPosition] = useState<SummaryPosition | null>(null);
  useEffect(() => {
    let frame = 0;
    const observed = new Set<Element>();
    const resize = new ResizeObserver(schedule);
    function measure() {
      frame = 0;
      const windows = [
        ...document.querySelectorAll<HTMLElement>("[data-thread-window]"),
      ].filter((element) => element.getBoundingClientRect().width > 0);
      // An app overlay has route context, not individual split-pane thread context.
      // Decline ambiguous panes rather than showing another thread's private note.
      const pane = windows.length === 1 ? windows[0] : null;
      const columns = pane
        ? [...pane.querySelectorAll<HTMLElement>("[data-message-column]")]
        : [];
      const targets = new Set<Element>(pane ? [pane, ...columns] : []);
      for (const element of observed) {
        if (!targets.has(element)) {
          resize.unobserve(element);
          observed.delete(element);
        }
      }
      for (const element of targets) {
        if (!observed.has(element)) {
          resize.observe(element);
          observed.add(element);
        }
      }
      const rects = columns
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0);
      const next =
        pane && rects.length
          ? summaryPosition(
              pane.getBoundingClientRect(),
              Math.min(...rects.map((rect) => rect.left)),
            )
          : null;
      setPosition((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    window.addEventListener("resize", schedule);
    // Capture scrolls too: a horizontally scrolled/split layout can move the pane.
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [threadId]);
  return position;
}

export function ThreadPrSummary({
  position,
  repo,
  number,
  title,
  url,
  slackUrl,
  noteEditor,
}: {
  position: SummaryPosition;
  repo: string;
  number: number;
  title: string;
  url: string;
  slackUrl?: string;
  noteEditor: ReactNode;
}) {
  return (
    <aside
      aria-label="Linked pull request"
      className="rounded-lg border border-border/60 bg-background p-4 text-sm shadow-sm"
      style={{
        position: "fixed",
        ...position,
        zIndex: 20,
        overflowY: "auto",
        overflowWrap: "anywhere",
      }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1">
          <UrlLink
            href={url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 hover:underline"
          >
            {repo} #{number}
          </UrlLink>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 [&_[data-icon-root]]:size-3.5"
            aria-label="Copy PR link"
            onClick={() => {
              void experimental_copyToClipboard({ text: url }).then(
                (copied) => {
                  if (copied) toast.success("Link copied");
                  else toast.error("Could not copy the link");
                },
                () => toast.error("Could not copy the link"),
              );
            }}
          >
            <Icon name="Link" className="size-3.5" />
          </Button>
        </span>
        {slackUrl ? (
          <UrlLink
            href={slackUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open Slack thread for ${repo}#${number}`}
            title="Open Slack thread"
            className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:bg-accent"
          >
            <SlackLogo className="size-3.5" /> Slack
          </UrlLink>
        ) : null}
      </div>
      <UrlLink
        href={url}
        target="_blank"
        rel="noreferrer"
        className="font-medium leading-snug text-foreground hover:underline"
      >
        {title}
      </UrlLink>
      <div className="mt-4 border-t border-border/60 pt-3">{noteEditor}</div>
    </aside>
  );
}
