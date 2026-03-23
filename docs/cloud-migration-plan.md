# Cloud Migration Plan

## Goal

Move this project from a single local-process architecture to a split architecture:

- `Clerk` handles user authentication and workspace identity.
- `Convex` becomes the cloud control plane and source of truth.
- Local machines remain the execution plane for `git`, `gh`, `claude`, `codex`, worktrees, and repository access.

This keeps the app accessible anywhere while preserving local subscriptions and local execution.

## Workflow Changes

### Before

- One local Express process owns state, polling, fixing, and orchestration.
- GitHub identity is whichever account is logged into `gh` on the active machine.
- The UI polls local REST endpoints for changes.

### After

- The browser signs into Clerk and reads cloud state from Convex.
- Convex stores repos, PR state, comments, timeline, jobs, and machine availability.
- Machines connect as workers, report health, and claim work.
- The browser becomes realtime through Convex subscriptions instead of local polling.
- Execution still happens on linked computers, not inside Convex.

## GitHub Identity Model

Recommended split:

- Use a stable cloud-side GitHub integration for visibility and sync.
- Use the local machine identity for workstation-bound actions like local checkout, commit, push, and optional comment/review posting.

This avoids tying visibility to whichever machine currently runs `gh pr list --author @me`.

## Why `localPath` Must Change

The current repo config stores one machine-local path per repo. That does not survive a cloud move.

The new model must be:

- `repo`: cloud record shared by the workspace.
- `repoMachineConfig`: per-machine checkout path and per-machine execution settings.

## Machine Model

Each machine should eventually have:

- Stable machine slug and display name.
- Workspace enrollment flow.
- Heartbeat and status updates.
- Capability report for `git`, `gh`, `claude`, and `codex`.
- Job claiming with lease renewal.
- Run logs streamed back into Convex.

## Phase Breakdown

### Phase 1

- Add Clerk and Convex scaffolding.
- Add Convex schema for users, workspaces, repos, machines, PRs, comments, and jobs.
- Gate the UI with Clerk while preserving legacy local mode when env vars are missing.
- Add a worker scaffold that makes the local execution plane explicit.
- Configure Convex auth against Clerk's `CLERK_FRONTEND_API_URL`, which is the current Clerk integration guidance.

### Phase 2

- Initialize a real Convex project and generate `convex/_generated`.
- Replace generic Convex function wrappers with generated typed wrappers.
- Add authenticated workspace bootstrap in the UI.
- Introduce workspace-aware repo management in Convex.

### Phase 3

- Implement machine enrollment and authenticated heartbeats.
- Build the machine job-claiming protocol.
- Move activity feed and coordinator state to Convex.

### Phase 4

- Replace local REST polling with Convex subscriptions for repos, jobs, and machines.
- Move local-path management from the Express backend to machine-bound configuration.

### Phase 5

- Rework GitHub sync around a durable identity model.
- Decide which actions post as the user versus a bot/app identity.

## Current Branch Status

This branch keeps the existing Express app available as a fallback when cloud env vars are missing, but cloud mode itself is now end-to-end for the main PR workflow.

That means:

- The old local REST workflow still exists as a non-cloud fallback.
- Cloud mode reads repos, PRs, comments, timeline, jobs, and machines from Convex.
- Worker enrollment, heartbeats, job claiming, and run logs are implemented.
- Cloud jobs now cover repo sync, PR refresh, local AI reviews, local review triage/fix/publish, and GitHub comment triage/fix/reply.
- Repository onboarding in cloud mode is machine-bound and no longer mirrors repo state back into SQLite.

## Immediate Next Steps

1. Tighten the cloud UX so machine selection, job state, and action affordances feel unified instead of transitional.
2. Decide whether legacy local-only routes remain as fallback mode or should start being removed from this branch.
3. Formalize the GitHub identity model for cloud sync versus local machine writes.
4. Add more machine/workspace management controls such as machine renaming, lease visibility, and stale-session recovery.
