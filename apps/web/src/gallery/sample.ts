// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A sample team for development and the gallery: every bot state, every kind of
 * entry, typed from the contracts. Development only; builds do not include it.
 */
import type { RecentTurns } from "@j3-bots/client-runtime";
import {
  AttachmentId,
  BotId,
  BrowserTabRef,
  ConnectorGlyph,
  ConnectorId,
  DeviceId,
  EffortLevel,
  EntryId,
  MemoryPath,
  pairBotIds,
  PairSeq,
  ModelId,
  ProviderId,
  RoomId,
  RoutineId,
  RoutineRunId,
  SectionId,
  SiteOrigin,
  TimeZone,
  WorkStepId,
  type Attachment,
  type Bot,
  type BotFile,
  type BotState,
  type Device,
  type EngineStatus,
  type Entry,
  type MemoryFile,
  type Mentions,
  type MessageDelivery,
  type Room,
  type RosterItem,
  type Routine,
  type Section,
  type Settings,
  type TeammateMessage,
  type TeammatePair,
  type UsageRoutine,
  type UsageTurn,
  type Visual,
  type WorkStep,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { ordered, previewOf, type DraftEntry } from "./entries";
import { sampleConnectorAppRef } from "./sampleConnectorApps";
import { sampleVisuals } from "./visuals";

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

/** The engine's English names for the levels of effort, as it reports them. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** A model's levels of effort, as the engine reports them. */
export const sampleEfforts = (...ids: ReadonlyArray<string>) =>
  ids.map((id) => ({ id: EffortLevel.make(id), name: EFFORT_NAMES[id] ?? id }));

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
          {
            id: ModelId.make("claude-opus-5-5"),
            name: "Claude Opus 5.5",
            efforts: sampleEfforts("low", "medium", "high", "xhigh", "max"),
          },
          {
            id: ModelId.make("claude-sonnet-5-5"),
            name: "Claude Sonnet 5.5",
            efforts: sampleEfforts("low", "medium", "high"),
          },
        ],
        // As the engine labels Claude Code's windows: "Session" is its five-hour one.
        usage: [
          { label: "Session", usedPercent: 38, resetsAt: ahead(140) },
          { label: "Weekly", usedPercent: 81, resetsAt: ahead(3 * 24 * 60 + 200) },
          {
            label: "Weekly · Claude Opus 5.5",
            usedPercent: 64,
            resetsAt: ahead(3 * 24 * 60 + 200),
          },
        ],
      },
      {
        id: codex,
        name: "Codex",
        harness: "codex",
        status: { _tag: "sign-in-required", command: "j3-bots provider connect" },
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
    extra: Partial<
      Pick<Bot, "pinned" | "hidden" | "primary" | "permissionMode" | "sectionId">
    > = {},
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
      effort: null,
      permissionMode: extra.permissionMode ?? "supervised",
      browser: false,
      primary: extra.primary ?? false,
      pinned: extra.pinned ?? false,
      hidden: extra.hidden ?? false,
      sectionId: extra.sectionId ?? null,
      state,
      settingsHeld: false,
      forceStop: false,
      opening: false,
      suggestedReply: null,
      createdAt: ago(60 * 24 * 30),
    };
  }

  // One section with bots in it, and one the operator made and has not filled yet.
  const sections: ReadonlyArray<Section> = [
    { id: SectionId.make("section-home"), name: "Home" },
    { id: SectionId.make("section-later"), name: "Later" },
  ];
  const home = { sectionId: SectionId.make("section-home") };

  const bots = {
    scout: bot(
      ids.scout,
      "Scout",
      "Research",
      "dome",
      "tangerine",
      {
        _tag: "working",
        since: ago(9),
        stalled: false,
        typing: false,
        retrying: false,
        activity: "Checking which of the three the shop has in stock",
        activityKind: "tool",
        tool: "browser",
        littleOnes: 0,
      },
      { primary: true, pinned: true, permissionMode: "auto-accept-edits" },
    ),
    juniper: bot(ids.juniper, "Juniper", "Inbox", "ears", "cobalt", {
      _tag: "waiting",
      entryId: EntryId.make("juniper-q1"),
      // An ask card, answered between turns.
      since: null,
    }),
    atlas: bot(ids.atlas, "Atlas", "Deploys", "drop", "mint", {
      _tag: "waiting",
      entryId: EntryId.make("atlas-a1"),
      // An approval, which holds its turn.
      since: ago(4),
    }),
    // Idle with a reply not yet read: the roster shows Wren as done.
    wren: bot(ids.wren, "Wren", "Writing", "horns", "orchid", { _tag: "idle" }, { pinned: true }),
    ledger: bot(ids.ledger, "Ledger", "Receipts", "ghost", "honey", {
      _tag: "blocked",
      failure: "usage-limit",
      retryAt: ahead(95),
    }),
    otto: bot(ids.otto, "Otto", "Calendar", "block", "iris", { _tag: "idle" }, home),
    maple: bot(
      ids.maple,
      "Maple",
      "Groceries",
      "toes",
      "tomato",
      {
        _tag: "working",
        since: ago(14),
        stalled: true,
        typing: false,
        retrying: false,
        activity: "Comparing prices",
        activityKind: "web",
        tool: null,
        littleOnes: 0,
      },
      home,
    ),
    iris: bot(ids.iris, "Iris", "Travel", "bean", "sky", {
      _tag: "waiting",
      entryId: EntryId.make("iris-s1"),
      since: ago(3),
    }),
    pip: bot(ids.pip, "Pip", "Home", "pear", "lime", { _tag: "idle" }, { hidden: true }),
    moss: bot(ids.moss, "Moss", "", "hex", "rose", { _tag: "idle" }),
  } satisfies Record<string, Bot>;

  // Active, so it can stand wherever a room someone can write in is wanted.
  const room: Extract<Room, { readonly status: "active" }> = {
    id: ids.newsletter,
    name: "Spring newsletter",
    status: "active",
    // More than the header draws, so it counts the rest.
    members: [ids.juniper, ids.wren, ids.scout, ids.atlas, ids.otto],
    pinned: false,
    hidden: false,
    createdAt: ago(60 * 24 * 7),
    // Juniper and Scout are answering in it, in member order.
    work: "running",
    forceStop: false,
    answering: [ids.juniper, ids.scout],
    memberWork: [],
  };

  const operator = { _tag: "operator" } as const;
  const by = (botId: BotId) => ({ _tag: "bot", botId }) as const;

  let counter = 0;
  const entryId = (prefix: string) => EntryId.make(`${prefix}-${++counter}`);
  // The teammate cards in Scout's conversation, which its teammate conversations name.
  const cards = {
    scoutToWren: EntryId.make("handoff-scout-wren"),
    atlasToScout: EntryId.make("handoff-atlas-scout"),
  };

  const nobody: Mentions = { _tag: "bots", ids: [] };

  function message(
    author: Entry["author"],
    createdAt: DateTime.Utc,
    text: string,
    options: {
      attachments?: Attachment[];
      delivery?: MessageDelivery;
      prefix?: string;
      mentions?: ReadonlyArray<BotId>;
      visual?: Visual;
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
      delivery: options.delivery ?? { _tag: "delivered" },
      commandId: null,
      ...(options.visual === undefined ? {} : { visual: options.visual }),
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
  const liveFoldId = EntryId.make("scout-live-fold");

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
      turnStartedAt: ago(60 * 26),
      stepCount: 5,
      apps: [],
      work: null,
      status: {
        _tag: "finished",
        finishedAt: ago(60 * 26 - 3),
        ending: "completed",
      },
    },
    message(
      by(ids.scout),
      ago(60 * 26 - 3),
      "Three fit. All of them have a mid-drive motor, which is what makes the difference on that hill, and the cheapest needs the larger battery for the round trip.\n\nThe range figures come from owners, not spec sheets: see the `range_km` column. The most useful review is https://example.com/ebikes/long-term.",
      { attachments: [attachments.report], visual: sampleVisuals.table },
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
      id: cards.scoutToWren,
      author: by(ids.scout),
      createdAt: ago(8),
      recipientId: ids.wren,
      direction: "sent",
      text: "Could you write to the bike shop and ask for a test ride on Saturday morning? Friendly, three lines at most.",
      urgent: false,
      state: "sent",
    },
    // Atlas writes back at once: with Scout's own message, one line with two teammates.
    {
      _tag: "handoff",
      id: cards.atlasToScout,
      author: by(ids.atlas),
      createdAt: ago(8),
      recipientId: ids.scout,
      direction: "received",
      text: "The bike page is on staging if you want to check the prices there first.",
      urgent: false,
      state: "sent",
    },
    message(
      by(ids.scout),
      ago(8),
      "Done, Wren has it. Meanwhile I’m checking which of the three the shop has in stock.",
    ),
    // The work Scout's turn does after saying so: its turn is still under way.
    {
      _tag: "work-fold",
      id: liveFoldId,
      author: by(ids.scout),
      createdAt: ago(7),
      turnStartedAt: ago(9),
      stepCount: 2,
      apps: [sampleConnectorAppRef],
      work: null,
      status: { _tag: "running" },
    },
    message(operator, ago(1), "Also check whether any of them fold", {
      delivery: { _tag: "pending" },
    }),
    message(operator, ago(1), "And which ones take a child seat", {
      delivery: { _tag: "pending" },
    }),
  ];

  const step = (index: number, rest: Omit<WorkStep, "id">): WorkStep => ({
    id: WorkStepId.make(`${foldId}-${index}`),
    ...rest,
  });
  const workSteps: Record<string, ReadonlyArray<WorkStep>> = {
    [liveFoldId]: [
      {
        id: WorkStepId.make(`${liveFoldId}-0`),
        kind: "web",
        tool: null,
        label: "Read the bike shop’s stock page",
        status: "completed",
        startedAt: ago(7),
        finishedAt: ago(6),
      },
      {
        id: WorkStepId.make(`${liveFoldId}-1`),
        kind: "other",
        tool: null,
        label: "Checking which of the three the shop has in stock",
        status: "running",
        startedAt: ago(6),
        finishedAt: null,
      },
    ],
    [foldId]: [
      step(0, {
        kind: "search",
        tool: null,
        label: "e-bike long-term review steep hill commute",
        status: "completed",
        startedAt: ago(60 * 26 - 1),
        finishedAt: ago(60 * 26 - 1),
      }),
      step(1, {
        kind: "web",
        tool: null,
        label: "Read example.com/ebikes/long-term",
        status: "completed",
        startedAt: ago(60 * 26 - 1),
        finishedAt: ago(60 * 26 - 2),
      }),
      step(2, {
        kind: "web",
        tool: null,
        label: "Read three owner forums",
        status: "completed",
        startedAt: ago(60 * 26 - 2),
        finishedAt: ago(60 * 26 - 2),
      }),
      step(3, {
        kind: "command",
        tool: null,
        label:
          "python3 compare.py --specs specs.csv --reviews owner-reviews.csv --sort range_km --out 'E-bike shortlist.pdf'",
        status: "completed",
        startedAt: ago(60 * 26 - 2),
        finishedAt: ago(60 * 26 - 3),
      }),
      step(4, {
        kind: "edit",
        tool: null,
        label: "memory/log/2026-11.md",
        status: "completed",
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

  const atlasAuth: DraftEntry = {
    _tag: "connector-auth",
    id: EntryId.make("atlas-c1"),
    author: by(ids.atlas),
    createdAt: ago(8),
    connectorId: ConnectorId.make("conn_samplelinear00000"),
    name: "Linear",
    glyph: ConnectorGlyph.make("board"),
    status: "pending",
  };

  const atlasEntries: DraftEntry[] = [
    message(operator, ago(30), "Run the invoice migration on staging once the backup finishes."),
    message(
      by(ids.atlas),
      ago(12),
      "Backup finished and checked: 2.1 GB. Ready to migrate staging.",
      { visual: sampleVisuals.diagram },
    ),
    {
      _tag: "approval",
      id: EntryId.make("atlas-a1"),
      author: by(ids.atlas),
      createdAt: ago(12),
      kind: "command",
      action: "pnpm db:migrate --env staging \\\n  --to 0042_invoice_totals \\\n  --batch-size 500",
      detail: null,
      reason: "Needs network access to reach the staging database, which the sandbox blocks.",
      exact: true,
      sessionGrant: { covers: "every-command" },
      status: { _tag: "pending" },
    },
    atlasAuth,
  ];

  const wrenEntries: DraftEntry[] = [
    message(
      by(ids.wren),
      ago(2),
      "Here’s the note for the bike shop, three lines as asked:\n\nHi, I’m comparing three e-bikes for a hilly commute and would love to try them. Could I come by on Saturday morning for a test ride? Any time before noon works.",
    ),
    message(operator, ago(2), "Looks good, send it from my address", {
      delivery: { _tag: "failed", reason: "rejected" },
    }),
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
      fields: [],
      delivery: "reference",
      status: "pending",
    },
  ];

  const ottoEntries: DraftEntry[] = [
    {
      _tag: "browser-help",
      id: EntryId.make("otto-b1"),
      author: by(ids.otto),
      createdAt: ago(60 * 5 + 6),
      reason: "login",
      note: "Sign in to the garage’s booking page, so I can move the car inspection.",
      site: "booking.example.com",
      tab: BrowserTabRef.make("otto-tab"),
      status: { _tag: "done" },
    },
    message(
      by(ids.otto),
      ago(60 * 5),
      "Thursday is clear after 10. I moved the car inspection to 3:30 like you asked.",
    ),
    message(operator, ago(60 * 5 - 2), "Thanks"),
    {
      _tag: "secret-ask",
      id: EntryId.make("otto-l1"),
      author: by(ids.otto),
      createdAt: ago(60 * 5 - 3),
      name: "inspections",
      secret: { _tag: "login", origin: SiteOrigin.make("https://inspections.example") },
      note: "The inspection site wants a login to change the booking. Save it, and next time I can check it there.",
      status: { _tag: "pending" },
    },
    message(operator, ago(12), "Can you block two hours for the tax paperwork next week?"),
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
      notice: { _tag: "chain-stopped", limit: "room" },
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
    attempts: 1,
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
      {
        id: RoutineId.make("nightly-backup-check"),
        botId: ids.atlas,
        name: "Nightly backup check",
        instruction: "Check that last night's database backup finished and is restorable.",
        trigger: { _tag: "schedule", cron: "0 2 * * *", timeZone: "America/Sao_Paulo" },
        enabled: true,
        webhookUrl: null,
        // Today's 02:00 run came due while J3 Bots wasn't running, and it came
        // back after 14:00, nearer to tomorrow's run than to that one.
        nextRunAt: ahead(24 * 60 - 760),
        lastRun: run(24 * 60 + 760, "silent"),
        runCount: 30,
        missed: { count: 1, since: ago(760), until: ago(760) },
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

  // The day's turns, newest first: Scout's research and its routine, Atlas's
  // webhook runs, one run of a routine deleted since, and Juniper on Codex
  // before it was signed out.
  const priceWatch: UsageRoutine = {
    _tag: "routine",
    id: RoutineId.make("price-drop-watch"),
    name: "Price drop watch",
  };
  const migrations: UsageRoutine = {
    _tag: "routine",
    id: RoutineId.make("migration-finished"),
    name: "Migration finished",
  };
  const spent = (
    minutesAgo: number,
    botId: BotId,
    routine: UsageRoutine | null = null,
    providerId = claude,
  ): UsageTurn => ({
    botId,
    routine,
    providerId,
    startedAt: ago(minutesAgo),
    finishedAt: minutesAgo < 4 ? null : ago(minutesAgo - 2),
  });
  const recentTurns: RecentTurns = {
    turns: [
      spent(3, ids.scout),
      spent(12, ids.scout),
      spent(28, ids.atlas),
      spent(41, ids.scout),
      spent(66, ids.ledger),
      spent(95, ids.scout),
      spent(180, ids.atlas, migrations),
      spent(240, ids.atlas, migrations),
      spent(353, ids.scout, priceWatch),
      spent(410, ids.scout),
      spent(530, ids.atlas, { _tag: "deleted" }),
      spent(610, ids.juniper, null, codex),
      spent(640, ids.juniper, null, codex),
      spent(720, ids.atlas, migrations),
      spent(1_300, ids.scout, priceWatch),
    ],
    readAt: now,
    hasMore: false,
    canLoadMore: false,
  };

  const settings: Settings = {
    operatorName: "Sam",
    timeZone: TimeZone.make("America/Sao_Paulo"),
    budgets: { hops: 6, fanOut: 3, concurrentTurns: 4 },
    notifications: { enabled: true, previews: true },
    updateChannel: "stable",
    autoUpdateHarnesses: true,
    suggestReplies: true,
  };

  const devices: ReadonlyArray<Device> = [
    {
      id: DeviceId.make("laptop"),
      name: "Firefox on Linux",
      pairedAt: ago(60 * 24 * 30),
      lastSeenAt: now,
      current: true,
      pushRegistered: false,
    },
    {
      id: DeviceId.make("phone"),
      name: "Safari on iPhone",
      pairedAt: ago(60 * 24 * 12),
      lastSeenAt: ago(95),
      current: false,
      pushRegistered: true,
    },
  ];

  // What bots wrote each other, as their teammate conversations list it.
  let seq = 0;
  const said = (
    from: BotId,
    to: BotId,
    minutesAgo: number,
    text: string,
    more: Partial<
      Pick<TeammateMessage, "urgent" | "state" | "sentEntryId" | "receivedEntryId">
    > = {},
  ): TeammateMessage => ({
    seq: PairSeq.make(++seq),
    from,
    to,
    sentEntryId: null,
    receivedEntryId: null,
    urgent: false,
    state: "sent",
    createdAt: ago(minutesAgo),
    text,
    ...more,
  });
  const pairMessages: ReadonlyArray<ReadonlyArray<TeammateMessage>> = [
    [
      said(
        ids.juniper,
        ids.wren,
        60 * 50,
        "The newsletter goes out Friday. Could you take the opening paragraph? Warm, four lines, and mention the plant swap.",
      ),
      said(
        ids.wren,
        ids.juniper,
        60 * 50 - 6,
        "On it. I’ll keep the plant swap in the first line so it survives the preview.",
      ),
      said(
        ids.juniper,
        ids.wren,
        60 * 26,
        "The printer needs the final text by noon. Is the opening ready?",
        { urgent: true, state: "not-delivered" },
      ),
    ],
    [
      said(
        ids.scout,
        ids.wren,
        60 * 24 * 3,
        "Can you turn my notes on the three bikes into two friendly sentences for the family chat?",
      ),
      said(
        ids.wren,
        ids.scout,
        60 * 24 * 3 - 4,
        "Done: “Three bikes made the cut, all good on the hill. The cheapest needs the bigger battery, so it ends up the same price as the middle one.”",
      ),
      said(
        ids.scout,
        ids.wren,
        8,
        "Could you write to the bike shop and ask for a test ride on Saturday morning? Friendly, three lines at most.",
        { sentEntryId: cards.scoutToWren },
      ),
    ],
    [
      said(
        ids.atlas,
        ids.scout,
        8,
        "The bike page is on staging if you want to check the prices there first.",
        { receivedEntryId: cards.atlasToScout },
      ),
    ],
    // Pip is hidden: the roster leaves this one out, and Wren's details still list it.
    [
      said(
        ids.pip,
        ids.wren,
        60 * 24 * 6,
        "The plants on the balcony need water while you’re away.",
      ),
    ],
  ];
  const pairs: ReadonlyArray<TeammatePair> = pairMessages
    .flatMap((messages): ReadonlyArray<TeammatePair> => {
      const last = messages.at(-1);
      return last === undefined
        ? []
        : [{ botIds: pairBotIds(last.from, last.to), lastMessage: last, count: messages.length }];
    })
    .toSorted((a, b) => b.lastMessage.seq - a.lastMessage.seq);

  return {
    engine,
    bots,
    pairs,
    pairMessages,
    room,
    attachments,
    entries,
    workSteps,
    roster,
    sections,
    routines,
    files,
    memory,
    settings,
    devices,
    recentTurns,
  };
}

export type SampleTeam = ReturnType<typeof sampleTeam>;
