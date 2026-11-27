// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ApprovalDecision,
  Attachment,
  BotId,
  BrowserTabRef,
  CommandId,
  ConnectorAuthEntry,
  ConversationMention,
  ElicitationAnswer,
  Mentions,
  EntryId,
  ListingRef,
  MessageQuote,
  QuestionAnswers,
  ReactionEmoji,
  Room,
  RoomId,
  RoutineId,
  WorkImageId,
  WorkStep,
} from "@j3-bots/contracts";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import type {
  IntentResult,
  MentionLabel,
  Readdressing,
  Revealed,
  RoutineCardCommand,
} from "@j3-bots/client-runtime";
import {
  type CardEntry,
  conversationMentionables,
  isQuotable,
  type QuotableMessage,
  takesReply,
  replyTo,
  conversationMentionNames,
  mentionLabel,
  latestOfLine,
  mentionedNames,
  mentionedWhoLeft,
  namedNoLonger,
  type OpeningHold,
  type OwnAppClient,
  type OwnAppSetup,
  type SecretRequestValues,
  type TimelineItem,
  trackTrigger,
} from "@j3-bots/client-runtime/presentation";
import { useBots, useI18n, useRooms } from "../app/context";
import { resendLabel } from "@j3-bots/client-runtime/wording";
import { cn } from "../lib/cn";
import { reducedMotion } from "../lib/motion";
import { ApprovalCard } from "./ApprovalCard";
import { ConnectorAuthCard } from "./connectors/ConnectorCards";
import { ConnectorAskCard } from "./connectors/ConnectorAskCard";
import { ConnectorInputCard } from "./connectors/ConnectorInputCard";
import { AnsweringLine } from "./AnsweringLine";
import { RoomWork } from "./RoomWork";
import { EventLine, type OpenPair } from "./EventLine";
import { OpenMention } from "./MentionChip";
import { MessageBubble } from "./MessageBubble";
import { NeedsUpdateLine, NoticeLine } from "./NoticeLine";
import { QuestionCard } from "./QuestionCard";
import { QuoteOnSelection } from "./QuoteOnSelection";
import { type GoToQuote, lightSource, OpenQuote } from "./Quotes";
import { RoutineTrack } from "./RoutineTrack";
import { BrowserHelpCard } from "./BrowserHelpCard";
import { SecretAskCard } from "./SecretAskCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { type ConnectorAppAccess, ConnectorAppBlock } from "./ConnectorAppCard";
import type { SecretsAccess } from "./secrets/parts";
import { TimeDivider } from "./TimeDivider";
import { type TurnBot, WorkFold } from "./WorkFold";

/** What the operator can do from a timeline. Each is an intent; the client runtime carries it out. */
export interface TimelineIntents {
  readonly answerQuestion: (entryId: EntryId, answers: QuestionAnswers) => void;
  readonly dismissQuestion: (entryId: EntryId) => void;
  readonly decideApproval: (entryId: EntryId, decision: ApprovalDecision) => void;
  readonly provideSecret: (entryId: EntryId, answer: SecretRequestValues) => void;
  readonly declineSecret: (entryId: EntryId) => void;
  /** The operator did the step a bot asked for in its browser, or could not. */
  readonly answerBrowserHelp: (entryId: EntryId, outcome: "done" | "declined") => void;
  /** Opens the bot's browser on `tab`, or on its front tab once that one closed. */
  readonly openBrowser: (botId: BotId, tab: BrowserTabRef | "front") => void;
  /** Declines a bot's ask for a secret; saving one goes to the secrets themselves. */
  readonly declineSecretAsk: (entryId: EntryId) => void;
  readonly retryNotice: (entryId: EntryId) => void;
  readonly retryMessage: (entryId: EntryId) => void;
  /** Sets the operator's reaction on a message, or takes it off with `null`. */
  readonly react: (entryId: EntryId, emoji: ReactionEmoji | null) => void;
  /**
   * Sends again a message this device could not send, addressed as
   * `readdressing` says in place of its own when given.
   */
  readonly resendMessage: (commandId: CommandId, readdressing?: Readdressing) => void;
  /** Takes a message this device could not send out of the conversation. */
  readonly discardMessage: (commandId: CommandId) => void;
  /** A fold opened: its steps are worth reading until it closes. */
  readonly openWorkFold: (entryId: EntryId) => void;
  readonly closeWorkFold: (entryId: EntryId) => void;
  readonly openAttachment: (attachment: Attachment) => void;
  /** Shows large an image a step of a bot's work looked at. */
  readonly openWorkImage: (id: WorkImageId) => void;
  readonly openRoutine: (routineId: RoutineId) => void;
  /**
   * The operator's yes or no to a routine's run, its Try again, or its Stop,
   * on the run's card; `name` is the routine's, which a failure names.
   */
  readonly routineCard: (entryId: EntryId, name: string, command: RoutineCardCommand) => void;
  readonly openConversation: (botId: BotId) => void;
  /** Opens the connector's page with its sign-in started. */
  readonly signInConnector: (entry: ConnectorAuthEntry) => void;
  /** The operator's answer to a connector's request, for its server only. */
  readonly answerConnectorInput: (entryId: EntryId, answer: ElicitationAnswer) => void;
  /** Opens the page a connector's server asked the operator to open. */
  readonly openConnectorPage: (url: string) => void;
  /** An own app's setup, for a bot's ask to add a gallery entry that signs in with one. */
  readonly connectorAskSetup: (listing: ListingRef) => Promise<IntentResult<OwnAppSetup>>;
  /** The operator's yes to a bot's ask to add a connector, with their app's client when it takes one. */
  readonly allowConnectorAsk: (entryId: EntryId, client: OwnAppClient | null) => void;
  readonly declineConnectorAsk: (entryId: EntryId) => void;
  /** The apps connectors' tools opened, which the bots' replies show. */
  readonly connectorApp: ConnectorAppAccess;
}

/**
 * Reply and Quote (decision 0094), which add to the draft of the conversation
 * shown, where the server takes quotes and the operator can write there.
 */
export interface QuoteDrafting {
  /** What the draft quotes now. */
  readonly drafted: ReadonlyArray<MessageQuote>;
  /** Adds a reply or a passage to the draft, and takes the operator to the composer. */
  readonly quote: (quote: MessageQuote) => void;
}

/** What a timeline does with quotes. */
interface TimelineQuotes {
  /** Reads back until the quoted message `entryId` is held, which a card then goes to. */
  readonly reveal: (entryId: EntryId) => Promise<Revealed>;
  /** Null where Reply and Quote are not offered. */
  readonly drafting: QuoteDrafting | null;
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
  /** Opens the room a line of a bot's team, or a mention, names. */
  readonly onOpenRoom: (roomId: RoomId) => void;
  /** Opens the conversation of the bot a mention names. */
  readonly onOpenBot: (botId: BotId) => void;
  readonly quotes: TimelineQuotes;
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
  onOpenBot,
  quotes,
}: TimelineProps) {
  const bots = useBots();
  const rooms = useRooms();
  const i18n = useI18n();
  const { t } = i18n;
  const nameOf = (botId: BotId) => bots.get(botId)?.profile.name;
  const nameOfNamed = (named: ConversationMention) =>
    named._tag === "bot" ? nameOf(named.botId) : rooms.get(named.roomId)?.name;
  // A room message highlights only whom it addressed, and one in a bot's conversation what it
  // mentions, by the names they were picked by when known.
  const highlighted = (
    message: {
      readonly mentions: Mentions | null;
      readonly conversationMentions?: ReadonlyArray<ConversationMention>;
    },
    labels: ReadonlyArray<MentionLabel>,
  ) =>
    room === null
      ? conversationMentionNames(message.conversationMentions, labels, nameOfNamed)
      : mentionedNames(message.mentions, labels, nameOf);
  const openMention = (named: ConversationMention) =>
    named._tag === "bot" ? onOpenBot(named.botId) : onOpenRoom(named.roomId);

  // The messages that can be quoted, by id, for a selection of their text.
  const quotable = new Map<string, QuotableMessage>();
  for (const item of rows) {
    if (item.kind === "message" && item.message._tag === "message" && isQuotable(item.message)) {
      quotable.set(item.message.id, item.message);
    }
  }
  const { drafting } = quotes;
  // A reply replaces the draft's own, and takes no room when every quote is a passage.
  const replyFull = drafting !== null && !takesReply(drafting.drafted);

  // A quote's card reads back to its message, then brings it into view, once its row is drawn,
  // and lights it.
  const own = useRef<HTMLDivElement>(null);
  const [goingTo, setGoingTo] = useState<EntryId | null>(null);
  const goToQuote: GoToQuote = (entryId) =>
    quotes.reveal(entryId).then((revealed) => {
      if (revealed === "shown") setGoingTo(entryId);
      return revealed;
    });
  const goingToRow =
    goingTo !== null &&
    rows.some(
      (item) =>
        item.kind === "message" && item.message._tag === "message" && item.message.id === goingTo,
    )
      ? goingTo
      : null;
  useLayoutEffect(() => {
    if (goingToRow === null) return;
    const row = own.current?.querySelector(`[data-seen-id="${CSS.escape(goingToRow)}"]`);
    if (row === null || row === undefined) return;
    row.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    const bubble = row.firstElementChild;
    if (bubble instanceof HTMLElement) bubble.focus({ preventScroll: true });
    lightSource(row);
    setGoingTo(null);
  }, [goingToRow]);

  return (
    <OpenMention value={openMention}>
      <OpenQuote value={goToQuote}>
        <div ref={own} className="flex flex-col">
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
                    onOpenImage={intents.openWorkImage}
                    onOpenChange={(open) => {
                      if (fold === null) return;
                      if (open) intents.openWorkFold(fold.id);
                      else intents.closeWorkFold(fold.id);
                    }}
                  />
                </div>
              );
            }
            if (item.kind === "app") {
              return (
                <div key={item.key} data-seen-id={item.id} className={settles}>
                  <ConnectorAppBlock app={item.app} access={intents.connectorApp} />
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
                const { status, target } = message;
                const left =
                  room === null || status._tag !== "not-sent"
                    ? null
                    : mentionedWhoLeft(status.failure, message.mentions, room.members);
                // Refused in a bot's conversation for what it mentions: Retry leaves out what `@`
                // no longer offers there, as a room archived since the pick.
                const noLonger =
                  target._tag !== "conversation" || status._tag !== "not-sent"
                    ? null
                    : namedNoLonger(
                        status.failure,
                        message.conversationMentions,
                        conversationMentionables(
                          target.botId,
                          [...bots.values()],
                          [...rooms.values()],
                        ),
                      );
                // A member who left is named as the operator picked it, which the message keeps.
                const labelOf = (botId: BotId) =>
                  message.labels.find((label) => "botId" in label && label.botId === botId)
                    ?.label ??
                  nameOf(botId) ??
                  t("bot.unknown");
                return (
                  <div key={item.key}>
                    <MessageBubble
                      message={message}
                      position={item.position}
                      arriving={arriving}
                      {...(flyFrom === undefined ? {} : { flyFrom })}
                      mentionable={highlighted(message, message.labels)}
                      onOpenAttachment={intents.openAttachment}
                      onRetry={() =>
                        left !== null
                          ? intents.resendMessage(message.commandId, { mentions: left.without })
                          : noLonger !== null
                            ? intents.resendMessage(message.commandId, noLonger.without)
                            : intents.resendMessage(message.commandId)
                      }
                      onDiscard={() => intents.discardMessage(message.commandId)}
                      {...(left !== null && room !== null
                        ? {
                            refusedMentions: { _tag: "left-room", names: left.left.map(labelOf) },
                            retryLabel: resendLabel(left.without, nameOf, i18n),
                          }
                        : noLonger !== null
                          ? {
                              refusedMentions: {
                                _tag: "not-mentionable",
                                names: noLonger.gone.map(
                                  (of) =>
                                    mentionLabel(of, message.labels, nameOfNamed) ??
                                    t(of._tag === "bot" ? "bot.unknown" : "room.unknown"),
                                ),
                              },
                            }
                          : {})}
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
                    // The server's entry keeps no names picked: what it mentions goes by its name now.
                    mentionable={highlighted(message, [])}
                    onOpenAttachment={intents.openAttachment}
                    onRetry={() => intents.retryMessage(message.id)}
                    onReact={(emoji) => intents.react(message.id, emoji)}
                    {...(drafting !== null && isQuotable(message)
                      ? {
                          reply: {
                            onReply: () => drafting.quote(replyTo(message)),
                            full: replyFull,
                          },
                        }
                      : {})}
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
          {room !== null && <RoomWork room={room} />}
          {room !== null && <AnsweringLine room={room} />}
          {drafting !== null && (
            <QuoteOnSelection
              scope={own}
              messageOf={(id) => quotable.get(id)}
              drafted={drafting.drafted}
              onQuote={drafting.quote}
            />
          )}
        </div>
      </OpenQuote>
    </OpenMention>
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
          onProvide={(answer) => intents.provideSecret(entry.id, answer)}
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
    case "connector-ask":
      return (
        <ConnectorAskCard
          entry={entry}
          setup={intents.connectorAskSetup}
          onAllow={(client) => intents.allowConnectorAsk(entry.id, client)}
          onDecline={() => intents.declineConnectorAsk(entry.id)}
          onOpenPage={intents.openConnectorPage}
          submitting={submitting(entry.id)}
        />
      );
    case "routine-change":
    case "event-routine-change":
      return (
        <RoutineTrack
          entryId={entry.id}
          name={entry.name}
          trigger={
            entry._tag === "event-routine-change"
              ? trackTrigger(entry.trigger, entry.connector)
              : entry.trigger
          }
          owner={entry.author._tag === "bot" ? entry.author.botId : null}
          steps={entry.steps}
          run={null}
        />
      );
    case "routine-run":
    case "event-routine-run": {
      const { run } = entry;
      return (
        <RoutineTrack
          entryId={entry.id}
          name={entry.name}
          trigger={
            entry._tag === "event-routine-run"
              ? trackTrigger(entry.trigger, entry.connector)
              : entry.trigger
          }
          owner={entry.author.botId}
          steps={[]}
          run={run}
          submitting={submitting(entry.id)}
          onAnswer={(step, choice, note) =>
            intents.routineCard(entry.id, entry.name, {
              _tag: "answer",
              runId: run.id,
              step,
              choice,
              note,
            })
          }
          onRetry={() =>
            intents.routineCard(entry.id, entry.name, { _tag: "retry", runId: run.id })
          }
          onStop={() => intents.routineCard(entry.id, entry.name, { _tag: "stop", runId: run.id })}
        />
      );
    }
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
