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
  newsletter: RoomId.make("spring-newsletter"),
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
        status: {
          _tag: "sign-in-required",
          command: "CODEX_HOME=~/.j3-bots/providers/codex codex login",
        },
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
        activity: "Checking which of the three the shop has in stock",
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
    id: ids.newsletter,
    name: "Spring newsletter",
    status: "active",
    members: [ids.juniper, ids.wren, ids.scout],
    hostId: ids.juniper,
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
      id: AttachmentId.make("ebike-shortlist"),
      name: "E-bike shortlist.pdf",
      mediaType: "application/pdf",
      size: 212_000,
    },
    photo: {
      id: AttachmentId.make("workshop-photo"),
      name: "march-workshop.jpg",
      mediaType: "image/jpeg",
      size: 2_410_000,
    },
  } satisfies Record<string, Attachment>;

  const foldId = EntryId.make("scout-fold");

  const scoutEntries: DraftEntry[] = [
    message(
      operator,
      ago(60 * 26),
      "Which e-bikes would suit a 12 km commute with one steep hill? Three options is plenty.",
    ),
    message(by(ids.scout), ago(60 * 26 - 1), "On it. I’ll start with long-term owner reviews."),
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
      "Three fit. All of them have a mid-drive motor, which is what makes the difference on that hill, and the cheapest needs the larger battery for the round trip.\n\nThe range figures come from owners, not spec sheets: see the `range_km` column. The most useful review is https://example.com/ebikes/long-term.",
      { attachments: [attachments.report] },
    ),
    {
      _tag: "routine-change",
      id: entryId("rc"),
      author: by(ids.scout),
      createdAt: ago(60 * 25),
      routineId: RoutineId.make("price-drop-watch"),
      name: "Price drop watch",
      change: "created",
      trigger: { _tag: "schedule", cron: "47 8 * * 1-5", timeZone: "America/Sao_Paulo" },
    },
    message(operator, ago(9), "Can Wren write to the bike shop about a test ride?"),
    {
      _tag: "handoff",
      id: entryId("h"),
      author: by(ids.scout),
      createdAt: ago(8),
      recipientId: ids.wren,
      text: "Could you write to the bike shop and ask for a test ride on Saturday morning? Friendly, three lines at most.",
      urgent: false,
    },
    message(
      by(ids.scout),
      ago(8),
      "Done, Wren has it. Meanwhile I’m checking which of the three the shop has in stock.",
    ),
    message(operator, ago(1), "Also check whether any of them fold", { pending: true }),
    message(operator, ago(1), "And which ones take a child seat", { pending: true }),
  ];

  const step = (index: number, rest: Omit<WorkStep, "id">): WorkStep => ({
    id: WorkStepId.make(`${foldId}-${index}`),
    ...rest,
  });
  const workSteps: Record<string, ReadonlyArray<WorkStep>> = {
    [foldId]: [
      step(0, {
        kind: "search",
        label: "e-bike long-term review steep hill commute",
        status: "completed",
        startedAt: ago(60 * 26 - 1),
        finishedAt: ago(60 * 26 - 1),
      }),
      step(1, {
        kind: "web",
        label: "Read example.com/ebikes/long-term",
        status: "completed",
        startedAt: ago(60 * 26 - 1),
        finishedAt: ago(60 * 26 - 2),
      }),
      step(2, {
        kind: "web",
        label: "Read three owner forums",
        status: "completed",
        startedAt: ago(60 * 26 - 2),
        finishedAt: ago(60 * 26 - 2),
      }),
      step(3, {
        kind: "command",
        label:
          "python3 compare.py --specs specs.csv --reviews owner-reviews.csv --sort range_km --out 'E-bike shortlist.pdf'",
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
        label: "Asked Juniper whether the shop had replied",
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
      "Went through the inbox: 31 new, 3 need you, the rest filed.",
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
          prompt: "The plumber can come on Thursday at 8 instead of next week. Should I confirm?",
          options: [
            {
              id: "yes",
              label: "Confirm Thursday at 8",
              description: "Nothing else is on your calendar before 10.",
              style: "recommended",
            },
            {
              id: "later",
              label: "Ask for later that day",
              description: null,
              style: "default",
            },
            {
              id: "keep",
              label: "Keep next week",
              description: "I’ll tell them the original slot still suits you.",
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
    message(operator, ago(30), "Run the invoice migration on staging once the backup finishes."),
    message(
      by(ids.atlas),
      ago(12),
      "Backup finished and checked: 2.1 GB. Ready to migrate staging.",
    ),
    {
      _tag: "approval",
      id: EntryId.make("atlas-a1"),
      author: by(ids.atlas),
      createdAt: ago(12),
      kind: "command",
      action: "pnpm db:migrate --env staging --to 0042_invoice_totals",
      detail:
        "→ adds the column invoices.total_cents\n→ fills it for 18,204 invoices, 500 at a time\n→ keeps the billing API read-only for about 40 s\n→ writes the migration log to logs/migrate-0042.txt",
      allowsSession: true,
      status: { _tag: "pending" },
    },
  ];

  const wrenEntries: DraftEntry[] = [
    message(
      by(ids.wren),
      ago(2),
      "Here’s the note for the bike shop, three lines as asked:\n\nHi, I’m comparing three e-bikes for a hilly commute and would love to try them. Could I come by on Saturday morning for a test ride? Any time before noon works.",
    ),
  ];

  const ledgerEntries: DraftEntry[] = [
    message(operator, ago(40), "Sort last month’s receipts into the tax folder, please."),
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
    message(
      operator,
      ago(20),
      "Find me trains from Porto to Madrid for the first weekend of February.",
    ),
    {
      _tag: "secret-request",
      id: EntryId.make("iris-s1"),
      author: by(ids.iris),
      createdAt: ago(19),
      label: "Rail search API key",
      reason:
        "The rail search service only answers with an account key. I’ll use it for timetable and fare searches and nothing else.",
      url: "https://rail.example.com/account/keys",
      placeholder: "rs_live_…",
      status: "pending",
    },
  ];

  const ottoEntries: DraftEntry[] = [
    message(
      by(ids.otto),
      ago(60 * 5),
      "Thursday is clear after 10. I moved the car inspection to 3:30 like you asked.",
    ),
    message(operator, ago(60 * 5 - 2), "Thanks"),
  ];

  const roomEntries: DraftEntry[] = [
    message(operator, ago(50), "@Juniper what’s still missing for the newsletter?", {
      prefix: "r",
      mentions: [ids.juniper],
    }),
    message(
      by(ids.juniper),
      ago(49),
      "The subscriber numbers and the opening paragraph. @Scout, can you pull this quarter’s sign-ups?",
      { prefix: "r", mentions: [ids.scout] },
    ),
    message(
      by(ids.scout),
      ago(47),
      "1,284 new subscribers this quarter, up from 910. Most came through the March workshop.",
      { prefix: "r" },
    ),
    message(
      by(ids.wren),
      ago(46),
      "Then I’ll open with the workshop. @Scout, is there a photo from it we can use?",
      { prefix: "r", mentions: [ids.scout] },
    ),
    message(by(ids.scout), ago(45), "This one. Everyone in it agreed to be in the newsletter.", {
      prefix: "r",
      attachments: [attachments.photo],
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
      createdAt: ago(6),
      notice: { _tag: "waiting-in-conversation", botId: ids.juniper },
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
    [`room:${ids.newsletter}`]: ordered(roomEntries),
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

  const roomLast = lastOf(`room:${ids.newsletter}`);
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

  // Run times match the schedules at SAMPLE_NOW: a Friday, 14:40 in São Paulo and 17:40 in Lisbon.
  const routines: Record<string, Routine[]> = {
    [ids.scout]: [
      {
        id: RoutineId.make("price-drop-watch"),
        botId: ids.scout,
        name: "Price drop watch",
        instruction:
          "Check the three e-bikes on the shortlist for price drops. Say nothing if none dropped.",
        trigger: { _tag: "schedule", cron: "47 8 * * 1-5", timeZone: "America/Sao_Paulo" },
        enabled: true,
        webhookUrl: null,
        nextRunAt: ahead(3 * 24 * 60 - 353),
        lastRun: run(353, "delivered"),
        runCount: 18,
      },
      {
        id: RoutineId.make("lisbon-sync-prep"),
        botId: ids.scout,
        name: "Lisbon sync prep",
        instruction: "Before each sync with the Lisbon team, list what I still owe them.",
        // Saved in the Lisbon team's zone, so it follows their clock through daylight saving.
        trigger: { _tag: "schedule", cron: "0 9 * * 1,4", timeZone: "Europe/Lisbon" },
        enabled: true,
        webhookUrl: null,
        nextRunAt: ahead(2 * 24 * 60 + 920),
        lastRun: run(24 * 60 + 520, "silent"),
        runCount: 9,
      },
      {
        id: RoutineId.make("weekend-reading"),
        botId: ids.scout,
        name: "Weekend reading",
        instruction: "Pick three long reads from my saved links for the weekend.",
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
        id: RoutineId.make("migration-finished"),
        botId: ids.atlas,
        name: "Migration finished",
        instruction:
          "When a migration finishes, tell me how many rows it touched and anything that looks off.",
        trigger: { _tag: "webhook" },
        enabled: true,
        webhookUrl: "https://j3.local/hooks/migration-finished",
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
