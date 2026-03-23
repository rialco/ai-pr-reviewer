import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkSubject: v.string(),
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    lastSeenAt: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_tokenIdentifier", ["tokenIdentifier"])
    .index("by_clerkSubject", ["clerkSubject"]),

  workspaces: defineTable({
    slug: v.string(),
    name: v.string(),
    kind: v.union(v.literal("personal"), v.literal("organization")),
    ownerUserId: v.id("users"),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_slug", ["slug"])
    .index("by_ownerUserId", ["ownerUserId"]),

  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("admin"), v.literal("member")),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_workspaceId", ["workspaceId"])
    .index("by_userId", ["userId"])
    .index("by_workspaceId_userId", ["workspaceId", "userId"]),

  repos: defineTable({
    workspaceId: v.id("workspaces"),
    owner: v.string(),
    repo: v.string(),
    label: v.string(),
    botUsers: v.array(v.string()),
    defaultBranch: v.optional(v.string()),
    archivedAt: v.optional(v.string()),
    createdByUserId: v.id("users"),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_workspaceId", ["workspaceId"])
    .index("by_workspaceId_label", ["workspaceId", "label"]),

  repoMachineConfigs: defineTable({
    repoId: v.id("repos"),
    workspaceId: v.id("workspaces"),
    machineSlug: v.string(),
    localPath: v.string(),
    skipTypecheck: v.boolean(),
    lastSeenAt: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_repoId_machineSlug", ["repoId", "machineSlug"])
    .index("by_machineSlug", ["machineSlug"])
    .index("by_workspaceId", ["workspaceId"]),

  prs: defineTable({
    workspaceId: v.id("workspaces"),
    repoId: v.id("repos"),
    repoLabel: v.string(),
    prNumber: v.number(),
    title: v.string(),
    body: v.optional(v.string()),
    url: v.string(),
    author: v.string(),
    headRefName: v.optional(v.string()),
    baseRefName: v.optional(v.string()),
    mergeable: v.optional(v.union(v.literal("MERGEABLE"), v.literal("CONFLICTING"), v.literal("UNKNOWN"))),
    mergeStateStatus: v.optional(
      v.union(
        v.literal("BEHIND"),
        v.literal("BLOCKED"),
        v.literal("CLEAN"),
        v.literal("DIRTY"),
        v.literal("DRAFT"),
        v.literal("HAS_HOOKS"),
        v.literal("UNKNOWN"),
        v.literal("UNSTABLE"),
      ),
    ),
    phase: v.optional(
      v.union(
        v.literal("polled"),
        v.literal("blocked"),
        v.literal("analyzed"),
        v.literal("fixing"),
        v.literal("fixed"),
        v.literal("merge_ready"),
        v.literal("re_review_requested"),
        v.literal("waiting_for_review"),
      ),
    ),
    reviewCycle: v.optional(v.number()),
    confidenceScore: v.optional(v.number()),
    additions: v.optional(v.number()),
    deletions: v.optional(v.number()),
    changedFiles: v.optional(v.number()),
    commitCount: v.optional(v.number()),
    files: v.optional(
      v.array(
        v.object({
          path: v.string(),
          additions: v.number(),
          deletions: v.number(),
        }),
      ),
    ),
    lastFixedAt: v.optional(v.string()),
    lastReReviewAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_repoId_prNumber", ["repoId", "prNumber"])
    .index("by_workspaceId_updatedAt", ["workspaceId", "updatedAt"]),

  githubComments: defineTable({
    workspaceId: v.id("workspaces"),
    repoId: v.id("repos"),
    prId: v.id("prs"),
    repoLabel: v.string(),
    githubCommentId: v.number(),
    type: v.union(v.literal("inline"), v.literal("review"), v.literal("issue_comment")),
    user: v.string(),
    body: v.string(),
    path: v.optional(v.string()),
    line: v.optional(v.number()),
    diffHunk: v.optional(v.string()),
    status: v.optional(v.string()),
    analysisCategory: v.optional(v.string()),
    analysisReasoning: v.optional(v.string()),
    analysisDetails: v.optional(
      v.object({
        verdict: v.optional(
          v.union(v.literal("ACTIONABLE"), v.literal("DISMISS"), v.literal("ALREADY_ADDRESSED")),
        ),
        severity: v.optional(
          v.union(v.literal("MUST_FIX"), v.literal("SHOULD_FIX"), v.literal("NICE_TO_HAVE"), v.null()),
        ),
        confidence: v.optional(v.union(v.number(), v.null())),
        accessMode: v.optional(v.union(v.literal("FULL_CODEBASE"), v.literal("DIFF_ONLY"))),
        evidence: v.optional(
          v.union(
            v.object({
              filesRead: v.array(v.string()),
              symbolsChecked: v.array(v.string()),
              callersChecked: v.array(v.string()),
              testsChecked: v.array(v.string()),
              riskSummary: v.optional(v.string()),
              validationNotes: v.optional(v.string()),
            }),
            v.null(),
          ),
        ),
      }),
    ),
    fixCommitHash: v.optional(v.string()),
    fixCommitMessage: v.optional(v.string()),
    fixFilesChanged: v.optional(v.array(v.string())),
    fixFixedAt: v.optional(v.string()),
    repliedAt: v.optional(v.string()),
    replyBody: v.optional(v.string()),
    githubUrl: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_prId", ["prId"])
    .index("by_repoCommentId", ["repoLabel", "githubCommentId"]),

  reviews: defineTable({
    workspaceId: v.id("workspaces"),
    prId: v.id("prs"),
    reviewerId: v.string(),
    source: v.string(),
    confidenceScore: v.optional(v.number()),
    summary: v.optional(v.string()),
    rawOutput: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_prId_reviewer", ["prId", "reviewerId"]),

  reviewComments: defineTable({
    workspaceId: v.id("workspaces"),
    prId: v.id("prs"),
    reviewId: v.id("reviews"),
    reviewerId: v.string(),
    path: v.string(),
    line: v.number(),
    body: v.string(),
    status: v.string(),
    analysisCategory: v.optional(v.string()),
    analysisReasoning: v.optional(v.string()),
    analysisDetails: v.optional(
      v.object({
        verdict: v.optional(
          v.union(v.literal("ACTIONABLE"), v.literal("DISMISS"), v.literal("ALREADY_ADDRESSED")),
        ),
        severity: v.optional(
          v.union(v.literal("MUST_FIX"), v.literal("SHOULD_FIX"), v.literal("NICE_TO_HAVE"), v.null()),
        ),
        confidence: v.optional(v.union(v.number(), v.null())),
        accessMode: v.optional(v.union(v.literal("FULL_CODEBASE"), v.literal("DIFF_ONLY"))),
        evidence: v.optional(
          v.union(
            v.object({
              filesRead: v.array(v.string()),
              symbolsChecked: v.array(v.string()),
              callersChecked: v.array(v.string()),
              testsChecked: v.array(v.string()),
              riskSummary: v.optional(v.string()),
              validationNotes: v.optional(v.string()),
            }),
            v.null(),
          ),
        ),
      }),
    ),
    suggestion: v.optional(v.string()),
    publishedAt: v.optional(v.string()),
    supersededAt: v.optional(v.string()),
    fixCommitHash: v.optional(v.string()),
    fixFilesChanged: v.optional(v.array(v.string())),
    fixFixedAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_prId", ["prId"])
    .index("by_reviewId", ["reviewId"]),

  timelineEvents: defineTable({
    workspaceId: v.id("workspaces"),
    prId: v.id("prs"),
    eventType: v.string(),
    detail: v.any(),
    debugDetail: v.optional(v.any()),
    createdAt: v.string(),
  }).index("by_prId_createdAt", ["prId", "createdAt"]),

  machines: defineTable({
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    name: v.string(),
    authToken: v.string(),
    hostname: v.optional(v.string()),
    platform: v.optional(v.string()),
    version: v.optional(v.string()),
    status: v.union(v.literal("offline"), v.literal("idle"), v.literal("busy"), v.literal("error")),
    capabilities: v.object({
      git: v.boolean(),
      gh: v.boolean(),
      claude: v.boolean(),
      codex: v.boolean(),
    }),
    currentJobId: v.optional(v.id("jobs")),
    currentJobLabel: v.optional(v.string()),
    lastHeartbeatAt: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_workspaceId", ["workspaceId"])
    .index("by_workspaceId_slug", ["workspaceId", "slug"])
    .index("by_authToken", ["authToken"]),

  machineEnrollmentTokens: defineTable({
    workspaceId: v.id("workspaces"),
    token: v.string(),
    label: v.optional(v.string()),
    createdByUserId: v.id("users"),
    claimedMachineId: v.optional(v.id("machines")),
    claimedAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
    expiresAt: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_token", ["token"])
    .index("by_workspaceId", ["workspaceId"]),

  jobs: defineTable({
    workspaceId: v.id("workspaces"),
    repoId: v.optional(v.id("repos")),
    prId: v.optional(v.id("prs")),
    createdByUserId: v.id("users"),
    kind: v.union(
      v.literal("sync_repo"),
      v.literal("refresh_pr"),
      v.literal("analyze_comments"),
      v.literal("fix_comments"),
      v.literal("request_review"),
      v.literal("publish_review"),
      v.literal("reply_comment"),
      v.literal("machine_command"),
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("claimed"),
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("cancelled"),
    ),
    targetMachineSlug: v.optional(v.string()),
    claimedByMachineId: v.optional(v.id("machines")),
    claimedAt: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    finishedAt: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    title: v.string(),
    payload: v.any(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_workspaceId_createdAt", ["workspaceId", "createdAt"])
    .index("by_workspaceId_status_createdAt", ["workspaceId", "status", "createdAt"])
    .index("by_targetMachineSlug_status", ["targetMachineSlug", "status"]),

  jobRuns: defineTable({
    workspaceId: v.id("workspaces"),
    jobId: v.id("jobs"),
    machineSlug: v.optional(v.string()),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
    steps: v.array(
      v.object({
        step: v.string(),
        detail: v.optional(v.string()),
        status: v.union(v.literal("active"), v.literal("done"), v.literal("error")),
        ts: v.string(),
      }),
    ),
    output: v.array(v.string()),
    startedAt: v.string(),
    finishedAt: v.optional(v.string()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_workspaceId", ["workspaceId"]),
});
