// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  passageOf,
  type QuotableMessage,
  takesPassage,
} from "@j3-bots/client-runtime/presentation";
import type { MessageQuote } from "@j3-bots/contracts";
import { TextQuoteIcon } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { selectedPassage } from "./quoteSelection";

/** The gap between the selection and the button, and between the button and the window's edge, in px. */
const GAP = 6;
const EDGE = 8;

/** What the operator selected of one message's text: the passage, or that it is too long. */
interface Picked {
  readonly range: Range;
  readonly passage: MessageQuote | "too-long";
}

/**
 * Quote, by a selection of one message's text in `scope`: a small button at
 * the selection's last line, kept in the window. It quotes the passage in the
 * draft (`onQuote`) and lets the selection go. It says why instead when the
 * passage is too long, or the draft quotes all a message can. Escape sets it
 * aside until the selection changes; pressing it leaves the selection as it
 * is. A selection over two messages, or outside a message's text, shows none.
 */
export function QuoteOnSelection({
  scope,
  messageOf,
  drafted,
  onQuote,
}: {
  /** Where a selection may be quoted from: the timeline. */
  readonly scope: RefObject<HTMLElement | null>;
  /** The message of an id the timeline shows, when it can be quoted. */
  readonly messageOf: (id: string) => QuotableMessage | undefined;
  /** What the draft quotes now. */
  readonly drafted: ReadonlyArray<MessageQuote>;
  readonly onQuote: (passage: MessageQuote) => void;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Picked | null>(null);
  const button = useRef<HTMLButtonElement>(null);

  // What the selection quotes now, read once it settles: not while a pointer drags it.
  const read = useEffectEvent(() => {
    const selection = document.getSelection();
    const range =
      selection === null || selection.isCollapsed || selection.rangeCount === 0
        ? null
        : selection.getRangeAt(0);
    const selected = range === null ? null : selectedPassage(range);
    const root = scope.current;
    const message = selected === null ? undefined : messageOf(selected.messageId);
    const passage =
      range === null ||
      selected === null ||
      message === undefined ||
      root === null ||
      !root.contains(range.commonAncestorContainer)
        ? null
        : passageOf(message, selected.start, selected.end);
    setPicked((now) => {
      if (range === null || passage === null) return null;
      // The same passage keeps its button where it is.
      if (now !== null && samePicked(now.passage, passage)) return { range, passage: now.passage };
      return { range, passage };
    });
  });
  const close = useEffectEvent(() => setPicked(null));

  useEffect(() => {
    let dragging = false;
    const onDown = (event: PointerEvent) => {
      // A press on the button itself keeps the selection.
      if (event.target instanceof Node && button.current?.contains(event.target)) return;
      dragging = true;
      close();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      read();
    };
    const onChange = () => {
      if (!dragging) read();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  const shown = picked !== null;
  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Taken here, so nothing behind it closes as well.
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [shown]);

  // At the selection's last line, below it where it fits and above it where it does not, and in
  // the window; it follows the selection as the timeline scrolls, written straight to its style.
  const range = picked?.range ?? null;
  useLayoutEffect(() => {
    const element = button.current;
    if (range === null || element === null) return;
    const place = () => {
      const rects = range.getClientRects();
      const last = rects.item(rects.length - 1) ?? range.getBoundingClientRect();
      const first = rects.item(0) ?? last;
      const { width, height } = element.getBoundingClientRect();
      const left = Math.min(
        Math.max(last.right - width / 2, EDGE),
        window.innerWidth - width - EDGE,
      );
      const below = last.bottom + GAP;
      const top =
        below + height + EDGE <= window.innerHeight
          ? below
          : Math.max(first.top - GAP - height, EDGE);
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place, { passive: true });
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [range]);

  if (picked === null) return null;
  const { passage } = picked;
  const refusal =
    passage === "too-long" ? t("quote.tooLong") : takesPassage(drafted) ? null : t("quote.full");
  return createPortal(
    <button
      ref={button}
      type="button"
      aria-disabled={refusal !== null}
      // The selection stays as it is while the button is pressed.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (passage === "too-long" || refusal !== null) return;
        // Let go of the selection before the composer takes the focus, so its caret stays.
        document.getSelection()?.removeAllRanges();
        setPicked(null);
        onQuote(passage);
      }}
      className={cn(
        "pop-in fixed z-50 inline-flex h-8 max-w-[min(20rem,calc(100vw-1rem))] cursor-pointer items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-medium text-foreground shadow-overlay outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-accent",
        refusal !== null && "cursor-default text-muted-foreground hover:bg-surface",
      )}
    >
      {refusal === null && <TextQuoteIcon aria-hidden className="size-3.5 shrink-0" />}
      <span className="truncate">{refusal ?? t("quote.quote")}</span>
    </button>,
    document.body,
  );
}

const samePicked = (one: MessageQuote | "too-long", other: MessageQuote | "too-long") =>
  one === other ||
  (one !== "too-long" &&
    other !== "too-long" &&
    one.entryId === other.entryId &&
    one.quoted._tag === "passage" &&
    other.quoted._tag === "passage" &&
    one.quoted.text === other.quoted.text);
