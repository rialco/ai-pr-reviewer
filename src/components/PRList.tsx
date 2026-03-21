import { useOpenPRs, usePRStatus } from "../hooks/useApi";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { GitPullRequest, ExternalLink } from "lucide-react";

const phaseColor: Record<string, string> = {
  polled: "bg-muted-foreground",
  analyzed: "bg-primary",
  fixing: "bg-fixing",
  fixed: "bg-fixed",
  re_review_requested: "bg-fixed",
  waiting_for_review: "bg-should-fix",
};

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
            <span key={reviewerId} title={reviewerId}>
              <Badge
                variant={score >= 4 ? "confidence_high" : score >= 3 ? "confidence_low" : "confidence_danger"}
                className="text-[10px] px-1 py-0"
              >
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

interface PRListProps {
  onSelectPR: (repo: string, prNumber: number) => void;
  selectedPR: { repo: string; prNumber: number } | null;
}

export function PRList({ onSelectPR, selectedPR }: PRListProps) {
  const { data: prs, isLoading } = useOpenPRs();

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

  // Group by repo
  const byRepo = new Map<string, typeof prs>();
  for (const pr of prs) {
    if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
    byRepo.get(pr.repo)!.push(pr);
  }

  return (
    <div className="space-y-4">
      {Array.from(byRepo.entries()).map(([repo, repoPRs]) => (
        <div key={repo}>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1 mb-2">
            {repo}
          </h3>
          <div className="space-y-1.5">
            {repoPRs.map((pr) => {
              const isSelected =
                selectedPR?.repo === pr.repo &&
                selectedPR?.prNumber === pr.number;
              return (
                <button
                  key={`${pr.repo}-${pr.number}`}
                  onClick={() => onSelectPR(pr.repo, pr.number)}
                  className={`w-full text-left rounded-md px-3 py-2.5 transition-colors ${
                    isSelected
                      ? "bg-primary/10 border border-primary/20"
                      : "hover:bg-accent/50 border border-transparent"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{pr.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline">#{pr.number}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {pr.headRefName}
                        </span>
                      </div>
                      <PRStatusIndicator repo={pr.repo} prNumber={pr.number} />
                    </div>
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-muted-foreground hover:text-foreground mt-0.5"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
