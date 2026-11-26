// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EntryPreview } from "@j3-bots/contracts";
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
import { canStop, openingHeld } from "@j3-bots/client-runtime/presentation";
import {
  heldHelloText,
  presenceLine,
  quietConversationText,
} from "@j3-bots/client-runtime/wording";
import { RosterProvider, useI18n, usePresentation } from "../app/context";
import type { AvatarHandle } from "../components/avatar/BotAvatar";
import { AvatarConnection, LiveBotAvatar } from "../components/avatar/mood";
import { DraftComposer } from "../components/DraftComposer";
import { toneClass } from "../components/RosterRow";
import { SwapText } from "../components/SwapText";
import { Timeline, type TimelineIntents } from "../components/Timeline";
import { scrollToEnd, ToLatest } from "../components/ToLatest";
import { Button } from "../components/ui/button";
import { tintOf } from "../lib/botTint";
import { cn } from "../lib/cn";
import { reducedMotion } from "../lib/motion";
import { sprung, type Sprung } from "../lib/sprung";
import { useConversationView } from "../shell/conversationView";
import type { ShellData, ShellIntents } from "../shell/data";
import { shellShortcuts } from "../shell/shortcuts";

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
    | "stopBot"
    | "secrets"
  >;

interface QuickAccessProps {
  /** The primary bot, and its latest entry, as the roster lists them. */
  readonly bot: Bot;
  readonly lastEntry: EntryPreview | null;
  readonly data: QuickAccessData;
  readonly intents: QuickAccessIntents;
  /**
   * The window is not see-through: the card fills it, square, with the face
   * inside its header. Otherwise the face sits on the card's top edge, in the
   * see-through part of the window.
   */
  readonly solid: boolean;
  /** Whether it shows. It comes in as this turns true and goes out as it turns false. */
  readonly shown: boolean;
  /** Changes each time the operator asks for it again: the cursor goes to the composer. */
  readonly asked: number;
  readonly onOpenConversation: () => void;
  /** The operator closed it, with its button or Escape. */
  readonly onClose: () => void;
  /** It has gone out: nothing of it is on screen. */
  readonly onLeft: () => void;
  /** What the page shows over the card, as its toast: drawn inside it, so it stays on the card. */
  readonly overlay?: ReactNode;
}

/** How far below its place the card starts from, in px. */
const RISE = 20;
/** The face's size, in px, on the card's edge and inside its header. */
const FACE = { perched: 68, inside: 40 } as const;
/** How far through its way in the card is when what it holds starts to show. */
const WORDS_FROM = 0.45;

/**
 * Quick access to the primary bot: its face, its name and what it is doing,
 * its conversation and the composer, in a small card. The conversation is the
 * one the main window shows, drawn by the same components: what is read here
 * is read there, and the draft is the same draft.
 *
 * It comes in with the face first, which drops onto the card's top edge as
 * the card rises under it, and what the card holds shows last; it goes out
 * the way it came. Each part travels on its spring from wherever it is, so
 * asking for it again mid-way turns it around. Under reduced motion it fades.
 * The composer has the cursor from the first frame.
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
  onClose,
  onLeft,
  overlay,
}: QuickAccessProps) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const name = bot.profile.name;
  const target = { _tag: "conversation", botId: bot.id } as const;
  const view = data.conversation(target);
  const composerRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<AvatarHandle>(null);
  const cardRef = useRef<HTMLElement>(null);
  const wordsRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLSpanElement>(null);
  // State, not a ref: what watches the timeline follows the element.
  const [timeline, setTimeline] = useState<HTMLDivElement | null>(null);
  const { rows, arrived, end, waitingOn, waitingPlace } = useConversationView({
    selectionKey: targetKey(target),
    target,
    view,
    bot,
    timeline,
    markRead: intents.markRead,
  });
  const toCard = waitingPlace === "above" || waitingPlace === "below";

  // The way in and out. `card` and `face` each go from 0, out of sight, to 1, in place.
  const left = useEffectEvent(onLeft);
  const motion = useRef<Sprung<"card" | "face"> | null>(null);
  const leaving = useRef(false);
  useLayoutEffect(() => {
    const draw = ({ card, face }: Readonly<Record<"card" | "face", number>>) => {
      const cardElement = cardRef.current;
      const words = wordsRef.current;
      const faceElement = faceRef.current;
      if (cardElement === null || words === null) return;
      cardElement.style.opacity = String(Math.max(0, Math.min(1, card * 1.6)));
      cardElement.style.translate = `0 ${(1 - card) * RISE}px`;
      words.style.opacity = String(
        Math.max(0, Math.min(1, (card - WORDS_FROM) / (1 - WORDS_FROM))),
      );
      if (faceElement !== null) faceElement.style.opacity = String(Math.max(0, Math.min(1, face)));
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
      if (springs.now().face < 0.5) avatarRef.current?.poke("drop");
      springs.to({ face: 1 }, { spring: "pop" });
      springs.to({ card: 1 }, { spring: "slide", delay: 70 });
    } else {
      leaving.current = true;
      springs.to({ card: 0 }, { spring: "slide" });
      springs.to({ face: 0 }, { spring: "slide", delay: 50 });
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
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    // A key an input method composes with is the input method's; one a menu or a picker took is its own.
    if (!shown || event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape") {
      // A dialog over the card, as an image opened from it, closes first.
      if (document.querySelector("[role=dialog], [role=alertdialog]") !== null) return;
      event.preventDefault();
      onClose();
    } else if (shortcuts.stop.matches(event) && canStop(bot)) {
      event.preventDefault();
      intents.stopBot(bot.id);
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
    const key = (event: KeyboardEvent) => onKeyDown(event);
    const paste = (event: ClipboardEvent) => onPaste(event);
    window.addEventListener("keydown", key);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("paste", paste);
    };
  }, []);

  const held = openingHeld(bot, data.engine);
  const presence = data.connected
    ? presenceLine(bot, ctx)
    : ({ text: t("connection.reconnecting"), tone: "secondary" } as const);
  const face = (
    <LiveBotAvatar
      bot={bot}
      lastEntry={lastEntry}
      size={solid ? FACE.inside : FACE.perched}
      cutout={!solid}
      ref={avatarRef}
    />
  );
  return (
    <RosterProvider roster={data.roster ?? []}>
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
            // Room around the card for its shadow, and above it for the face on its edge.
            !solid && "px-7 pt-[46px] pb-9",
            tintOf(bot.profile.avatar),
          )}
        >
          <div className="relative h-full">
            <section
              ref={cardRef}
              className={cn(
                "flex h-full flex-col overflow-hidden bg-surface [contain:layout_paint]",
                !solid && "rounded-[20px] border border-border shadow-overlay",
              )}
            >
              {/* The header is the window's handle: the system drags the window by it. */}
              <header
                className={cn(
                  "flex min-h-14 shrink-0 items-center gap-2.5 pe-1.5 [-webkit-app-region:drag]",
                  solid ? "ps-3" : "ps-[92px]",
                )}
              >
                {solid && (
                  <span ref={faceRef} className="inline-flex [--avatar-cutout:var(--surface)]">
                    {face}
                  </span>
                )}
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
              <div ref={wordsRef} className="flex min-h-0 flex-1 flex-col">
                {view.phase === "ready" && view.items.length === 0 ? (
                  <p className="flex flex-1 items-center justify-center px-6 text-center text-sm text-pretty text-muted-foreground">
                    {held === null
                      ? quietConversationText(bot, ctx)
                      : heldHelloText(name, held, ctx)}
                  </p>
                ) : (
                  // Reversed, so the view stays pinned to the newest entry as entries arrive.
                  <div className="relative flex min-h-0 flex-1 flex-col">
                    <div
                      ref={setTimeline}
                      className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto [overflow-anchor:auto]"
                    >
                      <div className={cn("w-full px-3 pt-1 pb-3", toCard && "pb-14")}>
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
                          onOpenPair={onOpenConversation}
                          onOpenRoom={onOpenConversation}
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
                  <DraftComposer
                    target={target}
                    recipient={name}
                    data={data}
                    intents={intents}
                    inputRef={composerRef}
                  />
                </div>
              </div>
              {overlay}
            </section>
            {!solid && (
              // On the card's top edge, half above it, with a band of the card's color around it.
              <span
                ref={faceRef}
                className="absolute start-3.5 -top-[30px] inline-flex [--avatar-cutout:var(--surface)] [filter:drop-shadow(0_4px_8px_rgb(0_0_0/0.18))] [-webkit-app-region:no-drag]"
              >
                {face}
              </span>
            )}
          </div>
        </div>
      </AvatarConnection>
    </RosterProvider>
  );
}
