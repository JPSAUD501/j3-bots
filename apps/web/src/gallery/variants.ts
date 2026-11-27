// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One entry per state the gallery shows beside the sample conversations: every
 * card status, fold ending and notice. Development only.
 */
import type { OutgoingMessage } from "@j3-bots/client-runtime";
import { type EventLine, placeOf } from "@j3-bots/client-runtime/presentation";
import {
  AttachmentId,
  BrowserTabRef,
  CommandId,
  DeviceId,
  ConnectorGlyph,
  ConnectorId,
  EntryId,
  EntryOrder,
  Label,
  RoutineId,
  SecretId,
  SecretName,
  secretRequestFieldId,
  SetupPageUrl,
  SiteOrigin,
  SkillName,
  WorkStepId,
  type ApprovalEntry,
  type Author,
  BotId,
  type BrowserHelpEntry,
  type CredentialFill,
  type ConnectorAskEntry,
  type EventRoutineChangeEntry,
  type ConnectorAuthEntry,
  type ConnectorInputEntry,
  CuratedKey,
  type HandoffEntry,
  type MessageEntry,
  type MessageQuote,
  type NoticeEntry,
  type QuestionEntry,
  type QuestionOption,
  type Reaction,
  ReactionEmoji,
  type RoutineChangeEntry,
  type Secret,
  type SecretAskEntry,
  type SecretRequestEntry,
  type WorkFoldEntry,
  type WorkStep,
} from "@j3-bots/contracts";
import * as DateTime from "effect/DateTime";
import { ids } from "./sample";
import type { SampleValues } from "./sampleSecrets";
import { sampleVisuals } from "./visuals";
import { GALLERY_PHOTO, GALLERY_WORK_IMAGES } from "./workImages";

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

  const message = (
    name: string,
    author: Author,
    text: string,
    extra: Partial<
      Pick<
        MessageEntry,
        "attachments" | "delivery" | "visual" | "lookingAt" | "reactions" | "quotes" | "offer"
      >
    > = {},
  ): MessageEntry => ({
    _tag: "message",
    ...base(name, author),
    text,
    attachments: extra.attachments ?? [],
    mentions: { _tag: "bots", ids: [] },
    delivery: extra.delivery ?? { _tag: "delivered" },
    commandId: null,
    ...(extra.visual === undefined ? {} : { visual: extra.visual }),
    ...(extra.lookingAt === undefined ? {} : { lookingAt: extra.lookingAt }),
    ...(extra.reactions === undefined ? {} : { reactions: extra.reactions }),
    ...(extra.quotes === undefined ? {} : { quotes: extra.quotes }),
    ...(extra.offer === undefined ? {} : { offer: extra.offer }),
  });

  /** A message still on this device, on its way or refused. */
  const outgoing = (
    name: string,
    text: string,
    status: OutgoingMessage["status"],
  ): OutgoingMessage => ({
    _tag: "outgoing",
    commandId: CommandId.make(`variant-${name}`),
    target: { _tag: "conversation", botId: ids.scout },
    text,
    attachments: [],
    mentions: null,
    labels: [],
    createdAt: ago(1),
    status,
  });

  const bubbles = {
    operator: message(
      "op",
      { _tag: "operator" },
      "Can you check whether the invoice from March was paid?",
    ),
    // Sent from quick access, over the window it names.
    lookingAt: message("looking-at", { _tag: "operator" }, "Is this the one we were waiting for?", {
      lookingAt: { app: "Example Browser", title: "Invoice 2026-031 · Paid" },
    }),
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
    sending: outgoing("sending", "And September", { _tag: "sending" }),
    notSent: outgoing("not-sent", "And October", {
      _tag: "not-sent",
      failure: { _tag: "unexpected" },
    }),
    unrecorded: outgoing("unrecorded", "And November", { _tag: "unrecorded" }),
    // A reply its turn ends on while three of its little ones still work.
    handOff: message(
      "hand-off",
      scout,
      "I’ve split into three to go through the vendors. I’ll put it all in one comparison.",
    ),
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
    withPhoto: message("photo", scout, "Here is the chart you asked for.", {
      attachments: [
        {
          id: GALLERY_PHOTO,
          name: "spending-by-month.png",
          mediaType: "image/png",
          size: 48_200,
        },
      ],
    }),
  };

  /** A bot's visuals, above its words. */
  const visualBubbles = [
    message(
      "visual-chart",
      scout,
      "March was the peak: the bike repair and the conference trip landed in the same month.",
      {
        visual: sampleVisuals.chart,
      },
    ),
    message(
      "visual-table",
      scout,
      "The Torra goes furthest. The Aro costs least, if 41 km covers your week.",
      {
        visual: sampleVisuals.table,
      },
    ),
    message(
      "visual-diagram",
      scout,
      "Two steps done. Staging is next, and I check the totals before anything touches production.",
      {
        visual: sampleVisuals.diagram,
      },
    ),
  ];

  /** A visual that tries every way out of its frame. */
  const escapingVisual = message("visual-escape", scout, "Each line is what one attempt got.", {
    visual: sampleVisuals.escape,
  });

  const reacted = (emoji: string, by: Reaction["by"]): Reaction => ({
    emoji: ReactionEmoji.make(emoji),
    by,
  });
  const operator = { _tag: "operator" } as const;
  const bot = (botId: BotId) => ({ _tag: "bot", botId }) as const;
  // The bot that reacted with 👍 has since been deleted.
  const othersOnScout = [
    reacted("🎉", bot(ids.wren)),
    reacted("❤️", bot(ids.atlas)),
    reacted("🎉", bot(ids.juniper)),
    reacted("👍", bot(BotId.make("variant-deleted"))),
  ];
  const scoutNews =
    "The Torra is in stock. The shop holds one for your test ride on Saturday at 10.";
  /** Reactions under a message, and the bar that sets the operator's. */
  const reactions = {
    // 🎉 three times, the operator's among them; ❤️ and 👍 once each.
    onBot: message("reacted", scout, scoutNews, {
      reactions: [reacted("🎉", operator), ...othersOnScout],
    }),
    onOperator: message("reacted-op", { _tag: "operator" }, "Perfect, book it for me.", {
      reactions: [reacted("👍", bot(ids.scout))],
    }),
    // The same message once the operator took their 🎉 off.
    removed: message("reacted-removed", scout, scoutNews, { reactions: othersOnScout }),
  };

  /**
   * Replies and quotes (decision 0094): a reply quotes Scout's news whole; two
   * passages quote it and Wren's note; in the room Wren replies to Juniper;
   * and a reply to a message deleted since.
   */
  const quoteOf = (source: MessageEntry, quoted: MessageQuote["quoted"]): MessageQuote => ({
    entryId: source.id,
    author: source.author._tag === "bot" ? bot(source.author.botId) : operator,
    saidAt: source.createdAt,
    quoted,
  });
  const scoutSource = message("quoted-scout", scout, scoutNews);
  const wrenNote = message(
    "quoted-wren",
    bot(ids.wren),
    "Saturday works for me too. I can bring the helmet and the lock if you need them.",
  );
  const juniperDraft = message(
    "quoted-juniper",
    bot(ids.juniper),
    "Here is the first draft of the intro: three short paragraphs, the photo after the second.",
  );
  const replyToScout = quoteOf(scoutSource, {
    _tag: "message",
    opening: "The Torra is in stock. The shop holds one for your test ride on Saturday",
    more: true,
  });
  const quotes = {
    source: scoutSource,
    wrenNote,
    replyToScout,
    passages: [
      quoteOf(scoutSource, { _tag: "passage", text: "test ride on Saturday at 10" }),
      quoteOf(wrenNote, { _tag: "passage", text: "I can bring the helmet and the lock" }),
    ],
    reply: message("quoting-reply", operator, "Great, book it. Can it be at 11 instead?", {
      quotes: [replyToScout],
    }),
    twoPassages: message(
      "quoting-passages",
      operator,
      "Let’s go with this, and Wren brings the gear.",
      {
        quotes: [
          quoteOf(scoutSource, { _tag: "passage", text: "test ride on Saturday at 10" }),
          quoteOf(wrenNote, { _tag: "passage", text: "I can bring the helmet and the lock" }),
        ],
      },
    ),
    roomReply: message(
      "quoting-room",
      bot(ids.wren),
      "Reads well. I’d move the photo up, so it opens the second paragraph.",
      {
        quotes: [
          quoteOf(juniperDraft, {
            _tag: "message",
            opening: "Here is the first draft of the intro: three short paragraphs, the photo",
            more: true,
          }),
        ],
      },
    ),
    juniperDraft,
    // Its source was deleted since: going to it says so in place.
    missing: message("quoting-missing", operator, "Is this still the plan?", {
      quotes: [
        {
          entryId: id("quoted-deleted"),
          author: bot(ids.atlas),
          saidAt: ago(60),
          quoted: { _tag: "message", opening: "Moving the meetup to the café", more: false },
        },
      ],
    }),
  };

  const embeddingVisual = message(
    "visual-embedding",
    scout,
    "This page held a frame of its own, so it is not shown.",
    { visual: sampleVisuals.embedding },
  );

  /** A bot's offer to record the screen (decision 0098), after the operator described a chore. */
  const recordOffer = message(
    "offer-record",
    scout,
    "That sounds like a lot of clicking. Want to show me once? Record your screen while you do it, and talk me through it as you go.",
    { offer: { kind: "record-screen" } },
  );

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
    {
      // More questions than a card held before, one with seven options, with
      // the harness's headers and previews. Older apps show the placeholder.
      _tag: "question",
      ...base("question-whole"),
      origin: "engine",
      questions: [
        {
          id: "update-to-answer",
          prompt: "This question needs a newer version of the app. Update it to answer.",
          options: [],
          acceptsText: false,
          multiple: false,
        },
      ],
      whole: [
        {
          id: "question-1",
          header: "Layout",
          prompt: "How should the invoice page be laid out?",
          options: [
            {
              ...option("option-1", "Totals on top"),
              preview:
                "┌──────────────┐\n│ Total  $420  │\n├──────────────┤\n│ Line items…  │\n└──────────────┘",
            },
            {
              ...option("option-2", "Totals at the bottom"),
              preview:
                "┌──────────────┐\n│ Line items…  │\n├──────────────┤\n│ Total  $420  │\n└──────────────┘",
            },
          ],
          acceptsText: false,
          multiple: false,
        },
        {
          id: "question-2",
          header: "Currency",
          prompt: "Which currencies should it show?",
          options: [
            option("option-1", "US dollar"),
            option("option-2", "Euro"),
            option("option-3", "Brazilian real"),
            option("option-4", "Pound sterling"),
            option("option-5", "Japanese yen"),
            option("option-6", "Canadian dollar"),
            option("option-7", "Swiss franc"),
          ],
          acceptsText: false,
          multiple: true,
        },
        {
          id: "question-3",
          header: "Dates",
          prompt: "How should dates read?",
          options: [option("option-1", "Nov 26, 2026"), option("option-2", "26/11/2026")],
          acceptsText: true,
          multiple: false,
        },
        {
          id: "question-4",
          header: "Logo",
          prompt: "Keep the logo in the header?",
          options: [option("option-1", "Yes"), option("option-2", "No")],
          acceptsText: false,
          multiple: false,
        },
        {
          id: "question-5",
          header: "Footer",
          prompt: "What goes in the footer?",
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
    question("question-refused", { _tag: "refused" }, "engine"),
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
    approval("approval-refused", { status: { _tag: "refused" } }),
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
    fields: [],
    delivery: "reference",
    status,
  });
  /** A sign-in asked for in one card: an email shown as typed, and a masked password. */
  const signIn = (name: string, status: SecretRequestEntry["status"]): SecretRequestEntry => ({
    _tag: "secret-request",
    ...base(name),
    label: "Sign in to Mail",
    reason: "To sort this week’s invoices into their folders I need to sign in to your mailbox.",
    url: null,
    placeholder: null,
    fields: [
      {
        id: secretRequestFieldId(0),
        label: "Email",
        placeholder: "you@example.com",
        masked: false,
      },
      { id: secretRequestFieldId(1), label: "Password", placeholder: null, masked: true },
    ],
    delivery: "file",
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
    signIn("secret-fields", "pending"),
    signIn("secret-fields-provided", "provided"),
    signIn("secret-fields-declined", "declined"),
    signIn("secret-fields-expired", "expired"),
  ];

  const browserHelp = (
    name: string,
    status: BrowserHelpEntry["status"],
    extra: Partial<Pick<BrowserHelpEntry, "reason" | "note" | "site">> = {},
  ): BrowserHelpEntry => ({
    _tag: "browser-help",
    ...base(name),
    author: { _tag: "bot", botId: ids.scout },
    reason: extra.reason ?? "login",
    note: extra.note ?? "Sign in to the shop, so I can check whether your headphones have shipped.",
    site: extra.site ?? "shop.example.com",
    tab: BrowserTabRef.make(`variant-${name}`),
    status,
  });
  const browserHelps: ReadonlyArray<BrowserHelpEntry> = [
    browserHelp(
      "browser-check",
      { _tag: "pending" },
      {
        reason: "captcha",
        note: "The ticket site wants to know a person is there before it shows prices.",
        site: "tickets.example.com",
      },
    ),
    browserHelp("browser-login", { _tag: "pending" }),
    browserHelp(
      "browser-other",
      { _tag: "pending" },
      { reason: "other", note: "The page asks to confirm the order from your phone.", site: "" },
    ),
    browserHelp("browser-done", { _tag: "done" }),
    browserHelp("browser-declined", { _tag: "declined" }),
    browserHelp("browser-tab-closed", { _tag: "expired", cause: "tab-closed" }),
    browserHelp("browser-timed-out", { _tag: "expired", cause: "timed-out" }),
  ];

  const ask = (
    name: string,
    secret: SecretAskEntry["secret"],
    status: SecretAskEntry["status"],
  ): SecretAskEntry => ({
    _tag: "secret-ask",
    ...base(name),
    author: { _tag: "bot", botId: ids.scout },
    name: secret._tag === "login" ? "billing-dashboard" : "weather-api",
    secret,
    note:
      secret._tag === "login"
        ? "The billing dashboard asks for a login to export the invoices. Save it, and next month I can export them myself."
        : "The weather service needs an API key for the hourly forecast.",
    status,
  });
  const billing = {
    _tag: "login",
    origin: SiteOrigin.make("https://billing.example.com"),
  } as const;
  /** An ask for a service's client ID and secret together, on one card. */
  const askValues = (name: string, status: SecretAskEntry["status"]): SecretAskEntry => ({
    _tag: "secret-ask",
    ...base(name),
    author: { _tag: "bot", botId: ids.scout },
    name: "builds-client-id",
    secret: { _tag: "value" },
    values: [
      {
        id: secretRequestFieldId(0),
        name: "builds-client-id",
        label: "Client ID",
        masked: false,
      },
      {
        id: secretRequestFieldId(1),
        name: "builds-client-secret",
        label: "Client secret",
        masked: true,
      },
    ],
    setup: SetupPageUrl.make("https://builds.example.com/settings/api-clients"),
    note: "The build server signs in a service with its own client. Make one for J3 Bots on its API clients page, and I can start builds myself.",
    status,
  });
  const asks: ReadonlyArray<SecretAskEntry> = [
    ask("ask-login", billing, { _tag: "pending" }),
    ask("ask-value", { _tag: "value" }, { _tag: "pending" }),
    askValues("ask-values", { _tag: "pending" }),
    askValues("ask-values-saved", { _tag: "saved" }),
    ask("ask-saved", billing, { _tag: "saved" }),
    ask("ask-declined", { _tag: "value" }, { _tag: "declined" }),
    ask("ask-expired", billing, { _tag: "expired" }),
  ];

  /** Saved secrets, with the values the sample secrets reveal. */
  const savedSecrets: ReadonlyArray<readonly [Secret, SampleValues]> = [
    [
      {
        id: SecretId.make("sec_variantsupport0000"),
        name: SecretName.make("support-desk"),
        kind: {
          _tag: "login",
          origins: [SiteOrigin.make("https://support.example.com")],
          hasTotp: true,
        },
        access: { _tag: "bots", botIds: [ids.scout] },
        createdAt: ago(60 * 24 * 9),
        updatedAt: ago(60 * 24 * 2),
        lastUse: {
          at: ago(45),
          botId: ids.scout,
          use: { _tag: "browser", origin: SiteOrigin.make("https://support.example.com") },
        },
        lastReveal: {
          at: ago(60 * 5),
          deviceId: DeviceId.make("variant-laptop"),
          field: "password",
        },
      },
      {
        _tag: "login",
        username: "ana@example.com",
        password: "correct-staple-42",
        totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      },
    ],
    [
      {
        id: SecretId.make("sec_variantbilling0000"),
        name: SecretName.make("billing-dashboard"),
        kind: {
          _tag: "login",
          origins: [
            SiteOrigin.make("https://billing.example.com"),
            SiteOrigin.make("https://admin.billing.example.com"),
          ],
          hasTotp: false,
        },
        access: { _tag: "bots", botIds: [] },
        createdAt: ago(60),
        updatedAt: ago(60),
        lastUse: null,
        lastReveal: null,
      },
      { _tag: "login", username: "finance", password: "an example password", totp: null },
    ],
    [
      {
        id: SecretId.make("sec_variantweather0000"),
        name: SecretName.make("weather-api"),
        kind: { _tag: "value" },
        access: { _tag: "every-bot" },
        createdAt: ago(60 * 24 * 30),
        updatedAt: ago(60 * 24 * 30),
        lastUse: {
          at: ago(60 * 3),
          botId: BotId.make("retired-bot"),
          use: { _tag: "connector", name: Label.make("Weather") },
        },
        lastReveal: null,
      },
      { _tag: "value", value: "wx_example_0123456789abcdef" },
    ],
  ];

  const notion = ConnectorId.make("conn_samplenotion00000");
  const auth = (name: string, status: ConnectorAuthEntry["status"]): ConnectorAuthEntry => ({
    _tag: "connector-auth",
    ...base(name),
    author: { _tag: "bot", botId: ids.scout },
    connectorId: notion,
    name: "Notion",
    glyph: ConnectorGlyph.make("notebook"),
    status,
  });
  const connectorAuths: ReadonlyArray<ConnectorAuthEntry> = [
    auth("ca-pending", "pending"),
    auth("ca-signed-in", "signed-in"),
    auth("ca-removed", "removed"),
  ];
  const input = (
    name: string,
    request: ConnectorInputEntry["request"],
    status: ConnectorInputEntry["status"],
  ): ConnectorInputEntry => ({
    _tag: "connector-input",
    ...base(name),
    author: { _tag: "bot", botId: ids.scout },
    connectorId: notion,
    name: "Notion",
    glyph: ConnectorGlyph.make("notebook"),
    request,
    status,
  });
  const form: ConnectorInputEntry["request"] = {
    _tag: "form",
    message: "Which workspace should the new page go in?",
    fields: [
      {
        _tag: "choice",
        key: "workspace",
        label: "Workspace",
        description: null,
        required: true,
        multiple: false,
        options: [
          { value: "team", label: "Team" },
          { value: "personal", label: "Personal" },
        ],
        minItems: null,
        maxItems: null,
        default: [],
      },
      {
        _tag: "text",
        key: "title",
        label: "Page title",
        description: "Shown at the top of the page",
        required: false,
        format: null,
        minLength: null,
        maxLength: 120,
        default: "Launch notes",
      },
      {
        _tag: "boolean",
        key: "share",
        label: "Share it with the team",
        description: null,
        required: false,
        default: null,
      },
    ],
  };
  const page: ConnectorInputEntry["request"] = {
    _tag: "url",
    message: "Approve access to the Launch workspace.",
    url: "https://approve.example.com/flow/7",
    host: "approve.example.com",
  };
  const connectorInputs: ReadonlyArray<ConnectorInputEntry> = [
    input("ci-form", form, { _tag: "pending" }),
    input("ci-page", page, { _tag: "pending" }),
    input("ci-answered", form, { _tag: "answered", action: "accept" }),
    input("ci-declined", page, { _tag: "answered", action: "decline" }),
    input("ci-expired", form, { _tag: "expired" }),
  ];

  const connectorAsk = (
    name: string,
    ask: ConnectorAskEntry["ask"],
    status: ConnectorAskEntry["status"],
  ): ConnectorAskEntry => ({
    _tag: "connector-ask",
    ...base(name),
    author: { _tag: "bot", botId: ids.scout },
    ...(ask._tag === "private-network"
      ? { name: "Home lights", glyph: null }
      : { name: "Example Mail", glyph: ConnectorGlyph.make("envelope") }),
    ask,
    status,
  });
  // A fictional address in the operator's own network.
  const network: ConnectorAskEntry["ask"] = { _tag: "private-network", host: "192.168.1.20:8123" };
  const ownApp: ConnectorAskEntry["ask"] = {
    _tag: "own-app",
    listing: { _tag: "curated", key: CuratedKey.make("example-mail") },
  };
  const connectorAsks: ReadonlyArray<ConnectorAskEntry> = [
    connectorAsk("cq-network", network, { _tag: "pending" }),
    connectorAsk("cq-own-app", ownApp, { _tag: "pending" }),
    connectorAsk("cq-added", network, {
      _tag: "added",
      connectorId: ConnectorId.make("conn_samplehomelights0"),
    }),
    connectorAsk("cq-declined", ownApp, { _tag: "declined" }),
    connectorAsk("cq-failed", ownApp, { _tag: "failed" }),
    connectorAsk("cq-expired", network, { _tag: "expired" }),
  ];

  const fold = (
    name: string,
    status: WorkFoldEntry["status"],
    stepCount: number,
  ): WorkFoldEntry => ({
    _tag: "work-fold",
    ...base(name),
    turnStartedAt: ago(6),
    stepCount,
    apps: [],
    work: null,
    status,
  });
  const step = (
    kind: WorkStep["kind"],
    label: string,
    status: WorkStep["status"] = "completed",
    tool: WorkStep["tool"] = null,
  ): WorkStep => ({
    id: WorkStepId.make(`variant-${label}`),
    kind,
    tool,
    label,
    status,
    startedAt: ago(4),
    finishedAt: status === "running" ? null : ago(3),
  });
  /** A fill of the sample login "GitHub (work)", as its work step shows it. */
  const fillStep = (
    field: CredentialFill["field"],
    origin: string,
    outcome: CredentialFill["outcome"],
  ): WorkStep => ({
    id: WorkStepId.make(`variant-login-${field}-${outcome._tag}`),
    kind: "tool",
    tool: "login",
    label: "Filled a saved login",
    status: outcome._tag === "filled" ? "completed" : "failed",
    startedAt: ago(2),
    finishedAt: ago(2),
    fill: {
      name: "GitHub (work)",
      secretId: null,
      field,
      origin: SiteOrigin.make(origin),
      outcome,
    },
  });
  /** A load of one of the sample Notion's skills, as its work step shows it. */
  const skillStep = (name: string, status: WorkStep["status"]): WorkStep => ({
    ...step("tool", "Used a connector's skill", status, "connector-skill"),
    id: WorkStepId.make(`variant-skill-${name}`),
    skill: { name: SkillName.make(name), connector: Label.make("Notion") },
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
      entry: fold(
        "fold-done",
        {
          _tag: "finished",
          finishedAt: ago(1),
          ending: "completed",
        },
        6,
      ),
      steps: [
        step("read", "invoices/2026-03.json"),
        step(
          "command",
          "Get-ChildItem -Path .\\invoices -Filter *.json |\n  Measure-Object -Property Length -Sum",
        ),
        step("tool", "Bank statement lookup"),
        step("delegation", "Check the March totals against the bank statement"),
        step("edit", "memory/log/2026-11.md"),
        step("other", "Wrote the summary"),
      ],
      open: true,
    },
    {
      entry: fold(
        "fold-images",
        {
          _tag: "finished",
          finishedAt: ago(1),
          ending: "completed",
        },
        3,
      ),
      // Images it looked at: shown, still arriving, and one it has removed since.
      steps: [
        {
          ...step("tool", "Looked at an image", "completed", "image"),
          id: WorkStepId.make("variant-image-shown"),
          image: { id: GALLERY_WORK_IMAGES.shown },
        },
        {
          ...step("tool", "Looked at an image", "completed", "image"),
          id: WorkStepId.make("variant-image-loading"),
          image: { id: GALLERY_WORK_IMAGES.loading },
        },
        {
          ...step("tool", "Looked at an image", "completed", "image"),
          id: WorkStepId.make("variant-image-gone"),
          image: { id: GALLERY_WORK_IMAGES.gone },
        },
      ],
      open: true,
    },
    {
      entry: fold(
        "fold-handed-off",
        {
          _tag: "finished",
          finishedAt: ago(2),
          ending: "completed",
        },
        2,
      ),
      // Work the turn handed off still runs: part of the finished fold, with no mark of its own.
      steps: [
        step("read", "invoices/2026-04.json"),
        step("command", "node reconcile.js --watch", "running"),
      ],
      open: true,
    },
    {
      entry: fold("fold-skills", { _tag: "running" }, 2),
      steps: [skillStep("meeting-notes", "completed"), skillStep("project-brief", "running")],
      open: true,
    },
    {
      entry: fold(
        "fold-loading",
        {
          _tag: "finished",
          finishedAt: ago(3),
          ending: "completed",
        },
        12,
      ),
      steps: null,
      open: true,
    },
    {
      entry: fold(
        "fold-stopped",
        {
          _tag: "finished",
          finishedAt: ago(2),
          ending: "interrupted",
        },
        2,
      ),
      steps: [],
      open: false,
    },
    {
      entry: fold(
        "fold-failed",
        {
          _tag: "finished",
          finishedAt: ago(0),
          ending: "failed",
        },
        1,
      ),
      steps: [step("web", "Read the vendor’s status page", "failed")],
      open: true,
    },
    {
      entry: fold(
        "fold-logins",
        {
          _tag: "finished",
          finishedAt: ago(1),
          ending: "completed",
        },
        5,
      ),
      steps: [
        step("tool", "Used the browser", "completed", "browser"),
        fillStep("username", "https://github.com", { _tag: "filled", submitted: false }),
        fillStep("password", "https://github.com", { _tag: "filled", submitted: true }),
        fillStep("password", "https://xn--gthub-zsa.com", { _tag: "refused", reason: "origin" }),
        fillStep("totp", "https://github.com", { _tag: "refused", reason: "unavailable" }),
      ],
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
    notice(
      "notice-unreachable",
      {
        _tag: "turn-failed",
        failure: "unreachable",
        details: "transport_error: The connection to the provider closed before it answered.",
      },
      true,
    ),
    notice("notice-signed-out", { _tag: "turn-failed", failure: "permission-error" }),
    notice("notice-undelivered", { _tag: "undelivered" }, true),
    notice("notice-handoff-failed", { _tag: "handoff-failed", senders: [ids.wren] }, true),
    notice(
      "notice-handoffs-failed",
      { _tag: "handoff-failed", senders: [ids.wren, ids.atlas] },
      true,
    ),
    notice("notice-hops", { _tag: "chain-stopped", limit: "hops" }),
    notice("notice-fanout", { _tag: "chain-stopped", limit: "fan-out" }),
    notice("notice-room-quiet", { _tag: "chain-stopped", limit: "room" }),
    notice("notice-waiting", { _tag: "waiting-in-conversation", botId: ids.juniper }),
    notice("notice-lost", { _tag: "session-lost" }),
    notice("notice-not-ready", { _tag: "session-not-ready" }),
    notice("notice-mode-refused", {
      _tag: "permission-mode-refused",
      permissionMode: "full-access",
      allowed: "supervised",
    }),
    notice("notice-member-mode-refused", { _tag: "member-mode-refused", botId: ids.juniper }),
    notice("notice-settings", { _tag: "settings-held" }),
    notice("notice-asks-auto", {
      _tag: "asks-before-acting",
      permissionMode: "auto",
      details:
        "Asking about each action: Claude's settings turn auto mode off. Switch this thread to Supervised or Auto-accept edits, or change the setting.",
    }),
    notice("notice-asks-full-access", {
      _tag: "asks-before-acting",
      permissionMode: "full-access",
      details:
        "Could not confirm Claude bypass permissions here, so Full access is running with approval checks.",
    }),
    notice("notice-behind", { _tag: "observation-failed" }),
    notice("notice-too-long", { _tag: "too-long" }),
  ];
  /** Notices told in event lines, not in notice lines. */
  const noticeEvents: ReadonlyArray<NoticeEntry> = [
    notice("notice-routine-paused", {
      _tag: "routine-paused",
      routineId: RoutineId.make("routine-digest"),
      name: "Morning digest",
    }),
    notice("notice-operator-named", { _tag: "operator-named", botId: ids.juniper, name: "Sam" }),
    notice("notice-room-started", {
      _tag: "room-started",
      botId: ids.scout,
      roomId: ids.newsletter,
    }),
    notice("notice-made-for-room", {
      _tag: "made-for-room",
      botId: ids.scout,
      roomId: ids.newsletter,
    }),
  ];

  const handoff = (
    name: string,
    from: BotId,
    to: BotId,
    fields: Pick<HandoffEntry, "direction" | "text" | "urgent" | "state">,
  ): HandoffEntry => ({
    _tag: "handoff",
    ...base(name),
    author: { _tag: "bot", botId: from },
    recipientId: to,
    ...fields,
  });
  const handoffs: ReadonlyArray<HandoffEntry> = [
    handoff("handoff", ids.scout, ids.wren, {
      direction: "sent",
      text: "Can you shorten the newsletter’s opening to three sentences?",
      urgent: false,
      state: "sent",
    }),
    handoff("handoff-urgent", ids.scout, ids.atlas, {
      direction: "sent",
      text: "The billing API on staging is still read-only ten minutes after the migration. Please look now.",
      urgent: true,
      state: "sent",
    }),
    handoff("handoff-received", ids.wren, ids.scout, {
      direction: "received",
      text: "Which of the three bikes should the test ride be on? The shop has the gravel bike in a medium, the city bike in a large, and the folding one only on Saturday afternoon, so if the ride has to be in the morning the folding one is out.",
      urgent: false,
      state: "sent",
    }),
    handoff("handoff-received-urgent", ids.atlas, ids.scout, {
      direction: "received",
      text: "Staging is read-only again. Can you hold the newsletter send until I say it’s back?",
      urgent: true,
      state: "not-delivered",
    }),
    handoff("handoff-failed", ids.scout, ids.atlas, {
      direction: "sent",
      text: "Please roll back the staging migration before the demo.",
      urgent: true,
      state: "not-delivered",
    }),
    handoff("handoff-stopped", ids.scout, ids.wren, {
      direction: "sent",
      text: "Draft the reply to the landlord before tonight.",
      urgent: false,
      state: "stopped",
    }),
    handoff("handoff-unconfirmed", ids.scout, ids.atlas, {
      direction: "sent",
      text: "The invoices for March are in the shared folder.",
      urgent: false,
      state: "unconfirmed",
    }),
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

  // A routine on a connector's event: set by the bot, then stopped by J3 Bots, for each reason.
  const eventChange = (
    name: string,
    kind: EventRoutineChangeEntry["change"],
    stopped?: EventRoutineChangeEntry["stopped"],
  ): EventRoutineChangeEntry => ({
    _tag: "event-routine-change",
    ...base(name),
    ...(kind === "stopped" ? { author: { _tag: "system" } } : {}),
    routineId: RoutineId.make(`variant-${name}`),
    name: "Invoices from Ana",
    change: kind,
    trigger: {
      _tag: "event",
      connectorId: ConnectorId.make("conn_samplemail0000000"),
      name: "message_received",
      arguments: { from: "ana@example.com" },
      summary: "a new email from Ana arrives",
    },
    connector: "Mail",
    ...(stopped === undefined ? {} : { stopped }),
  });
  const eventRoutineChanges: ReadonlyArray<EventRoutineChangeEntry> = [
    eventChange("erc-created", "created"),
    eventChange("erc-revoked", "stopped", "access-revoked"),
    eventChange("erc-event-gone", "stopped", "event-gone"),
    eventChange("erc-connector-gone", "stopped", "connector-gone"),
    eventChange("erc-refused", "stopped", "refused"),
  ];

  // Each entry's own line, as the timeline places it, then a line that tells several routines.
  const eventLines: ReadonlyArray<EventLine> = [
    ...[...handoffs, ...routineChanges, ...eventRoutineChanges, ...noticeEvents].flatMap(
      (entry) => {
        const place = placeOf(entry);
        return place._tag === "line" ? [place.line] : [];
      },
    ),
    {
      _tag: "routines",
      changes: [
        change("rc-group-1", "created", halfHourly),
        { ...change("rc-group-2", "created", { _tag: "webhook" }), name: "Deploy watch" },
        { ...change("rc-group-3", "created", halfHourly), name: "Inbox sweep" },
      ],
    },
  ];

  return {
    eventLines,
    bubbles,
    visualBubbles,
    escapingVisual,
    embeddingVisual,
    recordOffer,
    reactions,
    quotes,
    questions,
    approvals,
    approvalBecomingExact,
    secrets,
    browserHelps,
    asks,
    savedSecrets,
    connectorInputs,
    connectorAsks,
    connectorAuths,
    folds,
    notices,
  };
}
