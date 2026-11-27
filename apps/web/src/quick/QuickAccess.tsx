// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, BotId, EntryId, EntryPreview, PairBotIds, RoomId } from "@j3-bots/contracts";
import { ArrowUpRightIcon, XIcon } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { targetKey } from "@j3-bots/client-runtime";
import { botStop, offeredReply, openingHeld } from "@j3-bots/client-runtime/presentation";
import {
  heldHelloText,
  presenceLine,
  quietConversationText,
} from "@j3-bots/client-runtime/wording";
import { RosterProvider, useI18n, usePresentation } from "../app/context";
import { AvatarConnection, LiveBotAvatar } from "../components/avatar/mood";
import { DraftComposer } from "../components/DraftComposer";
import { addressingOf, mentionChoicesOf } from "../components/mentionChoices";
import { toneClass } from "../components/RosterRow";
import { SwapText } from "../components/SwapText";
import { Timeline, type TimelineIntents } from "../components/Timeline";
import { scrollToEnd, ToLatest } from "../components/ToLatest";
import { Button } from "../components/ui/button";
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { useCovered } from "../lib/covered";
import { reducedMotion } from "../lib/motion";
import { sprung, type Sprung } from "../lib/sprung";
import { useConversationView } from "../shell/conversationView";
import type { ShellData, ShellIntents } from "../shell/data";
import { shellShortcuts } from "../shell/shortcuts";
import { WindowChips, type WindowChipsIntents, type WindowChipsView } from "./WindowChips";

/** What quick access shows: the shell's own data, as far as one conversation needs it. */
export type QuickAccessData = Pick<
  ShellData,
  | "roster"
  | "conversation"
  | "draft"
  | "offer"
  | "draftsLoading"
  | "draftsFailed"
  | "draftNotSaved"
  | "conversationMentions"
  | "connectors"
  | "submitting"
  | "workSteps"
  | "secrets"
  | "engine"
  | "connected"
>;

/** What the operator can ask for from quick access: the conversation's own intents. */
export type QuickAccessIntents = TimelineIntents &
  Pick<
    ShellIntents,
    | "setDraftText"
    | "attachFiles"
    | "detachFile"
    | "sendDraft"
    | "retryDrafts"
    | "restoreDraft"
    | "dismissDraftOffer"
    | "connectorPrompts"
    | "renderPrompt"
    | "loadOlder"
    | "markRead"
    | "setShown"
    | "stopBot"
    | "forceStopBot"
    | "secrets"
  >;

interface QuickAccessProps {
  /** The primary bot, and its latest entry, as the roster lists them. */
  readonly bot: Bot;
  readonly lastEntry: EntryPreview | null;
  readonly data: QuickAccessData;
  readonly intents: QuickAccessIntents;
  /**
   * The window is not see-through: the card fills it, square. Otherwise the
   * window leaves room around the card for its rounded corners and its shadow.
   */
  readonly solid: boolean;
  /** Whether it shows. It comes in as this turns true and goes out as it turns false. */
  readonly shown: boolean;
  /** Changes each time the operator asks for it again: the cursor goes to the composer. */
  readonly asked: number;
  /** The main window, at this conversation. */
  readonly onOpenConversation: () => void;
  /** The main window, at the teammate conversation a line of the timeline leads to. */
  readonly onOpenPair: (botIds: PairBotIds, at: EntryId | null) => void;
  /** The main window, at the room a line of the timeline, or a mention, names. */
  readonly onOpenRoom: (roomId: RoomId) => void;
  /** The main window, at the conversation of the bot a mention names. */
  readonly onOpenBot: (botId: BotId) => void;
  /** The operator closed it, with its button or Escape. */
  readonly onClose: () => void;
  /** It has gone out: nothing of it is on screen. */
  readonly onLeft: () => void;
  /** What the page shows over the card, as its toast: drawn inside it, so it stays on the card. */
  readonly overlay?: ReactNode;
  /** The window the operator was in as they opened it, which goes with what they send. */
  readonly window?: {
    readonly view: WindowChipsView;
    readonly intents: WindowChipsIntents;
    readonly initialPreview?: "window" | "picture";
  } | null;
}

/** How far below its place the card starts from, in px. */
const RISE = 20;
/** The face's size, in px, beside the name. */
const FACE = 36;
/** What the face grows from as it pops in. */
const FACE_FROM = 0.6;
/** How long after the card sets off the face pops in, and the card after the face on the way out, in ms. */
const FACE_AFTER = 120;

/**
 * Quick access to the primary bot: the conversation in miniature. A low
 * header with the bot's face beside its name and what it is doing, then its
 * conversation and the composer, in a small card. The conversation is the one
 * the main window shows, drawn by the same components: what is read here is
 * read there, and the draft is the same draft.
 *
 * The card rises into place and the face pops in after it; it goes out the
 * way it came. Each travels on its spring from wherever it is, so asking for
 * it again mid-way turns it around. Under reduced motion it fades. The
 * composer has the cursor from the first frame.
 */
export function QuickAccess({
  bot,
  lastEntry,
  data,
  intents,
  solid,
  shown,
  asked,
  onOpenConversation,
  onOpenPair,
  onOpenRoom,
  onOpenBot,
  onClose,
  onLeft,
  overlay,
  window: seenWindow = null,
}: QuickAccessProps) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const name = bot.profile.name;
  const target = { _tag: "conversation", botId: bot.id } as const;
  const view = data.conversation(target);
  // `@` offers what it offers in the main window's composer of this conversation.
  const roster = data.roster ?? [];
  const mentionable = mentionChoicesOf(target, roster, data.conversationMentions);
  const addressing = addressingOf(target, data.draft(target), roster, mentionable);
  const composerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const faceRef = useRef<HTMLSpanElement>(null);
  // What the card holds of the conversation, apart from its header and from
  // the toast, whose live region no dialog hides: what tells whether
  // something covers the conversation follows this element.
  const [conversation, setConversation] = useState<HTMLElement | null>(null);
  // State, not a ref: what watches the timeline follows the element.
  const [timeline, setTimeline] = useState<HTMLDivElement | null>(null);
  const { rows, arrived, end, waitingOn, waitingPlace } = useConversationView({
    selectionKey: targetKey(target),
    target,
    view,
    bot,
    timeline,
    // Read is what the operator saw: nothing is, on a card that is going out or out of sight.
    markRead: (asked, through) => {
      if (shown) intents.markRead(asked, through);
    },
  });
  const toCard = waitingPlace === "above" || waitingPlace === "below";

  // The conversation is on screen here while the card shows with nothing over it, as an
  // image opened from it would be: only then is what arrives read, and kept quiet.
  const covered = useCovered(conversation);
  const { setShown } = intents;
  const onScreen = shown && !covered;
  const botId = bot.id;
  useEffect(() => {
    setShown(onScreen ? { _tag: "conversation", botId } : null);
    return () => setShown(null);
  }, [setShown, onScreen, botId]);

  // The way in and out. `card` and `face` each go from 0, out of sight, to 1, in place.
  const left = useEffectEvent(onLeft);
  const motion = useRef<Sprung<"card" | "face"> | null>(null);
  const leaving = useRef(false);
  useLayoutEffect(() => {
    const draw = ({ card, face }: Readonly<Record<"card" | "face", number>>) => {
      const cardElement = cardRef.current;
      const faceElement = faceRef.current;
      if (cardElement === null || faceElement === null) return;
      cardElement.style.opacity = String(Math.max(0, Math.min(1, card * 1.6)));
      cardElement.style.translate = `0 ${(1 - card) * RISE}px`;
      faceElement.style.opacity = String(Math.max(0, Math.min(1, face * 1.6)));
      faceElement.style.scale = String(FACE_FROM + (1 - FACE_FROM) * Math.max(0, face));
      // Out of sight before the springs come to rest: a card that has left does not linger.
      if (leaving.current && card < 0.02 && face < 0.02) {
        leaving.current = false;
        left();
      }
    };
    const springs = sprung({ card: 0, face: 0 }, "slide", draw);
    springs.jump({ card: 0, face: 0 });
    motion.current = springs;
    return () => {
      springs.stop();
      motion.current = null;
    };
  }, []);
  useEffect(() => {
    const springs = motion.current;
    if (springs === null) return;
    if (reducedMotion()) {
      // No travel: it is in place at once, and the whole of it fades in and
      // out (index.css), which ends its way out.
      leaving.current = false;
      if (shown) springs.jump({ card: 1, face: 1 });
      return;
    }
    if (shown) {
      leaving.current = false;
      springs.to({ card: 1 }, { spring: "slide" });
      springs.to({ face: 1 }, { spring: "pop", delay: FACE_AFTER });
    } else {
      leaving.current = true;
      springs.to({ face: 0 }, { spring: "slide" });
      springs.to({ card: 0 }, { spring: "slide", delay: FACE_AFTER / 2 });
    }
  }, [shown]);

  // Each time it is asked for, it shows the conversation's end, with the cursor in the composer.
  const toHand = useEffectEvent(() => {
    timeline?.scrollTo({ top: 0, behavior: "auto" });
    composerRef.current?.focus();
  });
  const askedFor = shown ? asked : null;
  useEffect(() => {
    if (askedFor !== null) toHand();
  }, [askedFor]);

  const shortcuts = shellShortcuts();
  // Escape in the composer closes quick access before the composer takes it
  // to set a suggested reply aside, which it would nearly every time: the
  // suggestion is there whenever the bot has answered. A list open on the
  // composer, of members or of prompts, still takes its own Escape.
  const onEscapeFirst = useEffectEvent((event: KeyboardEvent) => {
    const field = composerRef.current;
    if (!shown || event.key !== "Escape" || event.isComposing || event.target !== field) return;
    if (field?.getAttribute("aria-expanded") === "true") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  });
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    // A key an input method composes with is the input method's; one a menu or a picker took is its own.
    if (!shown || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      // A dialog over the card, as an image opened from it, closes first.
      if (document.querySelector("[role=dialog], [role=alertdialog]") !== null) return;
      event.preventDefault();
      onClose();
    } else if (shortcuts.stop.matches(event)) {
      // As from the conversation: Stop, or Force stop while the bot's AI ignores one.
      const stop = botStop(bot);
      if (stop === "hidden") return;
      event.preventDefault();
      if (stop === "force") intents.forceStopBot(bot.id);
      else intents.stopBot(bot.id);
    }
  });
  // A file pasted anywhere on it is attached, as one pasted in the composer is.
  const onPaste = useEffectEvent((event: ClipboardEvent) => {
    const files = event.clipboardData?.files;
    if (!shown || event.defaultPrevented || files === undefined || files.length === 0) return;
    event.preventDefault();
    intents.attachFiles(target, [...files]);
  });
  useEffect(() => {
    const first = (event: KeyboardEvent) => onEscapeFirst(event);
    const key = (event: KeyboardEvent) => onKeyDown(event);
    const paste = (event: ClipboardEvent) => onPaste(event);
    window.addEventListener("keydown", first, { capture: true });
    window.addEventListener("keydown", key);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", first, { capture: true });
      window.removeEventListener("keydown", key);
      window.removeEventListener("paste", paste);
    };
  }, []);

  const held = openingHeld(bot, data.engine);
  const presence = data.connected
    ? presenceLine(bot, ctx)
    : ({ text: t("connection.reconnecting"), tone: "secondary" } as const);
  return (
    <RosterProvider roster={data.roster ?? []} engine={data.engine}>
      <AvatarConnection connected={data.connected}>
        <div
          role="region"
          aria-label={t("quickAccess.label", { name })}
          inert={!shown}
          data-shown={shown}
          // Under reduced motion its way out is a fade of the whole of it, which ends here.
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget || shown) return;
            motion.current?.jump({ card: 0, face: 0 });
            onLeft();
          }}
          // A file dropped anywhere on it is attached; one dropped beside the card goes nowhere.
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            if (event.defaultPrevented || event.dataTransfer.files.length === 0) return;
            event.preventDefault();
            if (event.target instanceof Node && cardRef.current?.contains(event.target) === true) {
              intents.attachFiles(target, [...event.dataTransfer.files]);
            }
          }}
          className={cn(
            "quick-access crossfade fixed inset-0 text-foreground",
            // Room around the card for its rounded corners and its shadow.
            !solid && "px-7 pt-4 pb-9",
            tintOf(bot.profile.avatar),
          )}
        >
          <section
            ref={cardRef}
            className={cn(
              "flex h-full flex-col overflow-hidden bg-surface [contain:layout_paint]",
              !solid && "rounded-[20px] border border-border shadow-overlay",
            )}
          >
            {/* The header is the window's handle: the system drags the window by it. */}
            <header className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-border ps-3 pe-1.5 [-webkit-app-region:drag]">
              <span ref={faceRef} className="inline-flex [-webkit-app-region:no-drag]">
                <LiveBotAvatar bot={bot} lastEntry={lastEntry} size={FACE} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <h1 className="truncate text-sm font-medium">{name}</h1>
                {presence !== null && (
                  <SwapText
                    text={presence.text}
                    className={cn("text-xs", toneClass[presence.tone])}
                  />
                )}
              </div>
              <span className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  onClick={onOpenConversation}
                  aria-label={t("quickAccess.openConversation")}
                  title={t("quickAccess.openConversation")}
                >
                  <ArrowUpRightIcon />
                </Button>
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  onClick={onClose}
                  aria-label={t("quickAccess.close")}
                  title={t("quickAccess.close")}
                  aria-keyshortcuts="Escape"
                >
                  <XIcon />
                </Button>
              </span>
            </header>
            <div ref={setConversation} className="flex min-h-0 flex-1 flex-col">
              {view.phase === "ready" && view.items.length === 0 ? (
                <p className="flex flex-1 items-center justify-center px-6 text-center text-sm text-pretty text-muted-foreground">
                  {held === null ? quietConversationText(bot, ctx) : heldHelloText(name, held, ctx)}
                </p>
              ) : (
                // Reversed, so the view stays pinned to the newest entry as entries arrive.
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <div
                    ref={setTimeline}
                    className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto [overflow-anchor:auto]"
                  >
                    <div className={cn("w-full px-3 py-3", toCard && "pb-14")}>
                      {view.hasOlder && (
                        <div className="flex justify-center pb-2">
                          <Button
                            variant="ghost-muted"
                            size="sm"
                            aria-disabled={view.loadingOlder}
                            onClick={() => {
                              if (!view.loadingOlder) intents.loadOlder(target);
                            }}
                          >
                            {view.loadingOlder
                              ? t("timeline.loadingOlder")
                              : t("timeline.loadOlder")}
                          </Button>
                        </div>
                      )}
                      <Timeline
                        rows={rows}
                        room={null}
                        workSteps={data.workSteps}
                        submitting={data.submitting}
                        openingHold={held}
                        intents={intents}
                        secrets={{ view: data.secrets, intents: intents.secrets }}
                        arrived={arrived}
                        flyFrom={composerRef}
                        turnBot={{ bot, lastEntry }}
                        onOpenPair={onOpenPair}
                        onOpenRoom={onOpenRoom}
                        onOpenBot={onOpenBot}
                      />
                    </div>
                  </div>
                  <ToLatest
                    end={end}
                    onPress={() => scrollToEnd(timeline)}
                    waiting={
                      waitingOn === null
                        ? null
                        : {
                            place: waitingPlace,
                            onPress: () => {
                              const card = timeline?.querySelector<HTMLElement>(
                                `[data-entry-id="${CSS.escape(waitingOn)}"]`,
                              );
                              card?.scrollIntoView({ block: "center" });
                              card?.focus({ preventScroll: true });
                            },
                          }
                    }
                  />
                </div>
              )}
              <div className="px-2.5 pt-1 pb-2.5">
                {seenWindow !== null && (
                  <WindowChips
                    view={seenWindow.view}
                    intents={seenWindow.intents}
                    botName={name}
                    {...(seenWindow.initialPreview === undefined
                      ? {}
                      : { initialPreview: seenWindow.initialPreview })}
                  />
                )}
                <DraftComposer
                  target={target}
                  recipient={name}
                  data={data}
                  intents={intents}
                  addressing={addressing}
                  mentionable={mentionable}
                  suggestion={offeredReply(bot.suggestedReply, view.items)}
                  inputRef={composerRef}
                />
              </div>
            </div>
            {overlay}
          </section>
        </div>
      </AvatarConnection>
    </RosterProvider>
  );
}
