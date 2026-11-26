// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalDecision,
  Attachment,
  BotId,
  BrowserTabRef,
  CommandId,
  ConnectorAuthEntry,
  ElicitationAnswer,
  Mentions,
  EntryId,
  QuestionAnswers,
  Room,
  RoomId,
  RoutineId,
  WorkStep,
} from "@j3-bots/contracts";
import type * as Redacted from "effect/Redacted";
import type { ReactNode, RefObject } from "react";
import type { MentionLabel } from "@j3-bots/client-runtime";
import {
  type CardEntry,
  latestOfLine,
  mentionedNames,
  mentionedWhoLeft,
  type OpeningHold,
  type TimelineItem,
} from "@j3-bots/client-runtime/presentation";
import { useBots, useI18n } from "../app/context";
import { resendLabel } from "@j3-bots/client-runtime/wording";
import { cn } from "../lib/cn";
import { ApprovalCard } from "./ApprovalCard";
import { ConnectorAuthCard } from "./connectors/ConnectorCards";
import { ConnectorInputCard } from "./connectors/ConnectorInputCard";
import { AnsweringLine } from "./AnsweringLine";
import { EventLine, type OpenPair } from "./EventLine";
import { MessageBubble } from "./MessageBubble";
import { NeedsUpdateLine, NoticeLine } from "./NoticeLine";
import { QuestionCard } from "./QuestionCard";
import { BrowserHelpCard } from "./BrowserHelpCard";
import { SecretAskCard } from "./SecretAskCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { type ConnectorAppAccess, ConnectorApps } from "./ConnectorAppCard";
import type { SecretsAccess } from "./secrets/parts";
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
  /** Declines a bot's ask for a secret; saving one goes to the secrets themselves. */
  readonly declineSecretAsk: (entryId: EntryId) => void;
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
  readonly openRoutine: (routineId: RoutineId) => void;
  readonly openConversation: (botId: BotId) => void;
  /** Opens the connector's page with its sign-in started. */
  readonly signInConnector: (entry: ConnectorAuthEntry) => void;
  /** The operator's answer to a connector's request, for its server only. */
  readonly answerConnectorInput: (entryId: EntryId, answer: ElicitationAnswer) => void;
  /** Opens the page a connector's server asked the operator to open. */
  readonly openConnectorPage: (url: string) => void;
  /** The apps connectors' tools opened, which turns' work shows. */
  readonly connectorApp: ConnectorAppAccess;
}

interface TimelineProps {
  /**
   * The conversation's rows (`buildTimeline`): entries oldest first, then the
   * operator's messages still on their way.
   */
  readonly rows: ReadonlyArray<TimelineItem>;
  /**
   * In a room, the room as it is now: rooms show who said each message and
   * whom it addressed, a message refused for mentioning a member who left
   * says so, and where Send again sends it, and the end says who is answering.
   * Null in a bot's conversation, which has one speaker.
   */
  readonly room: Room | null;
  readonly workSteps: (entryId: EntryId) => ReadonlyArray<WorkStep> | null;
  /** Whether the operator's answer to a card is still on its way. */
  readonly submitting: (entryId: EntryId) => boolean;
  /** What holds the bot's hello back, which the operator's messages behind it wait for (`openingHeld`). */
  readonly openingHold?: OpeningHold | null;
  readonly intents: TimelineIntents;
  /** The operator's secrets, which a bot's ask for one saves to. */
  readonly secrets: SecretsAccess;
  /** The rows that just arrived at the end, by key: they settle into place as they mount. */
  readonly arrived?: ReadonlySet<string>;
  /** Where the operator's messages fly from as they arrive: the composer's field. */
  readonly flyFrom?: RefObject<HTMLElement | null>;
  /**
   * In a bot's conversation, the bot: the row of its turn under way says
   * what it is doing (`withLiveTurn`). Null in a room.
   */
  readonly turnBot?: TurnBot | null;
  /** What shows under the line of the bot's turn under way, as its browser. */
  readonly turnExtra?: ReactNode;
  /** Opens the teammate conversation a line of teammate messages leads to, at that message. */
  readonly onOpenPair: OpenPair;
  /** Opens the room a line of a bot's team names. */
  readonly onOpenRoom: (roomId: RoomId) => void;
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
  secrets,
  arrived,
  flyFrom,
  turnBot = null,
  turnExtra,
  onOpenPair,
  onOpenRoom,
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
                {...(item.live && turnExtra !== undefined ? { extra: turnExtra } : {})}
                steps={fold === null ? null : workSteps(fold.id)}
                onOpenChange={(open) => {
                  if (fold === null) return;
                  if (open) intents.openWorkFold(fold.id);
                  else intents.closeWorkFold(fold.id);
                }}
              />
              {fold !== null && <ConnectorApps apps={fold.apps} access={intents.connectorApp} />}
            </div>
          );
        }
        if (item.kind === "event") {
          return (
            <div key={item.key} data-seen-id={latestOfLine(item.line).id} className={settles}>
              <EventLine
                line={item.line}
                room={room?.id ?? null}
                onOpenRoutine={intents.openRoutine}
                onOpenPair={onOpenPair}
                onOpenRoom={onOpenRoom}
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
                        retryLabel: resendLabel(left.without, nameOf, i18n),
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
                speaker={room === null || author._tag !== "bot" ? null : author.botId}
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
            <Card entry={entry} submitting={submitting} intents={intents} secrets={secrets} />
          </div>
        );
      })}
      {room !== null && <AnsweringLine room={room} />}
    </div>
  );
}

/** One card or notice: what the bot asks of the operator, or something that stopped. */
function Card({
  entry,
  submitting,
  intents,
  secrets,
}: {
  entry: CardEntry;
  submitting: TimelineProps["submitting"];
  intents: TimelineIntents;
  secrets: SecretsAccess;
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
    case "secret-ask":
      return (
        <SecretAskCard
          entry={entry}
          secrets={secrets}
          onDecline={() => intents.declineSecretAsk(entry.id)}
          submitting={submitting(entry.id)}
        />
      );
    case "connector-auth":
      return <ConnectorAuthCard entry={entry} onSignIn={() => intents.signInConnector(entry)} />;
    case "connector-input":
      return (
        <ConnectorInputCard
          entry={entry}
          onAnswer={(answer) => intents.answerConnectorInput(entry.id, answer)}
          onOpenPage={intents.openConnectorPage}
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
  }
}
