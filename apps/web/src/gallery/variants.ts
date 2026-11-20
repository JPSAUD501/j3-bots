// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One entry per state the gallery shows beside the sample conversations: every
 * card status, fold ending and notice. Development only.
 */
import {
  AttachmentId,
  EntryId,
  EntryOrder,
  RoutineId,
  WorkStepId,
  type ApprovalEntry,
  type Author,
  type BotState,
  type HandoffEntry,
  type MessageEntry,
  type NoticeEntry,
  type QuestionEntry,
  type QuestionOption,
  type RoutineChangeEntry,
  type SecretRequestEntry,
  type WorkFoldEntry,
  type WorkStep,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { ids } from "./sample";

export function galleryVariants(now: DateTime.Utc) {
  const ago = (minutes: number) =>
    DateTime.makeUnsafe(DateTime.toEpochMillis(now) - minutes * 60_000);
  const ahead = (minutes: number) => ago(-minutes);
  const scout: Author = { _tag: "bot", botId: ids.scout };
  const id = (name: string) => EntryId.make(`variant-${name}`);
  const base = (name: string, author: Author = scout) => ({
    id: id(name),
    order: EntryOrder.make(0),
    author,
    createdAt: ago(4),
  });

  /** Each state as the avatar shows it; done is an idle bot with something unread. */
  const states: ReadonlyArray<readonly [string, BotState, boolean]> = [
    ["idle", { _tag: "idle" }, false],
    ["thinking", { _tag: "thinking", since: ago(0), stalled: false }, false],
    ["working", { _tag: "working", since: ago(2), stalled: false, activity: null }, false],
    ["waiting", { _tag: "waiting", entryId: id("question") }, false],
    ["blocked", { _tag: "blocked", failure: "usage-limit", retryAt: ahead(90) }, false],
    ["done", { _tag: "idle" }, true],
    ["stalled", { _tag: "working", since: ago(12), stalled: true, activity: null }, false],
  ];

  const message = (
    name: string,
    author: Author,
    text: string,
    extra: Partial<Pick<MessageEntry, "attachments" | "delivery">> = {},
  ): MessageEntry => ({
    _tag: "message",
    ...base(name, author),
    text,
    attachments: extra.attachments ?? [],
    mentions: { _tag: "bots", ids: [] },
    delivery: extra.delivery ?? { _tag: "delivered" },
    commandId: null,
  });

  const bubbles = {
    operator: message(
      "op",
      { _tag: "operator" },
      "Can you check whether the invoice from March was paid?",
    ),
    pending: message("pending", { _tag: "operator" }, "And April’s too, while you’re at it", {
      delivery: { _tag: "pending" },
    }),
    cancelled: message("cancelled", { _tag: "operator" }, "Skip May, it isn’t due yet", {
      delivery: { _tag: "cancelled" },
    }),
    failed: message("failed", { _tag: "operator" }, "Also check June", {
      delivery: { _tag: "failed", reason: "rejected" },
    }),
    unresolved: message("unresolved", { _tag: "operator" }, "And July, please", {
      delivery: { _tag: "failed", reason: "unresolved" },
    }),
    // Shown while a retry is on its way.
    retrying: message("retrying", { _tag: "operator" }, "And August, if it’s out", {
      delivery: { _tag: "failed", reason: "unresolved" },
    }),
    bot: message(
      "bot",
      scout,
      "March was paid on the 4th. April is still open: the due date is next Friday.\n\n```\ninvoice  status   due\n2026-03  paid     —\n2026-04  open     Nov 27\n```",
    ),
    withFiles: message("files", scout, "Both invoices, for your records.", {
      attachments: [
        {
          id: AttachmentId.make("v-march"),
          name: "Invoice 2026-03.pdf",
          mediaType: "application/pdf",
          size: 96_400,
        },
        {
          id: AttachmentId.make("v-april"),
          name: "Invoice 2026-04.pdf",
          mediaType: "application/pdf",
          size: 101_900,
        },
      ],
    }),
  };

  const option = (
    oid: string,
    label: string,
    description: string | null = null,
    style: QuestionOption["style"] = "default",
  ): QuestionOption => ({ id: oid, label, description, style });
  const singleQuestion = {
    id: "when",
    prompt: "Which day should the weekly summary go out?",
    options: [
      option("mon", "Monday morning"),
      option("fri", "Friday afternoon", null, "recommended"),
      option("both", "Both"),
    ],
    acceptsText: false,
    multiple: false,
  };
  const question = (
    name: string,
    status: QuestionEntry["status"],
    origin: QuestionEntry["origin"] = "ask",
  ): QuestionEntry => ({
    _tag: "question",
    ...base(name),
    origin,
    questions: [singleQuestion],
    status,
  });
  const questions: ReadonlyArray<QuestionEntry> = [
    question("question", { _tag: "pending" }),
    {
      _tag: "question",
      ...base("question-styles"),
      origin: "engine",
      questions: [
        {
          id: "drafts",
          prompt: "I found two exports of last year’s tax folder. What should I do with them?",
          options: [
            option(
              "keep",
              "Keep both",
              "I’ll name them so they’re easy to tell apart.",
              "recommended",
            ),
            option("merge", "Merge them into one"),
            option("delete", "Delete the older one", "It can’t be recovered.", "destructive"),
          ],
          acceptsText: false,
          multiple: false,
        },
      ],
      status: { _tag: "pending" },
    },
    {
      _tag: "question",
      ...base("question-form"),
      origin: "ask",
      questions: [
        {
          id: "sources",
          prompt: "What should the weekly money digest cover?",
          options: [
            option("charges", "Card charges", "Everything new since last week"),
            option("bills", "Bills due soon"),
            option("subscriptions", "Subscriptions that renew this month"),
          ],
          acceptsText: false,
          multiple: true,
        },
        {
          id: "when",
          prompt: "When should it arrive?",
          options: [option("monday", "Monday at 8:00 AM"), option("friday", "Friday at 5:00 PM")],
          acceptsText: true,
          multiple: false,
        },
        {
          id: "extra",
          prompt: "Anything else it should always mention?",
          options: [],
          acceptsText: true,
          multiple: false,
        },
      ],
      status: { _tag: "pending" },
    },
    question("question-answered", {
      _tag: "answered",
      answers: { when: { optionIds: ["fri"], text: null } },
    }),
    question("question-dismissed", { _tag: "dismissed" }),
    question("question-expired", { _tag: "expired" }, "engine"),
  ];

  const approval = (name: string, extra: Partial<ApprovalEntry>): ApprovalEntry => ({
    _tag: "approval",
    ...base(name),
    kind: "command",
    action: "rm -rf build/ && pnpm build",
    detail: null,
    reason: null,
    exact: true,
    sessionGrant: { covers: "every-command" },
    status: { _tag: "pending" },
    ...extra,
  });
  const approvalEntries: ReadonlyArray<ApprovalEntry> = [
    approval("approval", {
      action: [
        "pnpm db:migrate --env staging \\",
        "  --to 0042_invoice_totals \\",
        "  --batch-size 500",
      ].join("\n"),
    }),
    approval("approval-with-reason", {
      action: "pnpm install --frozen-lockfile",
      reason: "Needs network access to fetch packages, which the sandbox blocks.",
    }),
    approval("approval-summary", {
      action: "Run the staging migration, then restart the billing API",
      exact: false,
      sessionGrant: null,
    }),
    approval("approval-file-change", {
      kind: "file-change",
      action: "notes/taxes-2026/checklist.md",
      detail: {
        operation: "update",
        text: [
          "--- a/notes/taxes-2026/checklist.md",
          "+++ b/notes/taxes-2026/checklist.md",
          "@@ -3,5 +3,7 @@",
          " ## Before filing",
          " ",
          " - [x] Download the bank statements for 2026",
          "-- [ ] Ask the accountant about the home office",
          "+- [x] Ask the accountant about the home office",
          "+  Answer: deductible up to the share of floor area used only for work; keep the floor plan and the electricity bills with the return.",
          "+- [ ] Scan the pharmacy receipts",
          " - [ ] Fill in the donations section",
        ].join("\n"),
      },
      // The longest scope line, so the narrowest width shows it wrapped in every language.
      sessionGrant: { covers: "every-file-change" },
    }),
    // New files whose lines start with "-" and "+": contents, not a diff, so nothing is tinted.
    approval("approval-new-file", {
      kind: "file-change",
      action: "notes/trip-lisbon/packing.md",
      detail: {
        operation: "add",
        text: [
          "- Keep this list item",
          "- Passport and the printed boarding passes",
          "- Adapter for the Type F sockets",
        ].join("\n"),
      },
      sessionGrant: { covers: "every-file-change" },
    }),
    approval("approval-new-file-plus", {
      kind: "file-change",
      action: "notes/contacts/building.txt",
      detail: {
        operation: "add",
        text: ["+55 11 5555-0100  Front desk", "+55 11 5555-0142  Maintenance"].join("\n"),
      },
      sessionGrant: { covers: "every-file-change" },
    }),
    approval("approval-deleted-file", {
      kind: "file-change",
      action: "notes/drafts/old-budget.md",
      detail: { operation: "delete", text: "- Rent\n- Groceries" },
      sessionGrant: { covers: "every-file-change" },
    }),
    approval("approval-file-read", {
      kind: "file-read",
      action: "~/Documents/taxes-2026/receipts.csv",
      sessionGrant: null,
    }),
    approval("approval-submitting", {
      kind: "tool",
      action: "Add “Pick up the bike” to the shared calendar on Saturday at 10:00 AM",
      sessionGrant: null,
    }),
    approval("approval-allowed", {
      action: "pnpm --filter site deploy --env staging",
      status: { _tag: "decided", decision: "allow-session" },
    }),
    approval("approval-denied", {
      kind: "tool",
      action: "Send an email to the vendor list",
      exact: false,
      sessionGrant: null,
      status: { _tag: "decided", decision: "deny" },
    }),
    approval("approval-expired", { status: { _tag: "expired" } }),
  ];
  // The operator has just allowed the calendar change, and the decision is on its way.
  const approvals = approvalEntries.map((entry) => ({
    entry,
    submitting: entry.id === id("approval-submitting"),
  }));
  // A new file's approval as it opens, a summary, and as it stands once the change has been fetched.
  const becoming = approval("approval-becoming-exact", {
    kind: "file-change",
    action: "Create the packing list for the Lisbon trip",
    exact: false,
    sessionGrant: null,
  });
  const approvalBecomingExact = {
    summary: becoming,
    exact: {
      ...becoming,
      action: "notes/trip-lisbon/packing.md",
      detail: { operation: "add", text: "- Passport\n- Adapter for the Type F sockets" },
      exact: true,
      sessionGrant: { covers: "every-file-change" },
    } satisfies ApprovalEntry,
  };

  const secret = (
    name: string,
    status: SecretRequestEntry["status"],
    extra: Partial<Pick<SecretRequestEntry, "url" | "placeholder">> = {},
  ): SecretRequestEntry => ({
    _tag: "secret-request",
    ...base(name),
    label: "GitHub token",
    reason: "To open the pull request for the docs fix I need a token that can push to the repo.",
    url: extra.url ?? null,
    placeholder: extra.placeholder ?? null,
    status,
  });
  const secrets: ReadonlyArray<SecretRequestEntry> = [
    secret("secret", "pending", {
      url: "https://github.com/settings/tokens",
      placeholder: "ghp_…",
    }),
    secret("secret-provided", "provided"),
    secret("secret-declined", "declined"),
    secret("secret-expired", "expired"),
  ];

  const fold = (
    name: string,
    status: WorkFoldEntry["status"],
    stepCount: number,
  ): WorkFoldEntry => ({
    _tag: "work-fold",
    ...base(name),
    stepCount,
    status,
  });
  const step = (
    kind: WorkStep["kind"],
    label: string,
    status: WorkStep["status"] = "completed",
  ): WorkStep => ({
    id: WorkStepId.make(`variant-${label}`),
    kind,
    label,
    status,
    startedAt: ago(4),
    finishedAt: status === "running" ? null : ago(3),
  });
  const folds: ReadonlyArray<{
    entry: WorkFoldEntry;
    steps: ReadonlyArray<WorkStep> | null;
    open: boolean;
  }> = [
    {
      entry: fold("fold-running", { _tag: "running" }, 3),
      steps: [
        step("read", "src/billing/invoices.ts"),
        step("search", "unpaid invoices"),
        step("command", "pnpm test billing", "running"),
      ],
      open: true,
    },
    {
      entry: fold("fold-done", { _tag: "finished", finishedAt: ago(1), ending: "completed" }, 4),
      steps: [
        step("read", "invoices/2026-03.json"),
        step("tool", "Bank statement lookup"),
        step("edit", "memory/log/2026-11.md"),
        step("other", "Wrote the summary"),
      ],
      open: true,
    },
    {
      entry: fold(
        "fold-loading",
        { _tag: "finished", finishedAt: ago(3), ending: "completed" },
        12,
      ),
      steps: null,
      open: true,
    },
    {
      entry: fold(
        "fold-stopped",
        { _tag: "finished", finishedAt: ago(2), ending: "interrupted" },
        2,
      ),
      steps: [],
      open: false,
    },
    {
      entry: fold("fold-failed", { _tag: "finished", finishedAt: ago(0), ending: "failed" }, 1),
      steps: [step("web", "Read the vendor’s status page", "failed")],
      open: true,
    },
  ];

  const system: Author = { _tag: "system" };
  const notice = (name: string, value: NoticeEntry["notice"], retryable = false): NoticeEntry => ({
    _tag: "notice",
    ...base(name, system),
    notice: value,
    retryable,
  });
  const notices: ReadonlyArray<NoticeEntry> = [
    notice("notice-limit", { _tag: "turn-failed", failure: "usage-limit" }, true),
    notice("notice-provider", { _tag: "turn-failed", failure: "provider-error" }, true),
    notice("notice-session", { _tag: "turn-failed", failure: "session-lost" }),
    notice("notice-undelivered", { _tag: "undelivered" }, true),
    notice("notice-hops", { _tag: "chain-stopped", limit: "hops" }),
    notice("notice-fanout", { _tag: "chain-stopped", limit: "fan-out" }),
    notice("notice-waiting", { _tag: "waiting-in-conversation", botId: ids.juniper }),
  ];

  const handoffs: ReadonlyArray<HandoffEntry> = [
    {
      _tag: "handoff",
      ...base("handoff"),
      recipientId: ids.wren,
      text: "Can you shorten the newsletter’s opening to three sentences?",
      urgent: false,
    },
    {
      _tag: "handoff",
      ...base("handoff-urgent"),
      recipientId: ids.atlas,
      text: "The billing API on staging is still read-only ten minutes after the migration. Please look now.",
      urgent: true,
    },
  ];

  const change = (
    name: string,
    kind: RoutineChangeEntry["change"],
    trigger: RoutineChangeEntry["trigger"],
  ): RoutineChangeEntry => ({
    _tag: "routine-change",
    ...base(name),
    routineId: RoutineId.make(`variant-${name}`),
    name: "Bill reminders",
    change: kind,
    trigger,
  });
  const halfHourly = {
    _tag: "schedule",
    cron: "*/30 * * * *",
    timeZone: "America/Sao_Paulo",
  } as const;
  const routineChanges: ReadonlyArray<RoutineChangeEntry> = [
    change("rc-created", "created", halfHourly),
    change("rc-updated", "updated", {
      _tag: "schedule",
      cron: "15 9 * * 1,3,5",
      timeZone: "America/Sao_Paulo",
    }),
    change("rc-paused", "paused", halfHourly),
    change("rc-once", "created", { _tag: "once", at: ahead(3 * 24 * 60 + 15) }),
    change("rc-webhook", "resumed", { _tag: "webhook" }),
    change("rc-deleted", "deleted", {
      _tag: "schedule",
      cron: "0 7 1 * *",
      timeZone: "America/Sao_Paulo",
    }),
  ];

  return {
    states,
    bubbles,
    questions,
    approvals,
    approvalBecomingExact,
    secrets,
    folds,
    notices,
    handoffs,
    routineChanges,
  };
}
