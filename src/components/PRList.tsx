import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useCoordinatorPRPreference, useOpenPRs, usePRStatus, useUpdateCoordinatorPRPreference } from "../hooks/useApi";
import { Badge } from "./ui/badge";
import { AgentLogo, getAgentLabel } from "./ui/agent-logo";
import { Switch } from "./ui/switch";
import { cn } from "@/lib/utils";
import { GitPullRequest, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";

const phaseColor: Record<string, string> = {
  polled: "bg-muted-foreground",
  analyzed: "bg-primary",
  fixing: "bg-fixing",
  fixed: "bg-fixed",
  merge_ready: "bg-emerald-300",
  re_review_requested: "bg-fixed",
  waiting_for_review: "bg-should-fix",
};

function getRepoDisplayName(repo: string) {
  return repo.split("/").pop() ?? repo;
}

function PRStatusIndicator({ repo, prNumber }: { repo: string; prNumber: number }) {
  const { data: status } = usePRStatus(repo, prNumber);
  const scores = status?.reviewScores ?? {};
  const hasScores = Object.values(scores).some((s) => s !== null);

  if (!status || (status.phase === "polled" && status.reviewCycle === 0 && !hasScores)) {
    return null;
  }

  return (
    <div className="flex items-center justify-between mt-1">
      <div className="flex items-center gap-1.5">
        {Object.entries(scores).map(([reviewerId, score]) =>
          score !== null ? (
            <span key={reviewerId} title={getAgentLabel(reviewerId)}>
              <Badge
                variant={score >= 4 ? "confidence_high" : score >= 3 ? "confidence_low" : "confidence_danger"}
                className="gap-1 text-[10px] px-1 py-0"
              >
                <AgentLogo agent={reviewerId} className="h-2.5 w-2.5 shrink-0" />
                {score}/5
              </Badge>
            </span>
          ) : null,
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {status.phase !== "polled" && (
          <span
            className={`h-2 w-2 rounded-full ${phaseColor[status.phase] ?? "bg-muted-foreground"}`}
            title={status.phase}
          />
        )}
        {status.reviewCycle > 0 && (
          <span className="text-[10px] text-muted-foreground">
            C{status.reviewCycle}
          </span>
        )}
      </div>
    </div>
  );
}

function CoordinatorChecklistToggle({
  repo,
  prNumber,
}: {
  repo: string;
  prNumber: number;
}) {
  const { data: preference } = useCoordinatorPRPreference(repo, prNumber);
  const updatePreference = useUpdateCoordinatorPRPreference();
  const checklistEnabled = !(preference?.ignored ?? false);

  return (
    <div className="flex items-center gap-2">
      <span className={cn(
        "text-[10px] uppercase tracking-[0.18em]",
        checklistEnabled ? "text-muted-foreground/70" : "text-amber-400/80",
      )}>
        {checklistEnabled ? "Auto" : "Off"}
      </span>
      <Switch
        size="sm"
        checked={checklistEnabled}
        disabled={updatePreference.isPending}
        aria-label={checklistEnabled ? "Remove PR from coordinator checklist" : "Return PR to coordinator checklist"}
        title={checklistEnabled ? "Turn coordinator checklist off for this PR" : "Turn coordinator checklist back on for this PR"}
        onClick={(event) => {
          event.stopPropagation();
          updatePreference.mutate({
            repo,
            prNumber,
            ignored: checklistEnabled,
          });
        }}
      />
    </div>
  );
}

function RepoSection({
  repo,
  count,
  selected,
  collapsed,
  onToggle,
  children,
}: {
  repo: string;
  count: number;
  selected: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-surface/70">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3 py-3 text-left transition-colors hover:bg-muted/25"
        aria-expanded={!collapsed}
      >
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-border/70 bg-muted/20 text-muted-foreground">
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/80">
            {getRepoDisplayName(repo)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selected && (
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              Active
            </span>
          )}
          <span className="rounded-full border border-border/70 bg-muted/20 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {count} PR{count === 1 ? "" : "s"}
          </span>
        </div>
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr", opacity: collapsed ? 0.7 : 1 }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-border/60 px-2 py-1">
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

interface PRListProps {
  onSelectPR: (repo: string, prNumber: number) => void;
  selectedPR: { repo: string; prNumber: number } | null;
}

export function PRList({ onSelectPR, selectedPR }: PRListProps) {
  const { data: prs, isLoading } = useOpenPRs();
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const repoEntries = useMemo(() => {
    const byRepo = new Map<string, NonNullable<typeof prs>>();
    for (const pr of prs ?? []) {
      if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
      byRepo.get(pr.repo)!.push(pr);
    }
    return Array.from(byRepo.entries());
  }, [prs]);

  useEffect(() => {
    if (!selectedPR) return;
    setCollapsedRepos((current) => {
      if (!current[selectedPR.repo]) return current;
      return { ...current, [selectedPR.repo]: false };
    });
  }, [selectedPR]);

  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-4">Loading PRs...</div>;
  }

  if (!prs?.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <GitPullRequest className="h-8 w-8 mb-3 opacity-40" />
        <p className="text-sm">No open PRs</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {repoEntries.map(([repo, repoPRs]) => {
        const repoSelected = selectedPR?.repo === repo;
        const collapsed = collapsedRepos[repo] ?? false;

        return (
          <RepoSection
            key={repo}
            repo={repo}
            count={repoPRs.length}
            selected={repoSelected}
            collapsed={collapsed}
            onToggle={() =>
              setCollapsedRepos((current) => ({
                ...current,
                [repo]: !(current[repo] ?? false),
              }))
            }
          >
            {repoPRs.map((pr) => {
              const isSelected =
                selectedPR?.repo === pr.repo &&
                selectedPR?.prNumber === pr.number;

              return (
                <div
                  key={`${pr.repo}-${pr.number}`}
                  className={cn(
                    "group flex items-start gap-3 rounded-md px-2 py-2 transition-all duration-150",
                    isSelected
                      ? "bg-primary/10 opacity-100"
                      : "opacity-60 hover:bg-muted/20 hover:opacity-100",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectPR(pr.repo, pr.number)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{pr.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge variant="outline">#{pr.number}</Badge>
                        <span className="text-xs text-muted-foreground/90">
                          {pr.headRefName}
                        </span>
                      </div>
                      <PRStatusIndicator repo={pr.repo} prNumber={pr.number} />
                    </div>
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-2 pt-0.5">
                    <CoordinatorChecklistToggle repo={pr.repo} prNumber={pr.number} />
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 text-muted-foreground transition-colors hover:text-foreground"
                      title="Open pull request on GitHub"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                </div>
              );
            })}
          </RepoSection>
        );
      })}
    </div>
  );
}
