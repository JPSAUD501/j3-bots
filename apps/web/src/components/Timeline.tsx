// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalDecision,
  Attachment,
  BotId,
  BrowserTabRef,
  CommandId,
  Mentions,
  Entry,
  EntryId,
  MessageEntry,
  QuestionAnswers,
  Room,
  RoutineId,
  WorkFoldEntry,
  WorkStep,
} from "@j3-bots/contracts";
import type * as Redacted from "effect/Redacted";
import type { RefObject } from "react";
import type { MentionLabel } from "@j3-bots/client-runtime";
import {
  addresseeOf,
  mentionedNames,
  mentionedWhoLeft,
  type OpeningHold,
  type TimelineItem,
} from "@j3-bots/client-runtime/presentation";
import { useBots, useI18n } from "../app/context";
import { resendLabel } from "@j3-bots/client-runtime/wording";
import { cn } from "../lib/cn";
import { ApprovalCard } from "./ApprovalCard";
import { HandoffCard } from "./HandoffCard";
import { MessageBubble } from "./MessageBubble";
import { NeedsUpdateLine, NoticeLine } from "./NoticeLine";
import { QuestionCard } from "./QuestionCard";
import { RoutineChangeCard } from "./RoutineChangeCard";
import { BrowserHelpCard } from "./BrowserHelpCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { TimeDivider } from "./TimeDivider";
import { type TurnBot, WorkFold } from "./WorkFold";

/** What the operator can do from a timeline. Each is an intent; the client runtime carries it out. */
export interface TimelineIntents {
  readonly answerQuestion: (entryId: EntryId, answers: QuestionAnswers) => void;
  readonly dismissQuestion: (entryId: EntryId) => void;
  readonly decideApproval: (entryId: EntryId, decision: ApprovalDecision) => void;
  readonly provideSecret: (entryId: EntryId, value: Redacted.Redacted<string>) => void;
  readonly declineSecret: (entryId: EntryId) => void;
  /** The operator did the step a bot asked for in its browser, or could not. */
  readonly answerBrowserHelp: (entryId: EntryId, outcome: "done" | "declined") => void;
  /** Opens the bot's browser on `tab`, or on its front tab once that one closed. */
  readonly openBrowser: (botId: BotId, tab: BrowserTabRef | "front") => void;
  readonly retryNotice: (entryId: EntryId) => void;
  readonly retryMessage: (entryId: EntryId) => void;
  /**
   * Sends again a message this device could not send, with `mentions` in
   * place of its own when given.
   */
  readonly resendMessage: (commandId: CommandId, mentions?: Mentions) => void;
  /** Takes a message this device could not send out of the conversation. */
  readonly discardMessage: (commandId: CommandId) => void;
  /** A fold opened: its steps are worth reading until it closes. */
  readonly openWorkFold: (entryId: EntryId) => void;
  readonly closeWorkFold: (entryId: EntryId) => void;
  readonly openAttachment: (attachment: Attachment) => void;
  readonly openHandoff: (entryId: EntryId) => void;
  readonly openRoutine: (routineId: RoutineId) => void;
  readonly openConversation: (botId: BotId) => void;
}

interface TimelineProps {
  /**
   * The conversation's rows (`buildTimeline`): entries oldest first, then the
   * operator's messages still on their way.
   */
  readonly rows: ReadonlyArray<TimelineItem>;
  /**
   * In a room, its members and host now: rooms show who said each message and
   * whom it addressed, and a message refused for mentioning a member who left
   * says so, and where Send again sends it. Null in a bot's conversation,
   * which has one speaker.
   */
  readonly room: Pick<Room, "members" | "hostId"> | null;
  readonly workSteps: (entryId: EntryId) => ReadonlyArray<WorkStep> | null;
  /** Whether the operator's answer to a card is still on its way. */
  readonly submitting: (entryId: EntryId) => boolean;
  /** What holds the bot's hello back, which the operator's messages behind it wait for (`openingHeld`). */
  readonly openingHold?: OpeningHold | null;
  readonly intents: TimelineIntents;
  /** The rows that just arrived at the end, by key: they settle into place as they mount. */
  readonly arrived?: ReadonlySet<string>;
  /** Where the operator's messages fly from as they arrive: the composer's field. */
  readonly flyFrom?: RefObject<HTMLElement | null>;
  /**
   * In a bot's conversation, the bot: the row of its turn under way says
   * what it is doing (`withLiveTurn`). Null in a room.
   */
  readonly turnBot?: TurnBot | null;
}

/**
 * Every entry of a conversation or room, oldest first: bubbles, cards, folds
 * and notices, and a line for each of a kind this version does not know.
 */
export function Timeline({
  rows,
  room,
  workSteps,
  submitting,
  openingHold = null,
  intents,
  arrived,
  flyFrom,
  turnBot = null,
}: TimelineProps) {
  const bots = useBots();
  const i18n = useI18n();
  const { t } = i18n;
  const nameOf = (botId: BotId) => bots.get(botId)?.profile.name;
  // In a room, a message highlights only whom it addressed, by the names it was picked by when known.
  const highlighted = (mentions: Mentions | null, labels: ReadonlyArray<MentionLabel>) =>
    room === null ? [] : mentionedNames(mentions, labels, nameOf);
  return (
    <div className="flex flex-col">
      {rows.map((item) => {
        const arriving = arrived?.has(item.key) === true;
        // What is not a message settles in as it mounts; a message moves itself.
        const settles = cn(arriving && "arrive origin-bottom-left");
        if (item.kind === "divider") {
          return (
            <div key={item.key} className={settles}>
              <TimeDivider at={item.at} />
            </div>
          );
        }
        if (item.kind === "work") {
          const { fold } = item;
          return (
            <div
              key={item.key}
              {...(fold === null ? {} : { "data-seen-id": fold.id })}
              className={cn(arriving && "arrive-pop origin-left")}
            >
              <WorkFold
                fold={fold}
                live={item.live ? turnBot : null}
                steps={fold === null ? null : workSteps(fold.id)}
                onOpenChange={(open) => {
                  if (fold === null) return;
                  if (open) intents.openWorkFold(fold.id);
                  else intents.closeWorkFold(fold.id);
                }}
              />
            </div>
          );
        }
        if (item.kind === "unknown") {
          return (
            <div key={item.key} data-seen-id={item.id} className={settles}>
              <NeedsUpdateLine />
            </div>
          );
        }
        if (item.kind === "message") {
          const { message } = item;
          // One element, under one key, from Send to the server's entry, so
          // nothing in the bubble loses focus when the entry arrives; the entry
          // id it gains then makes it count toward the read mark.
          if (message._tag === "outgoing") {
            const left =
              room === null || message.status._tag !== "not-sent"
                ? null
                : mentionedWhoLeft(message.status.failure, message.mentions, room.members);
            // A member who left is named as the operator picked it, which the message keeps.
            const labelOf = (botId: BotId) =>
              message.labels.find((label) => label.botId === botId)?.label ??
              nameOf(botId) ??
              t("bot.unknown");
            return (
              <div key={item.key}>
                <MessageBubble
                  message={message}
                  position={item.position}
                  arriving={arriving}
                  {...(flyFrom === undefined ? {} : { flyFrom })}
                  mentionable={highlighted(message.mentions, message.labels)}
                  onOpenAttachment={intents.openAttachment}
                  onRetry={() =>
                    left === null
                      ? intents.resendMessage(message.commandId)
                      : intents.resendMessage(message.commandId, left.without)
                  }
                  onDiscard={() => intents.discardMessage(message.commandId)}
                  {...(left === null || room === null
                    ? {}
                    : {
                        leftRoom: left.left.map(labelOf),
                        retryLabel: resendLabel(
                          addresseeOf(left.without, room.hostId, nameOf, i18n),
                          i18n,
                        ),
                      })}
                />
              </div>
            );
          }
          const { author } = message;
          const speaker = author._tag === "bot" ? (bots.get(author.botId) ?? null) : null;
          return (
            <div key={item.key} data-seen-id={message.id}>
              <MessageBubble
                message={message}
                position={item.position}
                arriving={arriving}
                tint={speaker?.profile.avatar ?? null}
                speaker={room === null ? null : speaker}
                // The server's entry keeps no names picked: its members go by their names now.
                mentionable={highlighted(message.mentions, [])}
                onOpenAttachment={intents.openAttachment}
                onRetry={() => intents.retryMessage(message.id)}
                submitting={submitting(message.id)}
                openingHold={openingHold}
              />
            </div>
          );
        }
        const { entry } = item;
        return (
          <div key={item.key} data-seen-id={entry.id} className={settles}>
            <Card entry={entry} submitting={submitting} intents={intents} />
          </div>
        );
      })}
    </div>
  );
}

/** One card or notice: every entry that is neither a message nor a turn's work. */
function Card({
  entry,
  submitting,
  intents,
}: {
  entry: Exclude<Entry, MessageEntry | WorkFoldEntry>;
  submitting: TimelineProps["submitting"];
  intents: TimelineIntents;
}) {
  switch (entry._tag) {
    case "question":
      return (
        <QuestionCard
          entry={entry}
          onAnswer={(answers) => intents.answerQuestion(entry.id, answers)}
          onDismiss={() => intents.dismissQuestion(entry.id)}
          submitting={submitting(entry.id)}
        />
      );
    case "approval":
      return (
        <ApprovalCard
          entry={entry}
          onDecide={(decision) => intents.decideApproval(entry.id, decision)}
          submitting={submitting(entry.id)}
        />
      );
    case "secret-request":
      return (
        <SecretRequestCard
          entry={entry}
          onProvide={(value) => intents.provideSecret(entry.id, value)}
          onDecline={() => intents.declineSecret(entry.id)}
          submitting={submitting(entry.id)}
        />
      );
    case "browser-help":
      return (
        <BrowserHelpCard
          entry={entry}
          onOpen={() => intents.openBrowser(entry.author.botId, entry.tab)}
          onDone={() => intents.answerBrowserHelp(entry.id, "done")}
          onDecline={() => intents.answerBrowserHelp(entry.id, "declined")}
          submitting={submitting(entry.id)}
        />
      );
    case "notice":
      return (
        <NoticeLine
          entry={entry}
          onRetry={() => intents.retryNotice(entry.id)}
          onOpenConversation={() => {
            if (entry.notice._tag === "waiting-in-conversation") {
              intents.openConversation(entry.notice.botId);
            }
          }}
        />
      );
    case "handoff":
      return <HandoffCard entry={entry} onOpen={() => intents.openHandoff(entry.id)} />;
    case "routine-change":
      return (
        <RoutineChangeCard entry={entry} onOpen={() => intents.openRoutine(entry.routineId)} />
      );
  }
}
