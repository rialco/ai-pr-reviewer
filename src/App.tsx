import { useState } from "react";
import { AddRepo } from "./components/AddRepo";
import { RepoList } from "./components/RepoList";
import { PRList } from "./components/PRList";
import { CommentView } from "./components/CommentView";
import { JobCenter } from "./components/JobCenter";
import { useAvailableReviewers, useSummary, useSettings, useUpdateSettings, type ReviewerId } from "./hooks/useApi";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { AgentLogo, getAgentLabel } from "./components/ui/agent-logo";
import { Switch } from "./components/ui/switch";
import { ChevronDown, Clock3, Github, MessageSquare } from "lucide-react";

const COORDINATOR_CHECK_INTERVAL_MINUTES = 3;
const REVIEWER_ORDER: ReviewerId[] = ["claude", "codex", "greptile"];

function PreferencePill({
  agent,
  selected,
  unavailable,
  disabled,
  onClick,
}: {
  agent: ReviewerId;
  selected: boolean;
  unavailable?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/35"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <span className="flex items-center gap-2">
        <AgentLogo agent={agent} className="h-3.5 w-3.5" />
        <span className="text-xs font-medium">{getAgentLabel(agent)}</span>
      </span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {selected ? "Selected" : unavailable ? "Unavailable" : "Optional"}
      </span>
    </button>
  );
}

export function App() {
  const [selectedPR, setSelectedPR] = useState<{
    repo: string;
    prNumber: number;
  } | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const { data: summary } = useSummary();
  const { data: settings } = useSettings();
  const { data: reviewers } = useAvailableReviewers();
  const updateSettings = useUpdateSettings();
  const coordinatorAgent = settings?.coordinatorAgent ?? "claude";
  const coordinatorEnabled = settings?.coordinatorEnabled ?? false;
  const defaultAnalyzerAgent = settings?.defaultAnalyzerAgent ?? "claude";
  const defaultFixerAgent = settings?.defaultFixerAgent ?? "claude";
  const defaultReviewerIds = settings?.defaultReviewerIds ?? ["claude", "codex"];
  const reviewerAvailability = new Map((reviewers ?? []).map((reviewer) => [reviewer.id, reviewer.available]));

  const toggleDefaultReviewer = (reviewerId: ReviewerId) => {
    const next = defaultReviewerIds.includes(reviewerId)
      ? defaultReviewerIds.filter((id) => id !== reviewerId)
      : [...defaultReviewerIds, reviewerId];

    if (next.length === 0) {
      return;
    }

    updateSettings.mutate({ defaultReviewerIds: next });
  };

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
        <div className="p-4 border-b border-border">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Repositories
          </h2>
          <div className="grid grid-cols-3 gap-2">
            <AddRepo />
            <RepoList />
          </div>
        </div>

        {/* Settings */}
        <div className="space-y-2.5 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <AgentLogo agent={coordinatorAgent} className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-foreground">Agent Coordinator</p>
                <span className="rounded-full border border-border bg-muted/35 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {coordinatorEnabled ? "Enabled" : "Standby"}
                </span>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                {getAgentLabel(coordinatorAgent)} · checks every {COORDINATOR_CHECK_INTERVAL_MINUTES} min
              </p>
            </div>
            <Switch
              checked={coordinatorEnabled}
              disabled={updateSettings.isPending}
              aria-label={coordinatorEnabled ? "Disable AI coordinator" : "Enable AI coordinator"}
              onClick={() =>
                updateSettings.mutate({ coordinatorEnabled: !coordinatorEnabled })
              }
            />
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            Scans open PRs, picks the next sensible action, and runs it automatically when the workflow is clear.
          </p>

          <div className="rounded-xl border border-border/60 bg-muted/15">
            <button
              type="button"
              onClick={() => setShowAdvancedSettings((current) => !current)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
            >
              <div>
                <p className="text-xs font-medium text-foreground">Advanced settings</p>
                <p className="text-[11px] text-muted-foreground">
                  Coordinator agent, default models, and review preferences.
                </p>
              </div>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${
                  showAdvancedSettings ? "rotate-180" : "rotate-0"
                }`}
              />
            </button>

            <div
              className={`overflow-hidden transition-all duration-200 ease-out ${
                showAdvancedSettings ? "max-h-[520px] opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              <div className="space-y-3 border-t border-border/50 px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                    <Clock3 className="h-3.5 w-3.5 text-primary" />
                    Coordinator Agent
                  </span>
                  <Select
                    value={coordinatorAgent}
                    onValueChange={(value) =>
                      updateSettings.mutate({ coordinatorAgent: value === "codex" ? "codex" : "claude" })
                    }
                    disabled={updateSettings.isPending}
                  >
                    <SelectTrigger className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-xs text-foreground/90 shadow-none focus:ring-0">
                      <SelectValue placeholder="Choose agent" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude">Claude Code</SelectItem>
                      <SelectItem value="codex">Codex</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                      Default Analyzer
                    </span>
                    <Select
                      value={defaultAnalyzerAgent}
                      onValueChange={(value) =>
                        updateSettings.mutate({ defaultAnalyzerAgent: value === "codex" ? "codex" : "claude" })
                      }
                      disabled={updateSettings.isPending}
                    >
                      <SelectTrigger className="h-8 rounded-md border border-border bg-transparent px-2.5 text-xs text-foreground/90 shadow-none focus:ring-0">
                        <SelectValue placeholder="Analyzer" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude">Claude Code</SelectItem>
                        <SelectItem value="codex">Codex</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                      Default Fixer
                    </span>
                    <Select
                      value={defaultFixerAgent}
                      onValueChange={(value) =>
                        updateSettings.mutate({ defaultFixerAgent: value === "codex" ? "codex" : "claude" })
                      }
                      disabled={updateSettings.isPending}
                    >
                      <SelectTrigger className="h-8 rounded-md border border-border bg-transparent px-2.5 text-xs text-foreground/90 shadow-none focus:ring-0">
                        <SelectValue placeholder="Fixer" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude">Claude Code</SelectItem>
                        <SelectItem value="codex">Codex</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
                      Reviewers For Score Checks
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">
                      Local reviewers run first
                    </span>
                  </div>
                  <div className="grid gap-2">
                    {REVIEWER_ORDER.map((reviewerId) => (
                      <PreferencePill
                        key={reviewerId}
                        agent={reviewerId}
                        selected={defaultReviewerIds.includes(reviewerId)}
                        unavailable={reviewerAvailability.get(reviewerId) === false}
                        disabled={updateSettings.isPending || (defaultReviewerIds.length === 1 && defaultReviewerIds.includes(reviewerId))}
                        onClick={() => toggleDefaultReviewer(reviewerId)}
                      />
                    ))}
                  </div>
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    Suggested review steps request all selected local reviewers together. Greptile is only used when no local reviewer is available.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* PR List */}
        <div className="flex-1 overflow-y-auto p-4">
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Open PRs
          </h2>
          <PRList onSelectPR={(repo, prNumber) => setSelectedPR({ repo, prNumber })} selectedPR={selectedPR} />
        </div>

        <JobCenter
          onNavigateToPR={(repo, prNumber) => setSelectedPR({ repo, prNumber })}
          lastPollAt={summary?.lastPollAt ?? null}
        />
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
