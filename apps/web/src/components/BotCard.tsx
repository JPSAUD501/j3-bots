// SPDX-License-Identifier: AGPL-3.0-or-later
import { Popover } from "@base-ui/react/popover";
import type { Bot, BotId, Room, Routine } from "@j3-bots/contracts";
import {
  type QuickMessageState,
  type QuickSend,
  useQuickMessage,
} from "@j3-bots/client-runtime/react";
import {
  type CardLines,
  type CardStatus,
  cardLines,
  messageProblemText,
} from "@j3-bots/client-runtime/wording";
import { cardTiming } from "@j3-bots/design-tokens";
import type { I18n } from "@j3-bots/i18n";
import {
  ChevronRight,
  Clock,
  Info,
  MessageCircle,
  SendHorizontal,
  Sparkles,
  Users,
} from "lucide-react";
import {
  createContext,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { useBot, useI18n, usePresentation, useRooms } from "../app/context";
import { cn } from "../lib/cn";
import { LiveBotAvatar } from "./avatar/mood";
import { Button } from "./ui/button";

/** What a bot's card does, and the routines it shows, from the shell. */
export interface BotCardIntents {
  readonly talk: (botId: BotId) => void;
  readonly startRoom: (botId: BotId) => void;
  readonly openRoutines: (botId: BotId) => void;
  readonly openDetails: (botId: BotId) => void;
  readonly send: QuickSend;
  /** The bot's routines while its card shows; null while they load. */
  readonly routines: (botId: BotId) => ReadonlyArray<Routine> | null;
  /** The bot whose card shows, or null: whose routines to keep live. */
  readonly showing: (botId: BotId | null) => void;
}

/** Where the card stands from what opened it: beside the roster or the details, under a name. */
export type CardSide = "right" | "left" | "bottom";

interface Shown {
  readonly botId: BotId;
  readonly anchor: HTMLElement;
  readonly side: CardSide;
  /** A card the pointer opened goes when it leaves; one focus opened, when focus does. */
  readonly via: "hover" | "focus";
}

interface CardControl {
  readonly hoverEnter: (botId: BotId, event: PointerEvent<HTMLElement>, side: CardSide) => void;
  readonly hoverLeave: () => void;
  readonly focus: (botId: BotId, event: FocusEvent<HTMLElement>, side: CardSide) => void;
  readonly blur: (event: FocusEvent<HTMLElement>) => void;
  readonly triggerKey: (event: KeyboardEvent<HTMLElement>) => void;
}

const CardContext = createContext<CardControl | null>(null);

/** What focus can reach by Tab, in document order. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const tabbables = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
  );

/** The element a card anchors to: the nearest one that says it is a bot's place, else itself. */
const anchorOf = (element: HTMLElement): HTMLElement =>
  element.closest<HTMLElement>("[data-card-anchor]") ?? element;

/** Stops a timer the card set, if it is still set. */
const clear = (timer: { current: number | null }) => {
  if (timer.current !== null) window.clearTimeout(timer.current);
  timer.current = null;
};

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"]);

/**
 * One bot's card at a time, for the window (decision 0102): it opens after the
 * pointer rests on a bot's face or name, or keyboard focus rests on it, for
 * `cardTiming.open`, and goes when the pointer leaves both it and the card,
 * or when focus leaves them, or on Escape. Opening never moves focus, and a
 * card the pointer opened goes as soon as the operator types elsewhere, so it
 * never stands in the way of typing. From a focused bot, Tab enters the card.
 */
export function BotCardProvider({
  intents,
  children,
}: {
  readonly intents: BotCardIntents;
  readonly children: ReactNode;
}) {
  const [shown, setShownState] = useState<Shown | null>(null);
  // What the handlers read: the card as it is now, ahead of the next render.
  const shownRef = useRef<Shown | null>(null);
  const setShown = (next: Shown | null) => {
    shownRef.current = next;
    setShownState(next);
  };
  const popup = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  // Focus that comes back to a bot from its card reopens nothing.
  const returning = useRef<HTMLElement | null>(null);

  const focusInside = () => popup.current?.contains(document.activeElement) === true;
  const close = () => {
    clear(openTimer);
    clear(closeTimer);
    setShown(null);
  };
  const openLater = (next: Shown) => {
    clear(openTimer);
    clear(closeTimer);
    const current = shownRef.current;
    if (current !== null && current.botId === next.botId && current.anchor === next.anchor) return;
    openTimer.current = window.setTimeout(
      () => {
        openTimer.current = null;
        setShown(next);
      },
      current === null ? cardTiming.open : cardTiming.switch,
    );
  };
  const closeLater = () => {
    clear(openTimer);
    if (shownRef.current === null || focusInside()) return;
    clear(closeTimer);
    closeTimer.current = window.setTimeout(close, cardTiming.close);
  };
  /** Closes the card, and puts focus back on its bot when it was in the card. */
  const dismiss = () => {
    const current = shownRef.current;
    const back = current !== null && focusInside() ? current.anchor : null;
    close();
    if (back !== null && back.isConnected) {
      returning.current = back;
      back.focus();
    }
  };

  const control: CardControl = {
    hoverEnter: (botId, event, side) => {
      // A card the operator is working in, as typing its quick message, stays until they leave it.
      if (event.pointerType !== "mouse" || focusInside()) return;
      openLater({ botId, anchor: anchorOf(event.currentTarget), side, via: "hover" });
    },
    hoverLeave: () => {
      clear(openTimer);
      if (shownRef.current?.via === "hover") closeLater();
    },
    focus: (botId, event, side) => {
      const element = event.currentTarget;
      if (returning.current === element) {
        returning.current = null;
        return;
      }
      if (!element.matches(":focus-visible")) return;
      openLater({ botId, anchor: anchorOf(element), side, via: "focus" });
    },
    blur: (event) => {
      clear(openTimer);
      const to = event.relatedTarget;
      if (to instanceof Node && popup.current?.contains(to) === true) return;
      if (shownRef.current?.via === "focus") close();
    },
    triggerKey: (event) => {
      const current = shownRef.current;
      if (event.key !== "Tab" || event.shiftKey || current === null) return;
      if (current.anchor !== anchorOf(event.currentTarget) || popup.current === null) return;
      const first = tabbables(popup.current)[0];
      if (first === undefined) return;
      event.preventDefault();
      first.focus();
    },
  };

  // Typing elsewhere: a card the pointer opened, or is about to, makes way.
  const onKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (MODIFIERS.has(event.key)) return;
    if (event.target instanceof Node && popup.current?.contains(event.target) === true) return;
    clear(openTimer);
    if (shownRef.current?.via === "hover" && event.key !== "Escape") close();
  });
  useEffect(() => {
    const listen = (event: globalThis.KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listen, true);
    return () => document.removeEventListener("keydown", listen, true);
  }, []);
  useEffect(
    () => () => {
      clear(openTimer);
      clear(closeTimer);
    },
    [],
  );

  const botId = shown?.botId ?? null;
  const { showing } = intents;
  useEffect(() => {
    showing(botId);
  }, [botId, showing]);

  /** Tab off the card's ends goes back to its bot, or on past it. */
  const onPopupKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // The card's own: what holds the window, as quick access, takes none of it.
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab" || shown === null) return;
    const inside = tabbables(event.currentTarget);
    const first = inside[0];
    const last = inside.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      returning.current = shown.anchor;
      shown.anchor.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      const { anchor } = shown;
      const next = tabbables(document).find(
        (element) =>
          !event.currentTarget.contains(element) &&
          !anchor.contains(element) &&
          (anchor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      );
      close();
      next?.focus();
    }
  };

  const open = shown !== null && shown.anchor.isConnected;
  return (
    <CardContext value={control}>
      {children}
      <Popover.Root
        open={open}
        onOpenChange={(next, details) => {
          if (next) return;
          // Escape belongs to whatever has focus outside the card, as well.
          if (details.reason === "escape-key" && !focusInside()) details.allowPropagation();
          dismiss();
        }}
      >
        <Popover.Portal>
          <Popover.Positioner
            anchor={shown?.anchor ?? null}
            side={shown?.side ?? "bottom"}
            align="start"
            sideOffset={8}
            collisionPadding={12}
            className="z-50"
          >
            <Popover.Popup
              ref={popup}
              initialFocus={false}
              finalFocus={false}
              data-bot-card=""
              onPointerEnter={() => clear(closeTimer)}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse" && shown?.via === "hover") closeLater();
              }}
              onBlur={(event) => {
                const to = event.relatedTarget;
                if (
                  to instanceof Node &&
                  (event.currentTarget.contains(to) || shown?.anchor === to)
                )
                  return;
                if (to !== null) close();
              }}
              onKeyDown={onPopupKey}
              className="origin-(--transform-origin) rounded-xl outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out motion-reduce:data-starting-style:scale-100 motion-reduce:data-ending-style:scale-100"
            >
              {shown !== null && (
                <ShownCard
                  // Each bot's card starts afresh: its field empty, its answer its own.
                  key={shown.botId}
                  botId={shown.botId}
                  intents={intents}
                  onDone={close}
                />
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </CardContext>
  );
}

const noCard = { hover: {}, focus: {} } as const;

/**
 * What makes an element open `botId`'s card: `hover` on its face and name,
 * `focus` on the element keyboard focus reaches. The card stands beside the
 * nearest `[data-card-anchor]`, or the element itself. Nothing outside a
 * `BotCardProvider`, or for no bot.
 */
export function useBotCard(botId: BotId | null, side: CardSide = "bottom") {
  const control = use(CardContext);
  if (control === null || botId === null) return noCard;
  return {
    hover: {
      onPointerEnter: (event: PointerEvent<HTMLElement>) => control.hoverEnter(botId, event, side),
      onPointerLeave: () => control.hoverLeave(),
    },
    focus: {
      onFocus: (event: FocusEvent<HTMLElement>) => control.focus(botId, event, side),
      onBlur: (event: FocusEvent<HTMLElement>) => control.blur(event),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => control.triggerKey(event),
    },
  };
}

/** The card of a bot the roster still has; nothing once it is gone. */
function ShownCard({
  botId,
  intents,
  onDone,
}: {
  readonly botId: BotId;
  readonly intents: BotCardIntents;
  readonly onDone: () => void;
}) {
  const bot = useBot(botId);
  const rooms = useRooms();
  if (bot === null) return null;
  const act = (action: (botId: BotId) => void) => () => {
    onDone();
    action(botId);
  };
  return (
    <BotCard
      bot={bot}
      rooms={[...rooms.values()]}
      routines={intents.routines(botId)}
      send={intents.send}
      actions={{
        talk: act(intents.talk),
        startRoom: act(intents.startRoom),
        openRoutines: act(intents.openRoutines),
        openDetails: act(intents.openDetails),
      }}
    />
  );
}

const DOT: Record<CardStatus, string> = {
  working: "bg-success",
  waiting: "bg-waiting",
  free: "bg-muted-foreground/50",
  paused: "bg-blocked",
  stuck: "bg-blocked",
};

const STATUS_TEXT: Record<CardStatus, string> = {
  working: "text-muted-foreground",
  waiting: "text-waiting",
  free: "text-muted-foreground",
  paused: "text-blocked",
  stuck: "text-blocked",
};

interface CardActions {
  readonly talk: () => void;
  readonly startRoom: () => void;
  readonly openRoutines: () => void;
  readonly openDetails: () => void;
}

/**
 * A bot's card: its face with its status, its name and title, what the
 * operator does with it, a quick message, what it does now while it works,
 * what it is for, and where it comes from (decision 0102). Nothing technical:
 * its model and the rest stay in its details.
 */
export function BotCard({
  bot,
  rooms,
  routines,
  send,
  actions,
}: {
  readonly bot: Bot;
  readonly rooms: ReadonlyArray<Room>;
  readonly routines: ReadonlyArray<Routine> | null;
  readonly send: QuickSend;
  readonly actions: CardActions;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const lines = cardLines(bot, rooms, routines, ctx);
  const { name, title } = bot.profile;
  return (
    <div
      role="group"
      aria-label={t("card.label", { name })}
      className="flex w-[min(20.5rem,calc(100vw-2rem))] flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-sm text-foreground shadow-overlay"
    >
      <header className="flex items-center gap-3.5">
        <span className="relative shrink-0 [--avatar-cutout:var(--surface)]">
          <LiveBotAvatar bot={bot} size={64} />
          <span
            aria-hidden
            className={cn(
              "absolute -end-0.5 -bottom-0.5 size-4 rounded-pill border-[3px] border-surface",
              DOT[lines.status],
            )}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-base font-semibold">{name}</h2>
          {title !== "" && <p className="truncate text-xs text-muted-foreground">{title}</p>}
          {lines.status !== "working" && (
            <p className={cn("mt-0.5 text-xs", STATUS_TEXT[lines.status])}>{lines.statusText}</p>
          )}
          <div className="-ms-1.5 mt-1.5 flex gap-1">
            <CardAction label={t("card.talk", { name })} onClick={actions.talk}>
              <MessageCircle />
            </CardAction>
            <CardAction label={t("card.startRoom", { name })} onClick={actions.startRoom}>
              <Users />
            </CardAction>
            <CardAction label={t("card.routinesAction", { name })} onClick={actions.openRoutines}>
              <Clock />
            </CardAction>
            <CardAction label={t("card.detailsAction", { name })} onClick={actions.openDetails}>
              <Info />
            </CardAction>
          </div>
        </div>
      </header>
      <QuickMessage bot={bot} send={send} onOpen={actions.talk} />
      {lines.now !== null && <NowBox status={lines.statusText} now={lines.now} />}
      {lines.job !== null && (
        <section>
          <h3 className="mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("card.whatFor")}
          </h3>
          <p className="line-clamp-2 text-sm">{lines.job}</p>
        </section>
      )}
      <About lines={lines} />
      <button
        type="button"
        onClick={actions.openDetails}
        className="pressable -ms-1 inline-flex items-center gap-0.5 self-start rounded-md px-1 py-0.5 text-xs font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t("card.seeDetails")}
        <ChevronRight aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}

function CardAction({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button size="icon-sm" variant="ghost-muted" aria-label={label} title={label} onClick={onClick}>
      {children}
    </Button>
  );
}

function NowBox({
  status,
  now,
}: {
  readonly status: string;
  readonly now: NonNullable<CardLines["now"]>;
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5 text-sm">
      <p className="line-clamp-2">
        <span aria-hidden className="me-1.5 inline-block size-2 rounded-pill bg-success" />
        <span className="font-semibold">{status}</span> · {now.doing}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{now.detail}</p>
    </div>
  );
}

function About({ lines }: { readonly lines: CardLines }) {
  const { t } = useI18n();
  const rows: ReadonlyArray<{ readonly icon: ReactNode; readonly text: string }> = [
    { icon: <Sparkles />, text: lines.made },
    ...(lines.routines === null ? [] : [{ icon: <Clock />, text: lines.routines }]),
    ...(lines.rooms === null ? [] : [{ icon: <Users />, text: lines.rooms.text }]),
  ];
  return (
    <section>
      <h3 className="mb-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("card.about")}
      </h3>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.text} className="flex items-start gap-2 text-sm">
            <span
              aria-hidden
              className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5"
            >
              {row.icon}
            </span>
            <span className="min-w-0">{row.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function quickLine(state: QuickMessageState, name: string, i18n: I18n) {
  const { t } = i18n;
  switch (state._tag) {
    case "idle":
      return null;
    case "sending":
      return { text: t("card.quick.sending"), tone: "muted" as const };
    case "sent":
      return { text: t("card.quick.sent", { name }), tone: "muted" as const };
    case "invalid":
      return { text: messageProblemText(state.problem, i18n), tone: "blocked" as const };
    case "gone":
      return { text: t("card.quick.gone", { name }), tone: "blocked" as const };
    case "failed":
      return { text: t("card.quick.failed", { name }), tone: "blocked" as const };
  }
}

/**
 * A line that sends straight to the bot's conversation without opening it,
 * and says where what was sent stands, as the composer's messages do.
 */
function QuickMessage({
  bot,
  send,
  onOpen,
}: {
  readonly bot: Bot;
  readonly send: QuickSend;
  readonly onOpen: () => void;
}) {
  const quick = useQuickMessage(bot.id, send);
  return <QuickMessageField name={bot.profile.name} quick={quick} onOpen={onOpen} />;
}

/** The quick message's field and the line under it, for where it stands (`useQuickMessage`). */
export function QuickMessageField({
  name,
  quick,
  onOpen,
}: {
  readonly name: string;
  readonly quick: {
    readonly text: string;
    readonly setText: (text: string) => void;
    readonly state: QuickMessageState;
    readonly submit: () => void;
  };
  readonly onOpen: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const line = quickLine(quick.state, name, i18n);
  return (
    <div className="flex flex-col gap-1">
      <form
        className="flex items-center gap-1 rounded-lg border border-input bg-surface ps-3 pe-1 focus-within:border-accent"
        onSubmit={(event) => {
          event.preventDefault();
          quick.submit();
        }}
      >
        <input
          value={quick.text}
          onChange={(event) => quick.setText(event.currentTarget.value)}
          aria-label={t("card.quick.label", { name })}
          placeholder={t("card.quick.placeholder")}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button
          type="submit"
          size="icon-sm"
          variant="ghost-muted"
          aria-label={t("card.quick.send")}
          aria-disabled={quick.text.trim() === ""}
        >
          <SendHorizontal />
        </Button>
      </form>
      <p aria-live="polite" className="min-h-0 text-xs empty:hidden">
        {line !== null && (
          <span className={line.tone === "blocked" ? "text-blocked" : "text-muted-foreground"}>
            {line.text}
            {quick.state._tag === "sent" && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={onOpen}
                  className="font-semibold text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {t("card.quick.open")}
                </button>
              </>
            )}
          </span>
        )}
      </p>
    </div>
  );
}
