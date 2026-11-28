// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../app/context";
import { BROWSER_MIN, browserWidthIn, CLOSING_PAST, keepBrowserWidth } from "../shell/browserWidth";

/** The room the conversation and the browser share: the shell's, but for the roster's. */
const roomBeside = (frame: HTMLElement, roster: HTMLElement | null) =>
  frame.getBoundingClientRect().width - (roster?.getBoundingClientRect().width ?? 0);

/** How far an arrow key moves the divider. */
const STEP = 32;

/**
 * Between the conversation and the browser beside it: dragged, it gives one
 * the other's room, down to the narrowest each takes; dragged well past the
 * browser's narrowest, the browser closes and opens again as wide as it was.
 * A double click shares the room half and half.
 */
export function PaneDivider({
  frame,
  roster,
  wanted,
  onWanted,
  onResizing,
  onClose,
}: {
  readonly frame: HTMLElement;
  readonly roster: RefObject<HTMLElement | null>;
  readonly wanted: number | null;
  /** Null: the usual width, as before the person first moved the divider. */
  readonly onWanted: (width: number | null) => void;
  readonly onResizing: ((resizing: boolean) => void) | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const self = useRef<HTMLDivElement>(null);
  // Where the browser starts and how much room it shares with the conversation, as last measured.
  const [shown, setShown] = useState<{ readonly width: number; readonly room: number } | null>(
    null,
  );
  const drag = useRef<{ readonly from: number | null; moved: boolean; closing: boolean } | null>(
    null,
  );

  const room = () => roomBeside(frame, roster.current);
  const rtl = () => getComputedStyle(frame).direction === "rtl";
  useLayoutEffect(() => {
    const measure = () => {
      const pane = self.current?.nextElementSibling;
      if (!(pane instanceof HTMLElement)) return;
      const next = {
        width: pane.getBoundingClientRect().width,
        room: roomBeside(frame, roster.current),
      };
      setShown((last) => (last?.width === next.width && last.room === next.room ? last : next));
    };
    measure();
    // The shell's room, and the browser's width as it follows the divider.
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    const pane = self.current?.nextElementSibling;
    if (pane instanceof HTMLElement) observer.observe(pane);
    return () => observer.disconnect();
  }, [frame, roster]);

  const resizing = (now: boolean) => onResizing?.(now);
  const settle = (width: number) => {
    onWanted(width);
    keepBrowserWidth(width);
  };
  const half = () => settle(browserWidthIn(room(), room() / 2));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { from: wanted, moved: false, closing: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const dragging = drag.current;
    if (dragging === null) return;
    const { left, right } = frame.getBoundingClientRect();
    const asked = rtl() ? event.clientX - left : right - event.clientX;
    if (!dragging.moved) {
      dragging.moved = true;
      resizing(true);
    }
    dragging.closing = asked < BROWSER_MIN - CLOSING_PAST;
    onWanted(browserWidthIn(room(), asked));
  };
  const onPointerEnd = () => {
    const dragging = drag.current;
    drag.current = null;
    if (dragging === null || !dragging.moved) return;
    resizing(false);
    if (dragging.closing) {
      // It opens again as wide as it was before this drag.
      onWanted(dragging.from);
      onClose();
      return;
    }
    if (shown !== null) keepBrowserWidth(shown.width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = shown?.width ?? BROWSER_MIN;
    // The browser lies at the end: the arrow toward the start widens it.
    const toStart = rtl() ? "ArrowRight" : "ArrowLeft";
    const toEnd = rtl() ? "ArrowLeft" : "ArrowRight";
    if (event.key === toStart) settle(browserWidthIn(room(), current + STEP));
    else if (event.key === toEnd) settle(browserWidthIn(room(), current - STEP));
    else if (event.key === "Enter") half();
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={self}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("browser.divider.name")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={
        shown === null || shown.room <= 0 ? 50 : Math.round((shown.width / shown.room) * 100)
      }
      title={t("browser.divider")}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={half}
      onKeyDown={onKeyDown}
      className="group relative z-10 -mx-1.5 grid w-3 shrink-0 cursor-col-resize touch-none place-items-center outline-none"
    >
      <span className="h-8.5 w-1 rounded-full bg-border transition-colors group-hover:bg-muted-foreground group-focus-visible:bg-accent group-active:bg-muted-foreground" />
    </div>
  );
}
