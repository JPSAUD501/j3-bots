// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EntryId, PairBotIds, PairSeq, TeammateMessage } from "@j3-bots/contracts";
import {
  buildPairTimeline,
  clockTime,
  type GroupPosition,
  pairKeyText,
  pairMessageKey,
} from "@j3-bots/client-runtime/presentation";
import { type EventMark, handoffMarks, pairTitle } from "@j3-bots/client-runtime/wording";
import { LockIcon } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useBot, usePresentation } from "../app/context";
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { FaceOf, PairAvatar } from "./avatar/TeamAvatars";
import { Centered, Heading } from "./EmptyStates";
import { botCorners } from "./MessageBubble";
import { MessageText } from "./MessageText";
import { type PairIntents, PairHeader } from "./PairHeader";
import { SpeakerFace, SpeakerName, speakerGutter } from "./Speaker";
import { TimeDivider } from "./TimeDivider";
import { Button } from "./ui/button";

/** A teammate conversation as the shell shows it. */
export interface PairView {
  readonly phase: "loading" | "ready";
  /** Oldest first. */
  readonly messages: ReadonlyArray<TeammateMessage>;
  /** There are messages before the first one held. */
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}

interface PairConversationProps {
  readonly botIds: PairBotIds;
  readonly view: PairView;
  /**
   * A card of one of the two bots' conversations to open the conversation
   * at, as a line there asks: its message is brought into view.
   */
  readonly at: EntryId | null;
  readonly intents: PairIntents;
  readonly onLoadOlder: () => void;
  /** Reads back to the message of the card `entryId`: its `seq`, or null when there is none. */
  readonly onReveal: (entryId: EntryId) => Promise<PairSeq | null>;
  /** Phones only: back to the roster. */
  readonly onBack: () => void;
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
}

/**
 * What two bots wrote each other, laid out as a room is: each bot's name over
 * its run of messages, its face beside the last, a time between quiet
 * stretches. The operator reads it and writes nothing: "Read-only" stands
 * where the composer would, and the header leads to either bot or a room
 * with both.
 */
export function PairConversation({
  botIds,
  view,
  at,
  intents,
  onLoadOlder,
  onReveal,
  onBack,
  titleRef,
}: PairConversationProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const items = useMemo(() => buildPairTimeline(view.messages), [view.messages]);
  const scroller = useRef<HTMLDivElement>(null);

  // Opened at a line of a bot's conversation: read back to its message, then bring it into view.
  const [revealed, setRevealed] = useState<PairSeq | null>(null);
  const reveal = useEffectEvent(
    (entryId: EntryId, done: (seq: PairSeq | null) => void) => void onReveal(entryId).then(done),
  );
  const ready = view.phase === "ready";
  useEffect(() => {
    if (at === null || !ready) return;
    let live = true;
    reveal(at, (seq) => {
      if (live) setRevealed(seq);
    });
    return () => {
      live = false;
    };
  }, [at, ready]);
  // Once its row is drawn.
  const revealedRow =
    revealed !== null && items.some((item) => item.key === pairMessageKey(revealed))
      ? pairMessageKey(revealed)
      : null;
  useLayoutEffect(() => {
    if (revealedRow === null) return;
    const row = scroller.current?.querySelector<HTMLElement>(`[data-pair-key="${revealedRow}"]`);
    if (row === null || row === undefined) return;
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
    setRevealed(null);
  }, [revealedRow]);

  return (
    <>
      <PairHeader botIds={botIds} intents={intents} onBack={onBack} titleRef={titleRef} />
      {ready && view.messages.length === 0 ? (
        <Centered>
          <span className="pop-in">
            <PairAvatar botIds={botIds} size={96} />
          </span>
          <Heading title={pairTitle(botIds, ctx)} body={t("pairs.empty")} />
        </Centered>
      ) : (
        // Reversed, so the view opens at the newest message; one per pair, so each opens at its own end.
        <div
          key={`pair:${pairKeyText(botIds)}`}
          ref={scroller}
          className="conversation-open flex min-h-0 flex-1 flex-col-reverse overflow-y-auto [overflow-anchor:auto]"
        >
          <div className="mx-auto w-full max-w-(--layout-text-column) px-3 py-4 @tablet:px-6">
            {view.hasOlder && (
              <div className="flex justify-center pb-2">
                <Button
                  variant="ghost-muted"
                  size="sm"
                  aria-disabled={view.loadingOlder}
                  onClick={() => {
                    if (!view.loadingOlder) onLoadOlder();
                  }}
                >
                  {view.loadingOlder ? t("timeline.loadingOlder") : t("timeline.loadOlder")}
                </Button>
              </div>
            )}
            <div className="flex flex-col">
              {items.map((item) =>
                item.kind === "divider" ? (
                  <TimeDivider key={item.key} at={item.at} />
                ) : (
                  <PairMessage
                    key={item.key}
                    rowKey={item.key}
                    message={item.message}
                    position={item.position}
                  />
                ),
              )}
            </div>
          </div>
        </div>
      )}
      <ReadOnly />
    </>
  );
}

const markTone: Record<EventMark["tone"], string> = {
  waiting: "text-waiting",
  blocked: "text-blocked",
  quiet: "text-muted-foreground",
};

/**
 * One message between the two, in its sender's tint. Read aloud whole: who
 * wrote it, what it says, and whether it was urgent or never arrived.
 */
function PairMessage({
  rowKey,
  message,
  position,
}: {
  rowKey: string;
  message: TeammateMessage;
  position: GroupPosition;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const sender = useBot(message.from);
  const name = sender?.profile.name ?? t("bot.unknown");
  const marks = handoffMarks(message, ctx.i18n);
  const startsGroup = position === "single" || position === "first";
  return (
    <div
      data-pair-key={rowKey}
      tabIndex={-1}
      className={cn(
        "flex scroll-my-4 flex-col items-start gap-1 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        startsGroup ? "mt-3" : "mt-1",
      )}
    >
      {/* The face sits beside the bubble, not beside the marks under it. */}
      <div className={cn("flex flex-col items-start gap-1 self-stretch", speakerGutter)}>
        <span aria-hidden className="contents">
          <SpeakerName position={position} name={name} title={sender?.profile.title ?? ""} />
        </span>
        <SpeakerFace position={position}>
          <FaceOf botId={message.from} size={28} />
        </SpeakerFace>
        <div
          title={clockTime(message.createdAt, ctx)}
          className={cn(
            "max-w-(--layout-bubble-width) rounded-bubble px-3.5 py-2 text-base pointer-coarse:text-lg",
            tintOf(sender?.profile.avatar ?? null),
            "bg-(--tint-bubble) text-bubble-bot-foreground",
            botCorners[position],
          )}
        >
          <span className="sr-only">{`${name}: `}</span>
          <MessageText text={message.text} />
        </div>
      </div>
      {marks.length > 0 && (
        <p className="flex gap-2 ps-10 text-2xs font-medium">
          {marks.map((mark) => (
            <span key={mark.text} className={markTone[mark.tone]}>
              {mark.text}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** Where the composer would be: the operator reads this conversation and writes nothing in it. */
function ReadOnly() {
  const { t } = usePresentation().i18n;
  return (
    <div className="flex justify-center px-3 pt-1 pb-[max(--spacing(3),env(safe-area-inset-bottom))]">
      <p className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3.5 py-2 text-xs text-muted-foreground">
        <LockIcon aria-hidden className="size-3.5" />
        {t("pairs.readOnly")}
      </p>
    </div>
  );
}
