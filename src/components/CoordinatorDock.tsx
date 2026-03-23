import { useMutation, useQuery } from "convex/react";
import { ChevronDown, Loader2, Play, Settings2, Sparkles } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { useActiveWorkspace } from "@/hooks/useActiveWorkspace";
import { AgentLogo, getAgentLabel } from "./ui/agent-logo";
import { Button } from "./ui/button";
import { Popover } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

const COORDINATOR_CHECK_INTERVAL_SECONDS = 30;
type ReviewerId = "greptile" | "claude" | "codex";
const REVIEWER_ORDER: ReviewerId[] = ["claude", "codex", "greptile"];

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

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
        {selected ? "On" : unavailable ? "Off" : "Ready"}
      </span>
    </button>
  );
}

interface CoordinatorDockProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CoordinatorDock({ open, onOpenChange }: CoordinatorDockProps) {
  const { activeWorkspaceId } = useActiveWorkspace();
  const settings = useQuery(
    api.settings.getForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const reviewers = useQuery(
    api.settings.listAvailableReviewers,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const coordinatorStatus = useQuery(
    api.coordinator.getStatusForWorkspace,
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : "skip",
  );
  const updateSettings = useMutation(api.settings.updateForWorkspace);
  const runCoordinatorNow = useMutation(api.coordinator.runNowForWorkspace);
  const coordinatorAgent = settings?.coordinatorAgent ?? "claude";
  const coordinatorEnabled = settings?.coordinatorEnabled ?? false;
  const defaultAnalyzerAgent = settings?.defaultAnalyzerAgent ?? "claude";
  const defaultFixerAgent = settings?.defaultFixerAgent ?? "claude";
  const defaultReviewerIds = settings?.defaultReviewerIds ?? ["claude", "codex"];
  const reviewerAvailability = new Map((reviewers ?? []).map((reviewer) => [reviewer.id, reviewer.available]));
  const latestRun = coordinatorStatus?.latestRun ?? null;
  const [runNowError, setRunNowError] = useState<string | null>(null);
  const [isRunningNow, setIsRunningNow] = useState(false);

  const toggleDefaultReviewer = (reviewerId: ReviewerId) => {
    if (!activeWorkspaceId) {
      return;
    }

    const next = defaultReviewerIds.includes(reviewerId)
      ? defaultReviewerIds.filter((id) => id !== reviewerId)
      : [...defaultReviewerIds, reviewerId];

    if (next.length === 0) {
      return;
    }

    void updateSettings({
      workspaceId: activeWorkspaceId,
      defaultReviewerIds: next,
    });
  };

  const handleRunNow = async () => {
    if (!activeWorkspaceId || isRunningNow) {
      return;
    }

    try {
      setIsRunningNow(true);
      setRunNowError(null);
      await runCoordinatorNow({
        workspaceId: activeWorkspaceId,
      });
    } catch (error) {
      setRunNowError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunningNow(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      className="min-w-0"
      contentContainerClassName="fixed bottom-1 left-[calc(340px+8px)]"
      contentClassName="max-h-[calc(100vh-0.5rem)] w-[26rem] overflow-y-auto"
      content={
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/20 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Coordinator
              </p>
              <p className="mt-1 text-xs text-foreground/90">
                Runs the next clear workflow step automatically.
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Cron runs every {coordinatorStatus?.intervalSeconds ?? COORDINATOR_CHECK_INTERVAL_SECONDS}s when enabled
              </p>
            </div>
            <Switch
              checked={coordinatorEnabled}
              size="sm"
              disabled={!activeWorkspaceId}
              aria-label={coordinatorEnabled ? "Disable agent coordinator" : "Enable agent coordinator"}
              onClick={() => {
                if (!activeWorkspaceId) return;
                void updateSettings({
                  workspaceId: activeWorkspaceId,
                  coordinatorEnabled: !coordinatorEnabled,
                });
              }}
            />
          </div>

          <div className="rounded-lg border border-border/60 bg-card/70 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Runtime
                </p>
                <p className="mt-1 text-xs text-foreground/90">
                  {latestRun?.summary ?? "No coordinator pass has run yet."}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Last run: {formatTimestamp(latestRun?.finishedAt ?? latestRun?.startedAt)}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Active jobs: {coordinatorStatus?.activeJobCount ?? 0}
                  {latestRun
                    ? ` • ${latestRun.trigger === "manual" ? "manual" : "scheduled"} • ${latestRun.status}`
                    : ""}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => void handleRunNow()} disabled={!activeWorkspaceId || isRunningNow}>
                {isRunningNow ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                Run now
              </Button>
            </div>
            {runNowError ? <p className="mt-2 text-[10px] text-destructive">{runNowError}</p> : null}
            {latestRun?.actions?.length ? (
              <div className="mt-3 space-y-1.5">
                <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Latest Actions
                </p>
                <div className="space-y-1.5">
                  {latestRun.actions.slice(0, 4).map((action) => (
                    <div key={`${action.kind}-${action.repoLabel}-${action.prNumber}-${action.machineSlug}`} className="rounded-md border border-border/50 bg-background/50 px-2.5 py-2">
                      <p className="text-[11px] font-medium text-foreground/95">
                        {action.repoLabel} #{action.prNumber} • {action.kind}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {action.machineSlug} • {action.reason}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
              Coordinator Agent
            </span>
            <Select
              value={coordinatorAgent}
              onValueChange={(value) => {
                if (!activeWorkspaceId) return;
                void updateSettings({
                  workspaceId: activeWorkspaceId,
                  coordinatorAgent: value === "codex" ? "codex" : "claude",
                });
              }}
              disabled={!activeWorkspaceId}
            >
              <SelectTrigger className="h-8 rounded-md border border-border bg-transparent px-2.5 text-xs text-foreground/90 shadow-none focus:ring-0">
                <SelectValue placeholder="Coordinator" />
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
                Analyzer
              </span>
              <Select
                value={defaultAnalyzerAgent}
                onValueChange={(value) => {
                  if (!activeWorkspaceId) return;
                  void updateSettings({
                    workspaceId: activeWorkspaceId,
                    defaultAnalyzerAgent: value === "codex" ? "codex" : "claude",
                  });
                }}
                disabled={!activeWorkspaceId}
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
                Fixer
              </span>
              <Select
                value={defaultFixerAgent}
                onValueChange={(value) => {
                  if (!activeWorkspaceId) return;
                  void updateSettings({
                    workspaceId: activeWorkspaceId,
                    defaultFixerAgent: value === "codex" ? "codex" : "claude",
                  });
                }}
                disabled={!activeWorkspaceId}
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
                Reviewers
              </span>
              <span className="text-[10px] text-muted-foreground/60">
                Local first
              </span>
            </div>

            <div className="grid gap-2">
              {REVIEWER_ORDER.map((reviewerId) => (
                <PreferencePill
                  key={reviewerId}
                  agent={reviewerId}
                  selected={defaultReviewerIds.includes(reviewerId)}
                  unavailable={reviewerAvailability.get(reviewerId) === false}
                  disabled={
                    !activeWorkspaceId ||
                    (defaultReviewerIds.length === 1 && defaultReviewerIds.includes(reviewerId))
                  }
                  onClick={() => toggleDefaultReviewer(reviewerId)}
                />
              ))}
            </div>
          </div>
        </div>
      }
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={`flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors ${
          open ? "border-primary/30 bg-primary/10" : "border-border bg-card/80 hover:bg-muted/20"
        }`}
      >
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
            coordinatorEnabled
              ? "border-primary/25 bg-primary/10"
              : "border-border bg-muted/40"
          }`}
        >
          {coordinatorEnabled ? (
            <AgentLogo agent={coordinatorAgent} className="h-3.5 w-3.5" />
          ) : (
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Coordinator
          </p>
          <p className="truncate text-xs font-medium text-foreground/95">
            {coordinatorEnabled ? getAgentLabel(coordinatorAgent) : "Standby"}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {coordinatorEnabled
              ? `Runs every ${coordinatorStatus?.intervalSeconds ?? COORDINATOR_CHECK_INTERVAL_SECONDS}s`
              : "Automation off"}
          </p>
        </div>

        {coordinatorEnabled ? (
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary/80" />
        ) : null}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
    </Popover>
  );
}
