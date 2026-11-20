// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A sample team for development and the gallery: every bot state, every kind of
 * entry, typed from the contracts. Development only; builds do not include it.
 */
import {
  AttachmentId,
  BotId,
  EntryId,
  MemoryPath,
  ModelId,
  ProviderId,
  RoomId,
  RoutineId,
  RoutineRunId,
  WorkStepId,
  type Attachment,
  type Bot,
  type BotFile,
  type BotState,
  type EngineStatus,
  type Entry,
  type MemoryFile,
  type Mentions,
  type Room,
  type RosterItem,
  type Routine,
  type WorkStep,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { ordered, previewOf, type DraftEntry } from "./entries";

const claude = ProviderId.make("claude-code");
const codex = ProviderId.make("codex");

export const ids = {
  scout: BotId.make("scout"),
  juniper: BotId.make("juniper"),
  atlas: BotId.make("atlas"),
  wren: BotId.make("wren"),
  ledger: BotId.make("ledger"),
  otto: BotId.make("otto"),
  maple: BotId.make("maple"),
  iris: BotId.make("iris"),
  pip: BotId.make("pip"),
  moss: BotId.make("moss"),
  launch: RoomId.make("website-launch"),
};

/**
 * The moment the sample team is placed at, in development and in the gallery
 * alike, so what they show does not change from one day to the next.
 */
export const SAMPLE_NOW = DateTime.makeUnsafe("2026-11-20T17:40:00Z");

/** The sample team as it stands at `now`: every time in it is placed relative to that moment. */
export function sampleTeam(now: DateTime.Utc) {
  const ago = (minutes: number) =>
    DateTime.makeUnsafe(DateTime.toEpochMillis(now) - minutes * 60_000);
  const ahead = (minutes: number) => ago(-minutes);
  const engine: EngineStatus = {
    state: { _tag: "ready" },
    pinnedVersion: "0.1.10",
    providers: [
      {
        id: claude,
        name: "Claude Code",
        harness: "claude-code",
        status: { _tag: "ready" },
        models: [
          { id: ModelId.make("claude-opus-5-5"), name: "Claude Opus 5.5" },
          { id: ModelId.make("claude-sonnet-5-5"), name: "Claude Sonnet 5.5" },
        ],
        usage: [{ label: "5 hours", usedPercent: 38, resetsAt: ahead(140) }],
      },
      {
        id: codex,
        name: "Codex",
        harness: "codex",
        status: { _tag: "sign-in-required" },
        models: [],
        usage: [],
      },
    ],
  };

  function bot(
    id: BotId,
    name: string,
    title: string,
    shape: string,
    color: string,
    state: BotState,
    extra: Partial<Pick<Bot, "pinned" | "hidden" | "primary" | "permissionMode">> = {},
  ): Bot {
    return {
      id,
      profile: {
        name,
        title,
        avatar: { shape, color },
        job:
          title === ""
            ? ""
            : `Handles ${title.toLowerCase()} for the operator. Asks before spending money or writing to anyone outside the team.`,
      },
      model: { providerId: claude, modelId: ModelId.make("claude-sonnet-5-5") },
      permissionMode: extra.permissionMode ?? "supervised",
      primary: extra.primary ?? false,
      pinned: extra.pinned ?? false,
      hidden: extra.hidden ?? false,
      state,
      createdAt: ago(60 * 24 * 30),
    };
  }

  const bots = {
    scout: bot(
      ids.scout,
      "Scout",
      "Research",
      "hexagon",
      "teal",
      {
        _tag: "working",
        since: ago(3),
        stalled: false,
        activity: "Reading four pages about passkeys",
      },
      { primary: true, pinned: true, permissionMode: "auto-accept-edits" },
    ),
    juniper: bot(ids.juniper, "Juniper", "Inbox", "circle", "violet", {
      _tag: "waiting",
      entryId: EntryId.make("juniper-q1"),
    }),
    atlas: bot(ids.atlas, "Atlas", "Deploys", "square", "blue", {
      _tag: "waiting",
      entryId: EntryId.make("atlas-a1"),
    }),
    // Idle with a reply not yet read: the roster shows Wren as done.
    wren: bot(ids.wren, "Wren", "Writing", "leaf", "pink", { _tag: "idle" }),
    ledger: bot(ids.ledger, "Ledger", "Receipts", "diamond", "yellow", {
      _tag: "blocked",
      failure: "usage-limit",
      retryAt: ahead(95),
    }),
    otto: bot(ids.otto, "Otto", "Calendar", "arch", "green", { _tag: "idle" }),
    maple: bot(ids.maple, "Maple", "Groceries", "clover", "orange", {
      _tag: "working",
      since: ago(14),
      stalled: true,
      activity: "Comparing prices",
    }),
    iris: bot(ids.iris, "Iris", "Travel", "burst", "indigo", {
      _tag: "waiting",
      entryId: EntryId.make("iris-s1"),
    }),
    pip: bot(ids.pip, "Pip", "Home", "triangle", "red", { _tag: "idle" }, { hidden: true }),
    moss: bot(ids.moss, "Moss", "", "plus", "gray", { _tag: "idle" }),
  } satisfies Record<string, Bot>;

  const room: Room = {
    id: ids.launch,
    name: "Website launch",
    members: [ids.atlas, ids.wren, ids.scout],
    hostId: ids.atlas,
    hopLimit: 4,
    pinned: false,
    createdAt: ago(60 * 24 * 7),
  };

  const operator = { _tag: "operator" } as const;
  const by = (botId: BotId) => ({ _tag: "bot", botId }) as const;

  let counter = 0;
  const entryId = (prefix: string) => EntryId.make(`${prefix}-${++counter}`);

  const nobody: Mentions = { _tag: "bots", ids: [] };

  function message(
    author: Entry["author"],
    createdAt: DateTime.Utc,
    text: string,
    options: {
      attachments?: Attachment[];
      pending?: boolean;
      prefix?: string;
      mentions?: ReadonlyArray<BotId>;
    } = {},
  ): DraftEntry {
    return {
      _tag: "message",
      id: entryId(options.prefix ?? "m"),
      author,
      createdAt,
      text,
      attachments: options.attachments ?? [],
      mentions: options.mentions ? { _tag: "bots", ids: options.mentions } : nobody,
      delivery: { _tag: options.pending ? "pending" : "delivered" },
      commandId: null,
    };
  }

  const attachments = {
    report: {
      id: AttachmentId.make("passkeys-report"),
      name: "Passkeys rollout notes.pdf",
      mediaType: "application/pdf",
      size: 284_000,
    },
    sheet: {
      id: AttachmentId.make("vendors"),
      name: "Vendor comparison.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 41_200,
    },
    screenshot: {
      id: AttachmentId.make("checkout"),
      name: "checkout-staging.png",
      mediaType: "image/png",
      size: 1_830_000,
    },
  } satisfies Record<string, Attachment>;

  const foldId = EntryId.make("scout-fold");

  const scoutEntries: DraftEntry[] = [
    message(
      operator,
      ago(60 * 26),
      "Can you find out how other teams rolled out passkeys? Two or three examples is enough.",
    ),
    message(by(ids.scout), ago(60 * 26 - 1), "On it. I’ll look at public write-ups first."),
    {
      _tag: "work-fold",
      id: foldId,
      author: by(ids.scout),
      createdAt: ago(60 * 26 - 1),
      stepCount: 6,
      status: { _tag: "finished", finishedAt: ago(60 * 26 - 3), ending: "completed" },
    },
    message(
      by(ids.scout),
      ago(60 * 26 - 3),
      "Three teams wrote it up in detail. All kept passwords as a fallback for the first months, and all start with an opt-in prompt after sign-in.\n\nThe common pattern is a `navigator.credentials.create()` call right after a successful login. The clearest guide is https://example.com/passkeys/rollout.",
      { attachments: [attachments.report] },
    ),
    {
      _tag: "routine-change",
      id: entryId("rc"),
      author: by(ids.scout),
      createdAt: ago(60 * 25),
      routineId: RoutineId.make("morning-briefing"),
      name: "Morning briefing",
      change: "created",
      trigger: { _tag: "schedule", cron: "47 8 * * 1-5", timeZone: "America/Sao_Paulo" },
    },
    message(operator, ago(9), "Ask Wren to turn that into a short note for the team?"),
    {
      _tag: "handoff",
      id: entryId("h"),
      author: by(ids.scout),
      createdAt: ago(8),
      recipientId: ids.wren,
      text: "Could you turn the passkeys findings into a five-line note for the team? Plain words, no jargon.",
      urgent: false,
    },
    message(
      by(ids.scout),
      ago(8),
      "Done, Wren has it. Meanwhile I’m checking what our own sign-in page would need.",
    ),
    message(operator, ago(1), "Also look at how they handled account recovery", { pending: true }),
  ];

  const step = (index: number, rest: Omit<WorkStep, "id">): WorkStep => ({
    id: WorkStepId.make(`${foldId}-${index}`),
    ...rest,
  });
  const workSteps: Record<string, ReadonlyArray<WorkStep>> = {
    [foldId]: [
      step(0, {
        kind: "search",
        label: "passkeys rollout case study",
        status: "completed",
        startedAt: ago(60 * 26 - 1),
        finishedAt: ago(60 * 26 - 1),
      }),
      step(1, {
        kind: "web",
        label: "Read example.com/passkeys/rollout",
        status: "completed",
        startedAt: ago(60 * 26 - 1),
        finishedAt: ago(60 * 26 - 2),
      }),
      step(2, {
        kind: "web",
        label: "Read two more write-ups",
        status: "completed",
        startedAt: ago(60 * 26 - 2),
        finishedAt: ago(60 * 26 - 2),
      }),
      step(3, {
        kind: "command",
        label: "pandoc notes.md -o 'Passkeys rollout notes.pdf'",
        status: "completed",
        startedAt: ago(60 * 26 - 2),
        finishedAt: ago(60 * 26 - 3),
      }),
      step(4, {
        kind: "edit",
        label: "memory/log/2026-11.md",
        status: "completed",
        startedAt: ago(60 * 26 - 3),
        finishedAt: ago(60 * 26 - 3),
      }),
      step(5, {
        kind: "delegation",
        label: "Asked Wren to check the wording",
        status: "failed",
        startedAt: ago(60 * 26 - 3),
        finishedAt: ago(60 * 26 - 3),
      }),
    ],
  };

  const juniperEntries: DraftEntry[] = [
    message(
      by(ids.juniper),
      ago(70),
      "Morning sweep done: 23 new, 4 worth your time, the rest archived.",
    ),
    {
      _tag: "question",
      id: EntryId.make("juniper-q1"),
      author: by(ids.juniper),
      createdAt: ago(6),
      origin: "ask",
      questions: [
        {
          id: "reply",
          prompt:
            "The landlord wants to move Friday’s visit to Monday at 10. What should I tell them?",
          options: [
            {
              id: "yes",
              label: "Monday at 10 works",
              description: "Your calendar is clear then.",
              style: "recommended",
            },
            {
              id: "afternoon",
              label: "Ask for Monday afternoon",
              description: null,
              style: "default",
            },
            {
              id: "keep",
              label: "Keep Friday",
              description: "I’ll say the original time still suits you.",
              style: "default",
            },
          ],
          acceptsText: false,
          multiple: false,
        },
      ],
      status: { _tag: "pending" },
    },
  ];

  const atlasEntries: DraftEntry[] = [
    message(operator, ago(30), "Ship the checkout fix to staging when the tests pass."),
    message(by(ids.atlas), ago(12), "Tests pass. Ready to deploy to staging."),
    {
      _tag: "approval",
      id: EntryId.make("atlas-a1"),
      author: by(ids.atlas),
      createdAt: ago(12),
      kind: "command",
      action: "pnpm deploy --env staging --service checkout",
      detail:
        "pnpm deploy --env staging --service checkout\n  → builds apps/checkout\n  → uploads 14 files to the staging bucket\n  → restarts checkout-staging (about 30 s of downtime)",
      allowsSession: true,
      status: { _tag: "pending" },
    },
  ];

  const wrenEntries: DraftEntry[] = [
    message(
      by(ids.wren),
      ago(2),
      "Here’s the note for the team. Five lines, as asked:\n\nWe’re adding passkeys to sign-in. Passwords stay for now. After you sign in, you’ll be offered a passkey once. It takes ten seconds. Nothing else changes.",
    ),
  ];

  const ledgerEntries: DraftEntry[] = [
    message(operator, ago(40), "File last week’s receipts, please."),
    {
      _tag: "notice",
      id: entryId("n"),
      author: { _tag: "system" },
      createdAt: ago(38),
      notice: { _tag: "turn-failed", failure: "usage-limit" },
      retryable: true,
    },
  ];

  const irisEntries: DraftEntry[] = [
    message(operator, ago(20), "Find me fares to Lisbon for the second week of January."),
    {
      _tag: "secret-request",
      id: EntryId.make("iris-s1"),
      author: by(ids.iris),
      createdAt: ago(19),
      label: "Fare search API key",
      reason:
        "The fare search site only answers with an account key. I’ll use it for searches and nothing else.",
      url: "https://fares.example.com/account/keys",
      placeholder: "fs_live_…",
      status: "pending",
    },
  ];

  const ottoEntries: DraftEntry[] = [
    message(
      by(ids.otto),
      ago(60 * 5),
      "Tomorrow is clear until 11. I moved the dentist reminder to 9:30 like you asked.",
    ),
    message(operator, ago(60 * 5 - 2), "Thanks"),
  ];

  const roomEntries: DraftEntry[] = [
    message(operator, ago(50), "@Atlas where are we with the launch checklist?", {
      prefix: "r",
      mentions: [ids.atlas],
    }),
    message(
      by(ids.atlas),
      ago(49),
      "Checkout is clean on staging. Copy and the announcement are left. @Wren, can you take the announcement?",
      { prefix: "r", mentions: [ids.wren] },
    ),
    message(by(ids.wren), ago(47), "Drafting it now. @Scout, any numbers I can quote?", {
      prefix: "r",
      mentions: [ids.scout],
    }),
    message(
      by(ids.scout),
      ago(46),
      "Sign-in time dropped from 14 s to 4 s in the pilot. That’s the one worth quoting.",
      { prefix: "r" },
    ),
    message(by(ids.wren), ago(45), "Perfect, using that.", {
      prefix: "r",
      attachments: [attachments.screenshot],
    }),
    {
      _tag: "notice",
      id: entryId("rn"),
      author: { _tag: "system" },
      createdAt: ago(44),
      notice: { _tag: "chain-stopped", limit: "hops" },
      retryable: false,
    },
    {
      _tag: "notice",
      id: entryId("rn"),
      author: { _tag: "system" },
      createdAt: ago(12),
      notice: { _tag: "waiting-in-conversation", botId: ids.atlas },
      retryable: false,
    },
  ];

  const entries: Record<string, Entry[]> = {
    [`bot:${ids.scout}`]: ordered(scoutEntries),
    [`bot:${ids.juniper}`]: ordered(juniperEntries),
    [`bot:${ids.atlas}`]: ordered(atlasEntries),
    [`bot:${ids.wren}`]: ordered(wrenEntries),
    [`bot:${ids.ledger}`]: ordered(ledgerEntries),
    [`bot:${ids.iris}`]: ordered(irisEntries),
    [`bot:${ids.otto}`]: ordered(ottoEntries),
    [`room:${ids.launch}`]: ordered(roomEntries),
  };

  const lastOf = (key: string) => entries[key]?.at(-1) ?? null;

  function botItem(b: Bot, unread = false): RosterItem {
    const last = lastOf(`bot:${b.id}`);
    return {
      _tag: "bot",
      bot: b,
      lastEntry: last && previewOf(last),
      lastActivityAt: last?.createdAt ?? null,
      unread,
    };
  }

  const roomLast = lastOf(`room:${ids.launch}`);
  const roster: RosterItem[] = [
    botItem(bots.scout),
    botItem(bots.juniper),
    botItem(bots.atlas),
    botItem(bots.wren, true),
    botItem(bots.ledger),
    botItem(bots.otto),
    botItem(bots.maple),
    botItem(bots.iris),
    botItem(bots.pip),
    botItem(bots.moss),
    {
      _tag: "room",
      room,
      lastEntry: roomLast && previewOf(roomLast),
      lastActivityAt: roomLast?.createdAt ?? null,
      unread: true,
    },
  ];

  const run = (minutesAgo: number, status: NonNullable<Routine["lastRun"]>["status"]) => ({
    id: RoutineRunId.make(`run-${minutesAgo}`),
    startedAt: ago(minutesAgo),
    finishedAt: status === "running" ? null : ago(minutesAgo - 1),
    status,
    delivered: [],
    note: null,
  });

  const routines: Record<string, Routine[]> = {
    [ids.scout]: [
      {
        id: RoutineId.make("morning-briefing"),
        botId: ids.scout,
        name: "Morning briefing",
        instruction:
          "Tell me what changed in the repo since yesterday. Say nothing if nothing did.",
        trigger: { _tag: "schedule", cron: "47 8 * * 1-5", timeZone: "America/Sao_Paulo" },
        enabled: true,
        webhookUrl: null,
        // Run times match the schedules at SAMPLE_NOW, a Friday at 14:40 in São Paulo.
        nextRunAt: ahead(3 * 24 * 60 - 353),
        lastRun: run(353, "delivered"),
        runCount: 18,
      },
      {
        id: RoutineId.make("competitor-watch"),
        botId: ids.scout,
        name: "Competitor watch",
        instruction: "Check the three competitor changelogs. Report only new features.",
        trigger: { _tag: "schedule", cron: "0 17 * * 1,4", timeZone: "America/Sao_Paulo" },
        enabled: true,
        webhookUrl: null,
        nextRunAt: ahead(3 * 24 * 60 + 140),
        lastRun: run(21 * 60 + 40, "silent"),
        runCount: 9,
      },
      {
        id: RoutineId.make("weekly-report"),
        botId: ids.scout,
        name: "Weekly team update",
        instruction: "Summarize the week for the team channel.",
        trigger: { _tag: "schedule", cron: "30 16 * * 5", timeZone: "America/Sao_Paulo" },
        enabled: false,
        webhookUrl: null,
        nextRunAt: null,
        lastRun: run(7 * 24 * 60 - 110, "failed"),
        runCount: 4,
      },
    ],
    [ids.atlas]: [
      {
        id: RoutineId.make("deploy-finished"),
        botId: ids.atlas,
        name: "Deploy finished",
        instruction: "When a deploy finishes, tell me if anything looks off.",
        trigger: { _tag: "webhook" },
        enabled: true,
        webhookUrl: "https://j3.local/hooks/deploy-finished",
        nextRunAt: null,
        lastRun: run(60 * 3, "delivered"),
        runCount: 52,
      },
    ],
  };

  const memoryFile = (path: string, size: number, minutesAgo: number): MemoryFile => ({
    path: MemoryPath.make(path),
    size,
    updatedAt: ago(minutesAgo),
  });

  const memory: Record<string, MemoryFile[]> = {
    [ids.scout]: [
      memoryFile("profile.md", 1_840, 60 * 26),
      memoryFile("log/2026-11.md", 12_400, 60 * 26 - 3),
      memoryFile("log/2026-10.md", 30_100, 60 * 24 * 21),
    ],
  };

  // What each bot delivered, newest first, as `bot.files` lists it.
  const files: Record<string, BotFile[]> = Object.fromEntries(
    Object.values(bots).map((b) => [
      b.id,
      Object.values(entries)
        .flat()
        .flatMap((entry) =>
          entry._tag === "message" && entry.author._tag === "bot" && entry.author.botId === b.id
            ? entry.attachments.map((attachment) => ({
                attachment,
                entryId: entry.id,
                createdAt: entry.createdAt,
              }))
            : [],
        )
        .sort((x, y) => DateTime.toEpochMillis(y.createdAt) - DateTime.toEpochMillis(x.createdAt)),
    ]),
  );

  return {
    engine,
    bots,
    room,
    attachments,
    entries,
    workSteps,
    roster,
    routines,
    files,
    memory,
  };
}

export type SampleTeam = ReturnType<typeof sampleTeam>;
