import { useState } from "react";
import { AddRepo } from "./components/AddRepo";
import { CoordinatorDock } from "./components/CoordinatorDock";
import { RepoList } from "./components/RepoList";
import { PRList } from "./components/PRList";
import { CommentView } from "./components/CommentView";
import { JobCenter } from "./components/JobCenter";
import { useSummary } from "./hooks/useApi";
import { SectionHeader } from "./components/ui/section-header";
import { Github, MessageSquare } from "lucide-react";

export function App() {
  const [selectedPR, setSelectedPR] = useState<{
    repo: string;
    prNumber: number;
  } | null>(null);
  const [footerPopover, setFooterPopover] = useState<"activity" | "coordinator" | null>(null);

  const { data: summary } = useSummary();

  return (
    <div className="flex h-screen">
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
        <div className="border-b border-border px-4 py-2.5">
          <SectionHeader
            title="Repositories"
            detail={summary?.repos ?? 0}
            pipClassName="bg-primary/70"
            className="-mx-4 border-b border-border bg-transparent px-4"
          />
          <div className="space-y-2 pt-2.5">
            <RepoList />
            <AddRepo />
          </div>
        </div>

        {/* PR List */}
        <div className="flex-1 overflow-y-auto py-4">
          <PRList onSelectPR={(repo, prNumber) => setSelectedPR({ repo, prNumber })} selectedPR={selectedPR} />
        </div>

        <div className="border-t border-border bg-card/60 p-3">
          <div className="space-y-2 overflow-visible">
            <CoordinatorDock
              open={footerPopover === "coordinator"}
              onOpenChange={(open) => setFooterPopover(open ? "coordinator" : null)}
            />
            <JobCenter
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
            className="animate-enter-fade-slide p-6"
          >
            <CommentView repo={selectedPR.repo} prNumber={selectedPR.prNumber} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Github className="h-12 w-12 mb-4 opacity-20" />
            <p className="text-sm">Select a PR to view bot comments</p>
            <p className="text-xs mt-1">
              Add a repo to get started — PRs sync automatically
            </p>
          </div>
        )}
      </main>

    </div>
  );
}
