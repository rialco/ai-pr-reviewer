import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { Badge } from "./ui/badge";
import { api } from "../../convex/_generated/api";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { cn } from "@/lib/utils";
import { GitPullRequest, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";

const phaseColor: Record<string, string> = {
  polled: "bg-muted-foreground",
  blocked: "bg-amber-400",
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
    <section className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/20"
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
          <div className="border-t border-border/50 px-3 py-2">
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
  const { activeWorkspaceId } = useActiveWorkspace();
  const prs = useQuery(
    api.prs.listForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const repoEntries = useMemo(() => {
    const byRepo = new Map<string, NonNullable<typeof prs>>();
    for (const pr of prs ?? []) {
      if (!byRepo.has(pr.repoLabel)) byRepo.set(pr.repoLabel, []);
      byRepo.get(pr.repoLabel)!.push(pr);
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

  if (!prs) {
    return <div className="text-sm text-muted-foreground p-4">Loading PRs...</div>;
  }

  if (!prs.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <GitPullRequest className="h-8 w-8 mb-3 opacity-40" />
        <p className="text-sm">No open PRs</p>
      </div>
    );
  }

  return (
    <div>
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
            <div className="space-y-2">
              {repoPRs.map((pr) => {
                const isSelected =
                  selectedPR?.repo === pr.repoLabel &&
                  selectedPR?.prNumber === pr.prNumber;
                const phase = pr.phase ?? "polled";

                return (
                  <div
                    key={`${pr.repoLabel}-${pr.prNumber}`}
                    className={cn(
                      "group flex items-start gap-3 rounded-xl border px-3 py-3 transition-all duration-150",
                      isSelected
                        ? "border-primary/30 bg-primary/10 opacity-100"
                        : "border-transparent opacity-70 hover:border-border/70 hover:bg-muted/20 hover:opacity-100",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectPR(pr.repoLabel, pr.prNumber)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="min-w-0">
                        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                          <Badge
                            variant="outline"
                            className="row-span-2 min-h-11 items-center self-stretch px-2.5 text-sm font-semibold"
                          >
                            #{pr.prNumber}
                          </Badge>
                          <p className="truncate text-sm font-medium">{pr.title}</p>
                          <span className="truncate text-xs text-muted-foreground/90">
                            {pr.headRefName ?? "unknown branch"}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-end">
                          {phase !== "polled" ? (
                            <span
                              className={`h-2 w-2 rounded-full ${phaseColor[phase] ?? "bg-muted-foreground"}`}
                              title={phase}
                            />
                          ) : null}
                        </div>
                      </div>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-2 pt-0.5">
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                        onClick={(event) => event.stopPropagation()}
                        title="Open on GitHub"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </RepoSection>
        );
      })}
    </div>
  );
}
