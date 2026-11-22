// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Bot, EntryId, Room } from "@j3-bots/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  PanelRightIcon,
  SquareIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import { canStop, roomStop } from "@j3-bots/client-runtime/presentation";
import { useBots, useI18n, usePresentation } from "../app/context";
import { cn } from "../lib/cn";
import { memberList, presenceLine, type StatusLine } from "@j3-bots/client-runtime/wording";
import { BotAvatar, RoomAvatar } from "./BotAvatar";
import { toneClass } from "./RosterRow";
import { Kbd } from "./ui/kbd";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";

interface ConversationHeaderProps {
  readonly subject:
    | { readonly _tag: "bot"; readonly bot: Bot }
    | { readonly _tag: "room"; readonly room: Room };
  readonly detailsOpen: boolean;
  readonly onToggleDetails: () => void;
  /** Phones only: back to the roster. */
  readonly onBack: () => void;
  /** A bot's Stop runs at once; a room's, once the operator confirms it. */
  readonly onStop: () => void;
  /** Brings the card a waiting bot needs answered into view. */
  readonly onGoToWaiting: (entryId: EntryId) => void;
  readonly stopShortcut: { readonly label: string; readonly aria: string };
  /** The name's button, which opens the details. */
  readonly titleRef?: RefObject<HTMLButtonElement | null>;
  /**
   * Told the status line at each change of state, for screen readers. The
   * region that speaks it lies outside the conversation, so a dialog over the
   * conversation hides all of it from assistive technology (see `isCovered`).
   */
  readonly onAnnounce: (text: string) => void;
}

/** What a bot is doing, as a transition between states: activity text changing within one does not count. */
const stateOf = (bot: Bot) =>
  bot.state._tag === "thinking" || bot.state._tag === "working"
    ? `${bot.state._tag}:${bot.state.stalled}`
    : bot.state._tag;

/**
 * Who this is, and one line saying what it is doing now. The name opens the
 * details; while the bot waits, the line takes the operator to what it waits
 * on. Changes of state are announced through `onAnnounce`, once each.
 *
 * Mount one per conversation, so moving to another conversation announces nothing.
 */
export function ConversationHeader({
  subject,
  detailsOpen,
  onToggleDetails,
  onBack,
  onStop,
  onGoToWaiting,
  stopShortcut,
  titleRef,
  onAnnounce,
}: ConversationHeaderProps) {
  const ctx = usePresentation();
  const { t } = useI18n();
  const bots = useBots();
  const name = subject._tag === "bot" ? subject.bot.profile.name : subject.room.name;
  const line: StatusLine | null =
    subject._tag === "bot"
      ? presenceLine(subject.bot, ctx)
      : { text: t("room.members", { names: memberList(subject.room, ctx) }), tone: "secondary" };
  const waitingOn =
    subject._tag === "bot" && subject.bot.state._tag === "waiting"
      ? subject.bot.state.entryId
      : null;
  const stoppable = subject._tag === "bot" && canStop(subject.bot);
  const roomStopping = subject._tag === "room" ? roomStop(subject.room) : "hidden";

  // A Stop goes away once the work it ends is over. When it held focus, focus
  // moves to the details toggle beside it or, on a phone, where that is
  // hidden, to the name, which opens the details there.
  const detailsToggle = useRef<HTMLButtonElement>(null);
  const stopLeft = useRef(false);
  const stopRef = useCallback((element: HTMLButtonElement | null) => {
    if (element === null) return;
    // React runs this before it takes the button out of the page, while focus is still on it.
    return () => {
      if (element === document.activeElement) stopLeft.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    if (!stopLeft.current) return;
    stopLeft.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    detailsToggle.current?.focus();
    if (document.activeElement !== detailsToggle.current) titleRef?.current?.focus();
  });

  // The announcement is fixed at each change of state; the first state is not announced.
  const state = subject._tag === "bot" ? stateOf(subject.bot) : null;
  const text = line?.text ?? "";
  const announce = useEffectEvent(() => onAnnounce(text));
  const announced = useRef(state);
  useEffect(() => {
    if (announced.current === state) return;
    announced.current = state;
    announce();
  }, [state]);

  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2 @tablet:px-3">
      <Button
        variant="ghost"
        size="icon"
        className="@tablet:hidden"
        onClick={onBack}
        aria-label={t("conversation.back")}
      >
        <ChevronLeftIcon />
      </Button>
      {/* The title button stretches over the whole block, so a click anywhere opens the details. On a
          phone, where it is the only way to the details, the block is a full touch target. */}
      <div className="relative flex min-w-0 items-center @max-tablet:min-h-(--layout-touch-target) gap-2.5 rounded-md px-1.5 py-1 has-[[data-title]:hover]:bg-muted has-[[data-title]:focus-visible]:outline-2 has-[[data-title]:focus-visible]:outline-accent">
        {subject._tag === "bot" ? (
          <BotAvatar avatar={subject.bot.profile.avatar} state={subject.bot.state} size={28} />
        ) : (
          <RoomAvatar
            size={28}
            members={subject.room.members.flatMap((id) => {
              const bot = bots.get(id);
              return bot ? [bot.profile.avatar] : [];
            })}
          />
        )}
        <span className="flex min-w-0 flex-col items-start">
          <button
            ref={titleRef}
            type="button"
            data-title=""
            onClick={onToggleDetails}
            aria-expanded={detailsOpen}
            aria-label={t("conversation.openDetails", { name })}
            className="flex min-w-0 items-center gap-0.5 text-start text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-md"
          >
            <span className="truncate">{name}</span>
            {/* Phones have no pane button: the chevron says the name opens more. */}
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground @tablet:hidden"
            />
          </button>
          {/* The line keeps its place when it says nothing, so the name never moves as the bot's
              state changes. */}
          {line === null ? (
            <span aria-hidden className="min-h-[1lh] text-2xs" />
          ) : waitingOn !== null ? (
            // On touch screens this line is the button at the end of the header instead. Only a coarse
            // pointer hides it: with no pointer at all (keyboard only, a TV), it stays.
            <button
              type="button"
              onClick={() => onGoToWaiting(waitingOn)}
              aria-label={t("presence.waiting.goTo")}
              className={cn(
                "relative z-10 block max-w-full truncate rounded-sm text-2xs underline underline-offset-2 pointer-coarse:invisible",
                toneClass[line.tone],
              )}
            >
              {line.text}
            </button>
          ) : (
            <span className={cn("max-w-full truncate text-2xs", toneClass[line.tone])}>
              {line.text}
            </span>
          )}
        </span>
      </div>
      <span className="ms-auto flex shrink-0 items-center gap-1">
        {waitingOn !== null && (
          // A finger needs a whole target, apart from the title that opens the details.
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onGoToWaiting(waitingOn)}
            aria-label={t("presence.waiting.goTo")}
            className="hidden text-waiting pointer-coarse:inline-flex"
          >
            {t("presence.waiting")}
            <CornerDownRightIcon aria-hidden />
          </Button>
        )}
        {stoppable && (
          <Button ref={stopRef} size="sm" onClick={onStop} aria-keyshortcuts={stopShortcut.aria}>
            <SquareIcon className="size-3 fill-current" aria-hidden />
            {t("conversation.stop")}
            <Kbd className="pointer-coarse:hidden">{stopShortcut.label}</Kbd>
          </Button>
        )}
        {roomStopping !== "hidden" && (
          // One button through the whole Stop, so focus stays on it once the question closes.
          <Confirm
            trigger={<Button ref={stopRef} size="sm" aria-disabled={roomStopping === "stopping"} />}
            title={t("room.stop.title", { name })}
            body={t("room.stop.body", { name })}
            cancel={t("room.stop.cancel")}
            confirm={t("room.stop")}
            onConfirm={onStop}
            busy={roomStopping === "stopping"}
          >
            <SquareIcon className="size-3 fill-current" aria-hidden />
            {roomStopping === "stopping" ? t("conversation.stopping") : t("conversation.stop")}
          </Confirm>
        )}
        <Button
          ref={detailsToggle}
          variant="ghost-muted"
          size="icon"
          onClick={onToggleDetails}
          aria-pressed={detailsOpen}
          aria-label={t("conversation.details")}
          className="hidden @tablet:inline-flex"
        >
          <PanelRightIcon />
        </Button>
      </span>
    </header>
  );
}
