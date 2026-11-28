// SPDX-License-Identifier: AGPL-3.0-or-later
import { claimsSwipe, swipeDirection } from "@j3-bots/client-runtime/presentation";
import { type MouseEvent, type PointerEvent, useRef } from "react";

/** Where a pointer went down and when, and whether it has turned into a swipe. */
interface Start {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  swiping: boolean;
}

/**
 * A sideways swipe over an element, which the buttons in it keep their
 * presses through: it is taken only once the pointer has gone clearly
 * sideways (`claimsSwipe`), and the click that would end it is dropped.
 * `onMove` follows the pointer; `onSwipe` says which way a swipe went (1
 * toward the end) or null when it fell short (`swipeDirection`).
 */
export function useSideSwipe(handlers: {
  readonly onSwipe: (direction: -1 | 1 | null) => void;
  readonly onMove?: (dx: number) => void;
}) {
  const start = useRef<Start | null>(null);
  // A swipe that just ended: the click its release makes presses nothing.
  const swiped = useRef(false);
  const end = (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const from = start.current;
    if (from === null || from.id !== event.pointerId) return;
    start.current = null;
    if (!from.swiping) return;
    swiped.current = true;
    const dx = event.clientX - from.x;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    handlers.onSwipe(cancelled ? null : swipeDirection(dx, event.timeStamp - from.at, rtl));
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      swiped.current = false;
      start.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        swiping: false,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const from = start.current;
      if (from === null || from.id !== event.pointerId) return;
      const dx = event.clientX - from.x;
      if (!from.swiping) {
        if (!claimsSwipe(dx, event.clientY - from.y)) return;
        from.swiping = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      handlers.onMove?.(dx);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => end(event, false),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => end(event, true),
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!swiped.current) return;
      swiped.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
