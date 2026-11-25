// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, RoomId, RoutineId } from "@j3-bots/contracts";
import { SecureRandom } from "effect/crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { NONCE_BYTES, withFreshNonce } from "./nonce.ts";
import { defuseTags, type EnvelopeTag, escapeAttribute } from "./text.ts";

/**
 * Wake envelopes: the one format in which every dispatched message reaches a
 * bot. See `docs/prompts/architecture.md#wake-envelopes`.
 *
 * Who wrote a piece of text decides where it goes:
 *
 * - the operator's words go in `<message from="user">`;
 * - a routine's saved instruction goes in `<instruction>`;
 * - everything else (teammates, other bots in a room, webhook bodies, what an
 *   earlier run said, a session digest) goes in a `<data-NONCE>` block, with a
 *   nonce drawn for that wake.
 *
 * All text, whoever wrote it, has envelope tags defused, so nothing inside a
 * block can close it or pose as another one.
 */

/** Something that starts a bot turn. */
export type WakeKind = "user" | "room" | "bot" | "routine" | "system";

/** A teammate as an envelope names it: enough to recognize them and answer with `message_bot`. */
export interface TeammateRef {
  readonly id: BotId;
  readonly name: string;
  /** Empty when the operator gave none. */
  readonly title: string;
}

/**
 * A file the operator attached, already copied into the bot's workspace. The
 * envelope numbers every file a wake carries (`n`, from 1), in the order the
 * engine hands them to the bot's harness, which is the order of the messages
 * and, within one, of its files.
 */
export interface AttachmentRef {
  readonly name: string;
  /** Relative to the workspace. */
  readonly path: string;
  readonly mediaType: string;
  /**
   * Where the operator placed it in the message's text, in UTF-16 code units:
   * the envelope writes it there. `null` for a file written after the text,
   * as one sent without a place is. A message places all of its files or
   * none, never decreasing, so their numbers follow the text.
   */
  readonly offset: number | null;
}

export interface OperatorMessage {
  readonly at: DateTime.Utc;
  readonly text: string;
  readonly attachments: ReadonlyArray<AttachmentRef>;
}

/** The operator's response to a card the bot raised with `ask`. */
export interface AskAnswer {
  /** The question as the bot asked it. */
  readonly question: string;
  /**
   * The room whose turn asked, where `say` delivers in this turn too; `null`
   * when the question was asked in the bot's own conversation.
   */
  readonly room: string | null;
  readonly response:
    | {
        readonly type: "answered";
        /** The options chosen, as the bot defined them. */
        readonly chosen: ReadonlyArray<{ readonly label: string; readonly value: string | null }>;
        /** A typed answer, when the card allowed one and the operator wrote one. */
        readonly text: string | null;
      }
    /** The bot reads a dismissed card as "no". */
    | { readonly type: "dismissed" };
}

/** A teammate's message, direct or held for this turn. */
export interface TeammateMessage {
  readonly from: TeammateRef;
  readonly at: DateTime.Utc;
  readonly text: string;
  readonly urgent: boolean;
}

/** A profile field and its new value. */
export interface ProfileChange {
  readonly field: "name" | "title" | "job";
  readonly value: string;
}

/** Something the session has not seen, reported at the top of the next wake. */
export type CatchUpItem =
  /** A routine run, in a side session, said this to the operator. */
  | {
      readonly type: "routine-delivered";
      readonly routine: string;
      readonly at: DateTime.Utc;
      readonly text: string;
    }
  /** A non-urgent teammate message that waited for this turn. */
  | { readonly type: "held-message"; readonly message: TeammateMessage }
  | {
      readonly type: "profile-changed";
      readonly changes: readonly [ProfileChange, ...Array<ProfileChange>];
    }
  /**
   * The bot's working session was replaced since its last turn; `digest`
   * holds the recent conversation for the new one, oldest first.
   */
  | { readonly type: "session-rotated"; readonly digest: ReadonlyArray<DigestMessage> };

/** One message of a session digest: who wrote it, its text, and the names of its files. */
export interface DigestMessage {
  /** `user` for the operator, `you` for the bot. */
  readonly from: "user" | "you";
  readonly text: string;
  readonly files: ReadonlyArray<string>;
}

interface WakeBase {
  /** When the wake is dispatched. */
  readonly at: DateTime.Utc;
  /** The operator's zone. Every time in the envelope is given in it. */
  readonly timeZone: DateTime.TimeZone.Named;
  /** Empty when the session has seen everything. */
  readonly sinceLastTurn: ReadonlyArray<CatchUpItem>;
}

export type UserWake = WakeBase & {
  readonly kind: "user";
} & (
    | { readonly answer: AskAnswer; readonly messages: ReadonlyArray<OperatorMessage> }
    | {
        readonly answer: null;
        readonly messages: readonly [OperatorMessage, ...Array<OperatorMessage>];
      }
  );

/** Who a room entry addressed: nobody, some members by name, or everyone. */
export type RoomMentions = ReadonlyArray<string> | "everyone";

export type RoomEntry =
  | {
      readonly author: "user";
      readonly at: DateTime.Utc;
      readonly text: string;
      readonly mentions: RoomMentions;
      readonly attachments: ReadonlyArray<AttachmentRef>;
    }
  | {
      readonly author: TeammateRef;
      readonly at: DateTime.Utc;
      readonly text: string;
      readonly mentions: RoomMentions;
      /**
       * The names of the files the teammate posted with it, which the wake
       * carries and numbers like the operator's.
       */
      readonly files: ReadonlyArray<string>;
    };

export interface RoomWake extends WakeBase {
  readonly kind: "room";
  readonly room: {
    readonly id: RoomId;
    readonly name: string;
    /** In member order, this bot included. */
    readonly members: ReadonlyArray<TeammateRef>;
  };
  /**
   * Why this bot is woken: the kickoff of a room a member started, a message
   * addressed to this bot or to everyone, or one addressed to nobody, which
   * the operator wrote (`user`) or another member did (`member`). It chooses
   * the envelope's closing line.
   */
  readonly reason: RoomReason;
  /**
   * The room's bots have said so much since the operator last wrote that the
   * conversation is closing: the closing line asks for an answer only if it
   * is essential.
   */
  readonly closing: boolean;
  /**
   * How many entries this bot has not seen are older than those shown: the
   * envelope carries the newest that fit.
   */
  readonly omitted: number;
  /** The entries this bot has not seen, oldest first. */
  readonly entries: readonly [RoomEntry, ...Array<RoomEntry>];
}

/** Why a bot is woken for a room. */
export type RoomReason = "kickoff" | "addressed" | "everyone" | "user" | "member";

export interface BotWake extends WakeBase {
  readonly kind: "bot";
  /** Oldest first. Several when wakes were coalesced. */
  readonly messages: readonly [TeammateMessage, ...Array<TeammateMessage>];
}

export type RoutineTrigger =
  | { readonly type: "schedule"; readonly cron: string }
  | { readonly type: "once" }
  | { readonly type: "webhook" };

export interface RoutineRunSummary {
  readonly at: DateTime.Utc;
  readonly outcome:
    | { readonly type: "delivered"; readonly text: string }
    /** `note` is the result the run recorded instead of speaking. */
    | { readonly type: "silent"; readonly note: string | null }
    | { readonly type: "failed" }
    | { readonly type: "skipped" };
}

export interface RoutineWake extends WakeBase {
  readonly kind: "routine";
  readonly routine: {
    readonly id: RoutineId;
    readonly name: string;
    readonly trigger: RoutineTrigger;
    readonly instruction: string;
  };
  /** Most recent first. */
  readonly recentRuns: ReadonlyArray<RoutineRunSummary>;
  /** The webhook request body, for a webhook trigger. */
  readonly triggerData: string | null;
  /**
   * When the run was due, when that was more than a minute before `at` or on
   * another day in `timeZone`: J3 Bots was not running at a scheduled run's
   * time, an attempt is tried again later, or a run due just before midnight
   * starts after it. Dates in the instruction are read against it.
   */
  readonly dueAt: DateTime.Utc | null;
}

export type SystemEvent =
  | {
      readonly name: "first-run";
      /**
       * The opening asks what the operator wants to be called: nobody knows,
       * and no other bot's opening has asked.
       */
      readonly askName: boolean;
    }
  | {
      readonly name: "profile-changed";
      readonly changes: readonly [ProfileChange, ...Array<ProfileChange>];
    }
  | { readonly name: "undelivered" }
  | {
      readonly name: "browser-help";
      /**
       * How the step the bot asked for in its browser ended: the operator did
       * it, could not, or the request expired with its tab or after waiting
       * too long. `handed-back`: the operator took the browser while the bot
       * worked, without being asked, and gave it back.
       */
      readonly outcome: "done" | "declined" | "tab-closed" | "timed-out" | "handed-back";
      /** The host name of the page the request was about; null when none was known. */
      readonly site: string | null;
    };

export interface SystemWake extends WakeBase {
  readonly kind: "system";
  readonly event: SystemEvent;
}

export type Wake = UserWake | RoomWake | BotWake | RoutineWake | SystemWake;

/**
 * The line every envelope ends with, restating the speech rule for its kind;
 * a room's depends on why the bot was woken ({@link ROOM_CLOSING_LINES}).
 */
export const CLOSING_LINES: { readonly [K in Exclude<WakeKind, "room">]: string } = {
  user: "Reply with `say`; nothing else reaches them. Your last call is a `say` with `done: true` (the result, or that delegated work is underway) or an `ask`.",
  bot: "`say` reaches your user, not the sender. Answer the sender with `message_bot`, and only if you were asked something or have a result.",
  routine:
    "Nobody is waiting: send no progress message. A message is one `say` with `done: true`, after the work; once it returns, never alongside it, only reads, an update of a file the instruction names and, last, a `pause` the instruction asks for may follow it, by the id above; no second `say`. Read every date in the instruction against the time the run was due: `due` above, or the time above when there is none. Then take the first of these that applies. If the instruction pauses after a message that a recent run already sent, pause now, without a `say`. Otherwise do the work and follow the delivery line, which sends that one message or none; a question for your user, or a source you could not reach, goes inside it. When it sends none, end with no `say` at all, not even to say all is well, unless the work was blocked: then, if `recent-runs` already says what blocks it, still end with no `say`; if not, say in one sentence what blocks it and what would fix it; that `say` is the run's last call, with no pause. Never pause a one-time routine.",
  system:
    "This is an event, not a message from your user. Respond only as your instructions say for it.",
};

/**
 * A room envelope's closing line, by why the bot was woken: how far the
 * member goes, and, for one not addressed, that a member's message asks less
 * of it than the user's, which keeps a room from talking on among its bots.
 * The kickoff's says the room is the user's and gives the member a part: a
 * bot made for the room has nothing else to go on.
 */
export const ROOM_CLOSING_LINES: { readonly [R in RoomReason]: string } = {
  kickoff:
    "In this room, `say` reaches everyone. Your user asked for this room, and this is its kickoff, which names your part. Answer what it asks of you now, even if another member speaks first. End your turn without a word only if it asks nothing of you.",
  addressed:
    "In this room, `say` reaches everyone. You were addressed: read what the others already said, then answer.",
  everyone:
    "In this room, `say` reaches everyone. Your user asked every member to answer: answer briefly, adding what the replies before yours do not say.",
  user: "In this room, `say` reaches everyone. Your user wrote to the whole room. Read what the others already said, then answer if the message is for you or you have something to add that nobody said; otherwise end your turn without a word.",
  member:
    "In this room, `say` reaches everyone. A member wrote to the whole room. Answer only if it asks something of you or you have something to add that nobody said, never just to agree, thank or acknowledge; otherwise end your turn without a word.",
};

/** What a room envelope's closing line adds once the conversation is closing (`RoomWake.closing`). */
export const ROOM_CLOSING_NOTE =
  "The bots here have said a lot since your user last wrote, so the conversation is closing: speak only if it is essential.";

/** The line an envelope ends with. */
const closingLine = (wake: Wake): string =>
  wake.kind === "room"
    ? wake.closing
      ? `${ROOM_CLOSING_LINES[wake.reason]} ${ROOM_CLOSING_NOTE}`
      : ROOM_CLOSING_LINES[wake.reason]
    : CLOSING_LINES[wake.kind];

const PROFILE_CHANGED_LINE = "Your profile was changed. The new values:";

/**
 * What a `first-run` event adds when the opening asks the operator's name. It
 * carries the instruction itself, so the base prompt says nothing about asking
 * and an opening that should not ask is not led to.
 */
const ASK_NAME_LINE =
  "None of their bots knows yet what they want to be called, so instead of what they need, your hello asks what to call them, in a few friendly words.";

/**
 * What a `browser-help` event says happened, and what to do now. The page
 * changed under the bot, so it looks again before it acts; a step the
 * operator did not do is never retried by the bot, and a request that
 * expired is not raised again on its own.
 */
const BROWSER_HELP_LINES: {
  readonly [O in Extract<SystemEvent, { readonly name: "browser-help" }>["outcome"]]: string;
} = {
  done: "Your user did the step you asked for in your browser and gave it back. Take a fresh snapshot before you act, since the page has changed, then carry on with the task. Reply with `say`; nothing else reaches them. Your last call is a `say` with `done: true`.",
  declined:
    "Your user could not do the step you asked for in your browser, and gave it back. Do not try the step yourself. Finish what does not need it, then end with a `say` with `done: true` that tells your user what the step still blocks; nothing else reaches them.",
  "tab-closed":
    "The tab you asked your user for help in closed before they did the step, so it was not done. Do not ask again on your own: end with one short `say` with `done: true` that tells your user the task waits on that step, and that you will continue when they tell you to.",
  "timed-out":
    "Your user did not do the step you asked for in your browser in time, so the request closed. Do not ask again on your own: end with one short `say` with `done: true` that tells your user the task waits on that step, and that you will continue when they tell you to.",
  "handed-back":
    "Your user took over your browser while you worked and has given it back. Take a fresh snapshot before you act, since the page may have changed, then carry on with what you were doing, and deliver it with `say`, your last call with `done: true`. If it was already done, end your turn without a word.",
};

/** What happened, in one line. */
const eventLine = (event: SystemEvent): string => {
  switch (event.name) {
    case "first-run":
      return event.askName
        ? `You were just created, and your user has not written yet. ${ASK_NAME_LINE}`
        : "You were just created, and your user has not written yet.";
    case "profile-changed":
      return PROFILE_CHANGED_LINE;
    case "undelivered":
      return "Your last turn for your user ended without delivering an answer.";
    case "browser-help":
      return BROWSER_HELP_LINES[event.outcome];
  }
};

type Attributes = ReadonlyArray<readonly [string, string | null]>;

const attributes = (attrs: Attributes): string =>
  attrs
    .filter((attr): attr is readonly [string, string] => attr[1] !== null)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");

const trimEnd = (text: string): string => text.replace(/\s+$/u, "");

/** Builds one envelope with a fixed nonce, counting the data blocks it opens. */
class EnvelopeWriter {
  readonly lines: Array<string> = [];
  readonly nonce: string;
  readonly wake: Wake;
  dataBlocks = 0;
  /** The files numbered so far: the next one is `files + 1`. */
  files = 0;

  constructor(nonce: string, wake: Wake) {
    this.nonce = nonce;
    this.wake = wake;
  }

  line(text: string): void {
    this.lines.push(text);
  }

  empty(tag: EnvelopeTag, attrs: Attributes = []): void {
    this.line(`<${tag}${attributes(attrs)}/>`);
  }

  open(tag: EnvelopeTag, attrs: Attributes = []): void {
    this.line(`<${tag}${attributes(attrs)}>`);
  }

  close(tag: EnvelopeTag): void {
    this.line(`</${tag}>`);
  }

  inline(tag: EnvelopeTag, attrs: Attributes, text: string): void {
    this.line(`<${tag}${attributes(attrs)}>${defuseTags(text.trim())}</${tag}>`);
  }

  block(tag: EnvelopeTag, attrs: Attributes, text: string): void {
    this.open(tag, attrs);
    this.line(defuseTags(trimEnd(text)));
    this.close(tag);
  }

  /** The number of the next file the wake carries. */
  nextFile(): string {
    this.files++;
    return String(this.files);
  }

  data(attrs: Attributes, text: string): void {
    const tag = `data-${this.nonce}`;
    this.dataBlocks++;
    this.line(`<${tag}${attributes(attrs)}>`);
    this.line(defuseTags(trimEnd(text)));
    this.line(`</${tag}>`);
  }

  /** A time as the operator reads it: the clock alone on the wake's day, the date as well otherwise. */
  time(at: DateTime.Utc): string {
    const local = DateTime.toParts(DateTime.setZone(at, this.wake.timeZone));
    const today = DateTime.toParts(DateTime.setZone(this.wake.at, this.wake.timeZone));
    const clock = `${pad(local.hour)}:${pad(local.minute)}`;
    const sameDay =
      local.year === today.year && local.month === today.month && local.day === today.day;
    return sameDay ? clock : `${local.year}-${pad(local.month)}-${pad(local.day)} ${clock}`;
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `2026-11-20T09:41:00-03:00`: the wake time in the operator's zone, to the second. */
const isoInZone = (at: DateTime.Utc, zone: DateTime.TimeZone.Named) => {
  const zoned = DateTime.setZone(at, zone);
  const p = DateTime.toParts(zoned);
  const iso = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${DateTime.zonedOffsetIso(zoned)}`;
  return { iso, weekday: WEEKDAYS[p.weekDay] ?? "" };
};

const titleOf = (ref: TeammateRef): string | null => (ref.title === "" ? null : ref.title);

const mentionsOf = (mentions: RoomMentions): string | null =>
  mentions === "everyone" ? "everyone" : mentions.length === 0 ? null : mentions.join(", ");

const writeTeammateMessage = (w: EnvelopeWriter, message: TeammateMessage): void =>
  w.data(
    [
      ["source", "bot"],
      ["from", message.from.name],
      ["from-id", message.from.id],
      ["title", titleOf(message.from)],
      ["at", w.time(message.at)],
      ["urgent", message.urgent ? "true" : "false"],
    ],
    message.text,
  );

/** A file as the envelope names it, numbered in the order the wake carries it. */
const attachmentTag = (w: EnvelopeWriter, file: AttachmentRef): string =>
  `<attachment${attributes([
    ["n", w.nextFile()],
    ["name", file.name],
    ["type", file.mediaType],
    ["path", file.path],
  ])}/>`;

/**
 * The operator's words with each file they placed written where they placed
 * it, and the text between them defused. An offset past the text trimmed of
 * its trailing space stands at its end.
 */
const placedText = (
  w: EnvelopeWriter,
  text: string,
  placed: ReadonlyArray<AttachmentRef & { readonly offset: number }>,
): string => {
  let written = "";
  let cursor = 0;
  for (const file of placed) {
    const at = Math.min(Math.max(file.offset, cursor), text.length);
    written += defuseTags(text.slice(cursor, at)) + attachmentTag(w, file);
    cursor = at;
  }
  return written + defuseTags(text.slice(cursor));
};

const writeProfileChanges = (w: EnvelopeWriter, changes: ReadonlyArray<ProfileChange>): void => {
  for (const change of changes) w.block("field", [["name", change.field]], change.value);
};

const writeSinceLastTurn = (w: EnvelopeWriter, items: ReadonlyArray<CatchUpItem>): void => {
  if (items.length === 0) return;
  w.open("since-last-turn");
  for (const item of items) {
    switch (item.type) {
      case "routine-delivered":
        w.line(
          `Routine "${escapeAttribute(item.routine)}" ran at ${w.time(item.at)} and told your user:`,
        );
        w.data([["source", "routine-run"]], item.text);
        break;
      case "held-message":
        w.line("A teammate's message, held until this turn:");
        writeTeammateMessage(w, item.message);
        break;
      case "profile-changed":
        w.line(PROFILE_CHANGED_LINE);
        writeProfileChanges(w, item.changes);
        break;
      case "session-rotated":
        if (item.digest.length === 0) {
          w.line("Your working session was replaced. No earlier messages are carried over to it.");
          break;
        }
        // One block per message, its author an attribute: no text of one can
        // pass for another's author.
        w.line(
          "Your working session was replaced. The recent conversation follows, oldest first, one block per message.",
        );
        for (const message of item.digest) {
          w.data(
            [
              ["source", "digest"],
              ["from", message.from],
              // One attribute per file: a name may hold any character, a comma too.
              ...message.files.map((name, index): readonly [string, string] => [
                `file-${index + 1}`,
                name,
              ]),
            ],
            message.text,
          );
        }
        break;
    }
  }
  w.close("since-last-turn");
};

/**
 * The operator's words, with what they attached: each file they placed where
 * they placed it, and any other after the text.
 */
const writeOperatorMessage = (
  w: EnvelopeWriter,
  attrs: Attributes,
  text: string,
  attachments: ReadonlyArray<AttachmentRef>,
): void => {
  w.open("message", [["from", "user"], ...attrs]);
  const placed = attachments.flatMap((file) =>
    file.offset === null ? [] : [{ ...file, offset: file.offset }],
  );
  w.line(placedText(w, trimEnd(text), placed));
  for (const file of attachments) if (file.offset === null) w.line(attachmentTag(w, file));
  w.close("message");
};

const writeAnswer = (w: EnvelopeWriter, answer: AskAnswer): void => {
  const { response } = answer;
  w.open("answer", [
    ["room", answer.room],
    ["dismissed", response.type === "dismissed" ? "true" : null],
  ]);
  w.inline("question", [], answer.question);
  if (response.type === "answered") {
    for (const option of response.chosen)
      w.inline("chosen", [["value", option.value]], option.label);
    if (response.text !== null) writeOperatorMessage(w, [], response.text, []);
  }
  w.close("answer");
};

const writeBody = (w: EnvelopeWriter, wake: Wake): void => {
  switch (wake.kind) {
    case "user":
      if (wake.answer !== null) writeAnswer(w, wake.answer);
      for (const message of wake.messages) {
        // Times tell coalesced messages apart; a single one was sent at the wake's time.
        const at = wake.messages.length > 1 ? w.time(message.at) : null;
        writeOperatorMessage(w, [["at", at]], message.text, message.attachments);
      }
      return;
    case "room": {
      w.open("room", [
        ["id", wake.room.id],
        ["name", wake.room.name],
        ["reason", wake.reason],
      ]);
      for (const member of wake.room.members) {
        w.empty("member", [
          ["id", member.id],
          ["name", member.name],
          ["title", titleOf(member)],
        ]);
      }
      w.close("room");
      if (wake.omitted > 0) {
        w.line(
          `${wake.omitted} earlier ${wake.omitted === 1 ? "entry" : "entries"} you have not seen ${wake.omitted === 1 ? "is" : "are"} left out; what woke you and the newest follow.`,
        );
      }
      for (const entry of wake.entries) {
        const to = mentionsOf(entry.mentions);
        if (entry.author === "user") {
          writeOperatorMessage(
            w,
            [
              ["at", w.time(entry.at)],
              ["to", to],
            ],
            entry.text,
            entry.attachments,
          );
        } else {
          w.data(
            [
              ["source", "room"],
              ["from", entry.author.name],
              ["from-id", entry.author.id],
              ["at", w.time(entry.at)],
              ["to", to],
              // One attribute per file, by its number in the wake.
              ...entry.files.map((name): readonly [string, string] => [
                `file-${w.nextFile()}`,
                name,
              ]),
            ],
            entry.text,
          );
        }
      }
      return;
    }
    case "bot":
      for (const message of wake.messages) writeTeammateMessage(w, message);
      return;
    case "routine": {
      const { routine } = wake;
      const trigger = routine.trigger;
      const due = wake.dueAt === null ? null : isoInZone(wake.dueAt, wake.timeZone);
      w.open("routine", [
        ["id", routine.id],
        ["name", routine.name],
        ["trigger", trigger.type],
        ["cron", trigger.type === "schedule" ? trigger.cron : null],
        ["due", due?.iso ?? null],
        ["due-weekday", due?.weekday ?? null],
      ]);
      w.block("instruction", [], routine.instruction);
      w.open("recent-runs");
      if (wake.recentRuns.length === 0) w.line("None: this is the first run.");
      for (const run of wake.recentRuns) {
        const attrs: Attributes = [
          ["at", w.time(run.at)],
          ["outcome", run.outcome.type],
        ];
        const outcome = run.outcome;
        const text =
          outcome.type === "delivered"
            ? outcome.text
            : outcome.type === "silent"
              ? outcome.note
              : null;
        if (text === null) {
          w.empty("run", attrs);
        } else {
          w.open("run", attrs);
          w.data([["source", "routine-run"]], text);
          w.close("run");
        }
      }
      w.close("recent-runs");
      w.close("routine");
      if (wake.triggerData !== null) w.data([["source", "webhook"]], wake.triggerData);
      return;
    }
    case "system": {
      const { event } = wake;
      w.line(eventLine(event));
      if (event.name === "profile-changed") writeProfileChanges(w, event.changes);
      if (event.name === "browser-help" && event.site !== null) {
        w.empty("browser-tab", [["site", event.site]]);
      }
      return;
    }
  }
};

/** The envelope for one nonce, and how many times that nonce must appear in it. */
const write = (
  wake: Wake,
  nonce: string,
): { readonly text: string; readonly nonceUses: number } => {
  const w = new EnvelopeWriter(nonce, wake);
  const { iso, weekday } = isoInZone(wake.at, wake.timeZone);
  w.open("j3-wake", [
    ["kind", wake.kind],
    ["event", wake.kind === "system" ? wake.event.name : null],
    ["at", iso],
    ["weekday", weekday],
    ["tz", DateTime.zoneToString(wake.timeZone)],
  ]);
  writeSinceLastTurn(w, wake.sinceLastTurn);
  writeBody(w, wake);
  w.close("j3-wake");
  w.line(closingLine(wake));
  // Each data block names the nonce twice, in its opening and its closing tag.
  return { text: `${w.lines.join("\n")}\n`, nonceUses: w.dataBlocks * 2 };
};

/**
 * Renders a wake with a given nonce, which must be twelve lowercase hex
 * characters. Only for fixed renders, such as the version fingerprint;
 * dispatched envelopes come from {@link renderWake}.
 */
export const renderWakeWithNonce = (wake: Wake, nonce: string): string => write(wake, nonce).text;

/**
 * The envelope {@link renderWake} renders for a wake, with a fixed nonce of the
 * same length, so exactly as long: for measuring an envelope before it is
 * written.
 */
export const renderWakeForSize = (wake: Wake): string =>
  write(wake, "0".repeat(NONCE_BYTES * 2)).text;

/**
 * Renders a wake as the message dispatched to the bot's session.
 *
 * The nonce for `data-` blocks comes from {@link SecureRandom}, drawn so that
 * no content quotes it ({@link withFreshNonce}).
 */
export const renderWake = (wake: Wake): Effect.Effect<string, never, SecureRandom.SecureRandom> =>
  withFreshNonce((nonce) => write(wake, nonce));
