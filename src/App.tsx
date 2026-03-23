import { useState } from "react";
import { AddRepo } from "./components/AddRepo";
import { AppActivityCenter } from "./components/AppActivityCenter";
import { AppCommentPanel } from "./components/AppCommentPanel";
import { AppRepoCountBadge } from "./components/AppRepoCountBadge";
import { CloudControlDock } from "./components/CloudControlDock";
import { CoordinatorDock } from "./components/CoordinatorDock";
import { RepoList } from "./components/RepoList";
import { PRList } from "./components/PRList";
import { useAppSummary } from "./hooks/useAppSummary";
import { cn } from "./lib/utils";
import { ChevronDown, ChevronRight, Github, MessageSquare } from "lucide-react";

export function App() {
  const [selectedPR, setSelectedPR] = useState<{
    repo: string;
    prNumber: number;
  } | null>(null);
  const [footerPopover, setFooterPopover] = useState<"activity" | "coordinator" | "cloud" | null>(null);
  const [reposCollapsed, setReposCollapsed] = useState(false);
  const summary = useAppSummary();

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-[340px] border-r border-border flex flex-col shrink-0">
        {/* Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-primary" />
            <h1 className="text-base font-semibold">PR Review</h1>
          </div>
        </div>

        {/* Repos */}
        <div className="pt-2.5">
          <section className="border-b border-border/60">
            <button
              type="button"
              onClick={() => setReposCollapsed((collapsed) => !collapsed)}
              className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/20"
              aria-expanded={!reposCollapsed}
              aria-controls="repo-sidebar-section"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-border/70 bg-muted/20 text-muted-foreground">
                {reposCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
                  Repositories
                </p>
              </div>
              <AppRepoCountBadge />
            </button>
            <div
              id="repo-sidebar-section"
              className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
              style={{
                gridTemplateRows: reposCollapsed ? "0fr" : "1fr",
                opacity: reposCollapsed ? 0.7 : 1,
              }}
            >
              <div className="overflow-hidden">
                <div className="space-y-2 border-t border-border/50 px-4 py-2">
                  <RepoList />
                  <AddRepo />
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* PR List */}
        <div className={cn("flex-1 overflow-y-auto pb-4", reposCollapsed ? "pt-2" : "pt-4")}>
          <PRList onSelectPR={(repo, prNumber) => setSelectedPR({ repo, prNumber })} selectedPR={selectedPR} />
        </div>

        <div className="border-t border-border bg-card/60 p-3">
          <div className="space-y-2 overflow-visible">
            <CloudControlDock
              open={footerPopover === "cloud"}
              onOpenChange={(open) => setFooterPopover(open ? "cloud" : null)}
            />
            <CoordinatorDock
              open={footerPopover === "coordinator"}
              onOpenChange={(open) => setFooterPopover(open ? "coordinator" : null)}
            />
            <AppActivityCenter
              open={footerPopover === "activity"}
              onOpenChange={(open) => setFooterPopover(open ? "activity" : null)}
              onNavigateToPR={(repo, prNumber) => setSelectedPR({ repo, prNumber })}
              lastPollAt={summary?.lastPollAt ?? null}
            />
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-surface">
        {selectedPR ? (
          <div
            key={`${selectedPR.repo}:${selectedPR.prNumber}`}
            className="animate-enter-fade-slide"
          >
            <AppCommentPanel repo={selectedPR.repo} prNumber={selectedPR.prNumber} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Github className="h-12 w-12 mb-4 opacity-20" />
            <p className="text-sm">Select a PR to view bot comments</p>
            <p className="text-xs mt-1">Add a repository checkout to get started</p>
          </div>
        )}
      </main>

    </div>
  );
}
