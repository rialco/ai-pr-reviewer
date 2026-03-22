import { ChevronDown, Settings2, Sparkles } from "lucide-react";
import { useAvailableReviewers, useSettings, useUpdateSettings, type ReviewerId } from "../hooks/useApi";
import { AgentLogo, getAgentLabel } from "./ui/agent-logo";
import { Popover } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

const COORDINATOR_CHECK_INTERVAL_SECONDS = 30;
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
                Checks every {COORDINATOR_CHECK_INTERVAL_SECONDS}s
              </p>
            </div>
            <Switch
              checked={coordinatorEnabled}
              size="sm"
              disabled={updateSettings.isPending}
              aria-label={coordinatorEnabled ? "Disable agent coordinator" : "Enable agent coordinator"}
              onClick={() => updateSettings.mutate({ coordinatorEnabled: !coordinatorEnabled })}
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
              Coordinator Agent
            </span>
            <Select
              value={coordinatorAgent}
              onValueChange={(value) =>
                updateSettings.mutate({ coordinatorAgent: value === "codex" ? "codex" : "claude" })
              }
              disabled={updateSettings.isPending}
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
                Fixer
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
                    updateSettings.isPending ||
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
            {coordinatorEnabled ? `Checks every ${COORDINATOR_CHECK_INTERVAL_SECONDS}s` : "Automation off"}
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
