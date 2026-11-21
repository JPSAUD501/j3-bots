// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalDecision,
  Attachment,
  BotId,
  CommandId,
  Mentions,
  Entry,
  EntryId,
  MessageEntry,
  QuestionAnswers,
  Room,
  RoutineId,
  WorkStep,
} from "@j3-bots/contracts";
import type { ConversationItem, MentionLabel } from "@j3-bots/client-runtime";
import type * as Redacted from "effect/Redacted";
import { useBots, useI18n } from "../app/context";
import {
  addresseeOf,
  mentionedNames,
  mentionedWhoLeft,
  resendLabel,
} from "../presentation/mentions";
import { buildTimeline } from "../presentation/timeline";
import { ApprovalCard } from "./ApprovalCard";
import { HandoffCard } from "./HandoffCard";
import { MessageBubble } from "./MessageBubble";
import { NoticeLine } from "./NoticeLine";
import { QuestionCard } from "./QuestionCard";
import { RoutineChangeCard } from "./RoutineChangeCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { TimeDivider } from "./TimeDivider";
import { WorkFold } from "./WorkFold";

/** What the operator can do from a timeline. Each is an intent; the client runtime carries it out. */
export interface TimelineIntents {
  readonly answerQuestion: (entryId: EntryId, answers: QuestionAnswers) => void;
  readonly dismissQuestion: (entryId: EntryId) => void;
  readonly decideApproval: (entryId: EntryId, decision: ApprovalDecision) => void;
  readonly provideSecret: (entryId: EntryId, value: Redacted.Redacted<string>) => void;
  readonly declineSecret: (entryId: EntryId) => void;
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
  /** Entries oldest first, then the operator's messages still on their way. */
  readonly entries: ReadonlyArray<ConversationItem>;
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
  readonly intents: TimelineIntents;
}

/** Every entry of a conversation or room, oldest first: bubbles, cards, folds and notices. */
export function Timeline({ entries, room, workSteps, submitting, intents }: TimelineProps) {
  const bots = useBots();
  const i18n = useI18n();
  const { t } = i18n;
  const nameOf = (botId: BotId) => bots.get(botId)?.profile.name;
  // In a room, a message highlights only whom it addressed, by the names it was picked by when known.
  const highlighted = (mentions: Mentions | null, labels: ReadonlyArray<MentionLabel>) =>
    room === null ? [] : mentionedNames(mentions, labels, nameOf);
  return (
    <div className="flex flex-col">
      {buildTimeline(entries).map((item) => {
        if (item.kind === "divider") return <TimeDivider key={item.key} at={item.at} />;
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
          return (
            <div key={item.key} data-seen-id={message.id}>
              <MessageBubble
                message={message}
                position={item.position}
                speaker={
                  room !== null && author._tag === "bot" ? (bots.get(author.botId) ?? null) : null
                }
                // The server's entry keeps no names picked: its members go by their names now.
                mentionable={highlighted(message.mentions, [])}
                onOpenAttachment={intents.openAttachment}
                onRetry={() => intents.retryMessage(message.id)}
                submitting={submitting(message.id)}
              />
            </div>
          );
        }
        const { entry } = item;
        return (
          <div key={item.key} data-seen-id={entry.id}>
            <Card entry={entry} submitting={submitting} workSteps={workSteps} intents={intents} />
          </div>
        );
      })}
    </div>
  );
}

/** One card, notice or fold: every entry that is not a message. */
function Card({
  entry,
  submitting,
  workSteps,
  intents,
}: {
  entry: Exclude<Entry, MessageEntry>;
  submitting: TimelineProps["submitting"];
  workSteps: TimelineProps["workSteps"];
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
    case "work-fold":
      return (
        <WorkFold
          entry={entry}
          steps={workSteps(entry.id)}
          onOpenChange={(open) =>
            open ? intents.openWorkFold(entry.id) : intents.closeWorkFold(entry.id)
          }
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
