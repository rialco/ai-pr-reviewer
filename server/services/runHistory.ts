import type {
  PersistedRunHistory,
  PersistedRunStatus,
  RunHistoryStep,
} from "../types.js";

const OUTPUT_LIMIT = 200;

function cloneSteps(steps: RunHistoryStep[]): RunHistoryStep[] {
  return steps.map((step) => ({ ...step }));
}

export function inferRunStatus(
  steps: RunHistoryStep[],
  finishedAt?: string,
): PersistedRunStatus {
  if (steps.some((step) => step.status === "error")) return "error";
  if (finishedAt) return "done";
  return "running";
}

export function buildPersistedRunHistory(input: {
  startedAt: string;
  finishedAt?: string;
  currentStep?: string;
  detail?: string;
  steps: RunHistoryStep[];
  output: string[];
  status?: PersistedRunStatus;
}): PersistedRunHistory {
  return {
    status: input.status ?? inferRunStatus(input.steps, input.finishedAt),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    currentStep: input.currentStep,
    detail: input.detail,
    steps: cloneSteps(input.steps),
    output: [...input.output],
  };
}

export class RunHistoryTracker {
  private readonly onUpdate?: (history: PersistedRunHistory) => void;
  private readonly history: PersistedRunHistory;

  constructor(options?: {
    startedAt?: string;
    currentStep?: string;
    detail?: string;
    onUpdate?: (history: PersistedRunHistory) => void;
  }) {
    this.onUpdate = options?.onUpdate;
    this.history = {
      status: "running",
      startedAt: options?.startedAt ?? new Date().toISOString(),
      currentStep: options?.currentStep ?? options?.detail,
      detail: options?.detail,
      steps: [],
      output: [],
    };
  }

  publish(): void {
    this.emit();
  }

  step(step: string, detail?: string): void {
    for (const entry of this.history.steps) {
      if (entry.status === "active") entry.status = "done";
    }

    this.history.steps.push({
      step,
      status: "active",
      detail,
      ts: new Date().toISOString(),
    });
    this.history.currentStep = step;
    this.history.detail = detail ?? step;
    this.history.status = "running";
    delete this.history.finishedAt;
    this.emit();
  }

  output(line: string): void {
    this.history.output.push(line);
    if (this.history.output.length > OUTPUT_LIMIT) {
      this.history.output = this.history.output.slice(-OUTPUT_LIMIT);
    }
    this.emit();
  }

  complete(detail?: string): void {
    for (const entry of this.history.steps) {
      if (entry.status === "active") entry.status = "done";
    }
    this.history.status = "done";
    this.history.finishedAt = new Date().toISOString();
    if (detail) this.history.detail = detail;
    this.emit();
  }

  fail(error: string): void {
    let markedActive = false;
    for (const entry of this.history.steps) {
      if (entry.status === "active") {
        entry.status = "error";
        entry.detail = error;
        markedActive = true;
      }
    }

    if (!markedActive && this.history.steps.length > 0) {
      const last = this.history.steps[this.history.steps.length - 1];
      last.status = "error";
      last.detail = error;
    }

    this.history.status = "error";
    this.history.finishedAt = new Date().toISOString();
    this.history.detail = error;
    this.emit();
  }

  snapshot(): PersistedRunHistory {
    return buildPersistedRunHistory(this.history);
  }

  private emit(): void {
    this.onUpdate?.(this.snapshot());
  }
}
