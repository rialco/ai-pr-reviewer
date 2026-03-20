import { useState } from "react";
import { AddRepo } from "./components/AddRepo";
import { RepoList } from "./components/RepoList";
import { PRList } from "./components/PRList";
import { CommentView } from "./components/CommentView";
import { JobCenter } from "./components/JobCenter";
import { useSummary, useSettings, useUpdateSettings } from "./hooks/useApi";
import { Badge } from "./components/ui/badge";
import { Github, MessageSquare } from "lucide-react";

export function App() {
  const [selectedPR, setSelectedPR] = useState<{
    repo: string;
    prNumber: number;
  } | null>(null);

  const { data: summary } = useSummary();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-80 border-r border-border flex flex-col shrink-0">
        {/* Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="h-5 w-5 text-primary" />
            <h1 className="text-base font-semibold">PR Review</h1>
          </div>

          {/* Summary stats */}
          {summary && summary.totalComments > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {summary.byStatus.new > 0 && (
                <Badge variant="default">{summary.byStatus.new} new</Badge>
              )}
              {(summary.byCategory.MUST_FIX ?? 0) > 0 && (
                <Badge variant="must_fix">{summary.byCategory.MUST_FIX} must fix</Badge>
              )}
              {(summary.byCategory.SHOULD_FIX ?? 0) > 0 && (
                <Badge variant="should_fix">{summary.byCategory.SHOULD_FIX} should fix</Badge>
              )}
            </div>
          )}
        </div>

        {/* Repos */}
        <div className="p-4 border-b border-border">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Repositories
          </h2>
          <AddRepo />
          <div className="mt-2">
            <RepoList />
          </div>
        </div>

        {/* Settings */}
        <div className="px-4 py-3 border-b border-border">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-xs text-muted-foreground">
              Auto re-review (Greptile)
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={settings?.autoReReview ?? false}
              onClick={() =>
                updateSettings.mutate({ autoReReview: !(settings?.autoReReview ?? false) })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors ${
                settings?.autoReReview ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`pointer-events-none block h-3.5 w-3.5 rounded-full bg-foreground transition-transform ${
                  settings?.autoReReview ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </label>
        </div>

        {/* PR List */}
        <div className="flex-1 overflow-y-auto p-4">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Open PRs
          </h2>
          <PRList onSelectPR={(repo, prNumber) => setSelectedPR({ repo, prNumber })} selectedPR={selectedPR} />
        </div>

        {/* Footer */}
        {summary?.lastPollAt && (
          <div className="p-3 border-t border-border text-xs text-muted-foreground">
            Last poll: {new Date(summary.lastPollAt).toLocaleTimeString()}
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-surface">
        {selectedPR ? (
          <div className="p-6">
            <CommentView key={`${selectedPR.repo}:${selectedPR.prNumber}`} repo={selectedPR.repo} prNumber={selectedPR.prNumber} />
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

      {/* Global Job Center — persists across PR navigation */}
      <JobCenter onNavigateToPR={(repo, prNumber) => setSelectedPR({ repo, prNumber })} />
    </div>
  );
}
