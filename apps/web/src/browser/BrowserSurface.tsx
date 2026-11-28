// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserViewHandle } from "@j3-bots/client-runtime";
import type { BotId, BrowserInput, BrowserTabRef } from "@j3-bots/contracts";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "../lib/cn";
import { BotCursors } from "./BotCursors";
import { PageField } from "./PageField";
import { keepPicture } from "./pictures";
import { buttonOf, buttonsOf, modifiersOf, pagePoint, type Size, wheelDelta } from "./input";

/** Two presses this close in time and place are one double click. */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;
/** A touch that moves this far is a scroll, not a tap. */
const TOUCH_SLOP = 8;

interface SurfaceProps {
  readonly view: BrowserViewHandle;
  /** The page's size in CSS pixels; null until the server says. */
  /** The tab and its page's address: the bots' pointers show afresh once either changes. */
  readonly tab: BrowserTabRef;
  readonly address: string;
  readonly viewport: Size | null;
  /** The stage's size: the picture is drawn as large as fits in it. */
  readonly box: Size;
  /** What the person does over the picture goes to the page: touching it is using it. */
  readonly usable: boolean;
  /** Sends what the person did, as their use of the page (`usePageUse`). */
  readonly send: (input: BrowserInput) => void;
  /** This device holds the tab: the bots' pointers step aside, and the person's moves reach the page. */
  readonly holding: boolean;
  /** The bots on the tab, the most recent first: whose pointers show. */
  readonly onIt: ReadonlyArray<BotId>;
  /** What the page's text field is called to assistive technology. */
  readonly label: string;
  readonly description: string;
  /** The operator pressed the key that leaves the page. */
  readonly onLeave: () => void;
}

/** The largest size of `aspect` that fits in `box`. */
const contain = (box: Size, aspect: number): Size =>
  box.width / box.height > aspect
    ? { width: Math.round(box.height * aspect), height: Math.round(box.height) }
    : { width: Math.round(box.width), height: Math.round(box.width / aspect) };

/**
 * The tab's picture, drawn as large as fits, and, while the operator holds
 * the tab, what they do over it sent to the page: the pointer, the wheel,
 * keys and typed text, through a text field that takes the focus, so input
 * methods compose as they would anywhere. While they only watch, nothing goes
 * to the page and the bot's cursor shows where it acts.
 */
export function BrowserSurface({
  view,
  tab,
  address,
  viewport,
  box,
  usable,
  send,
  holding,
  onIt,
  label,
  description,
  onLeave,
}: SurfaceProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The page's text field, which holds the focus while the operator types into the page.
  const field = useRef<HTMLTextAreaElement>(null);
  const [pictureSize, setPictureSize] = useState<Size | null>(null);

  // Kept with the address the page has as the picture comes, for the bot's card beside it.
  const keep = useEffectEvent((jpeg: Uint8Array) => keepPicture(tab, jpeg, Date.now(), address));
  // Each picture is drawn, then acknowledged, so the server sends the next only once it shows.
  // The newest picture the view holds when this mounts, as a kept view's, is drawn first.
  useEffect(() => {
    const target = canvas.current;
    const context = target?.getContext("2d");
    if (target === null || context === null || context === undefined) return;
    let stopped = false;
    let drawing = false;
    let drawnSequence: number | null = null;
    const drawNewest = async () => {
      const picture = view.picture.get();
      if (drawing || picture === null || picture.sequence === drawnSequence) return;
      drawing = true;
      drawnSequence = picture.sequence;
      try {
        const bitmap = await createImageBitmap(
          new Blob([picture.jpeg.slice()], { type: "image/jpeg" }),
        );
        if (stopped) {
          bitmap.close();
          return;
        }
        if (target.width !== bitmap.width) target.width = bitmap.width;
        if (target.height !== bitmap.height) target.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
        keep(picture.jpeg);
        setPictureSize({ width: bitmap.width, height: bitmap.height });
        bitmap.close();
      } catch {
        // A picture that does not decode is skipped; the next replaces it.
      } finally {
        drawing = false;
        if (!stopped) {
          view.ack(picture.sequence);
          void drawNewest();
        }
      }
    };
    const stop = view.picture.subscribe(() => void drawNewest());
    void drawNewest();
    return () => {
      stopped = true;
      stop();
    };
  }, [view]);

  const aspect =
    pictureSize !== null
      ? pictureSize.width / pictureSize.height
      : viewport !== null && viewport.height > 0
        ? viewport.width / viewport.height
        : 16 / 10;
  const fitted = contain(box, aspect);

  const pointAt = (clientX: number, clientY: number) => {
    const target = canvas.current;
    if (target === null || viewport === null) return null;
    return pagePoint(target.getBoundingClientRect(), viewport, { x: clientX, y: clientY });
  };

  // Pointer input: presses and releases at once, moves at most once a frame.
  const press = useRef<{
    time: number;
    x: number;
    y: number;
    button: number;
    count: number;
  } | null>(null);
  const touch = useRef<{ x: number; y: number; scrolling: boolean } | null>(null);
  // The fingers on the picture: two or more pinch, which is only looking, never a tap or a scroll.
  const fingers = useRef(new Set<number>());
  const pendingMove = useRef<{ x: number; y: number; buttons: number; modifiers: number } | null>(
    null,
  );
  const frame = useRef<number | null>(null);
  const flushMove = () => {
    frame.current = null;
    const move = pendingMove.current;
    pendingMove.current = null;
    if (move === null) return;
    send({
      type: "pointer",
      action: "move",
      x: move.x,
      y: move.y,
      button: "none",
      buttons: move.buttons,
      clickCount: 0,
      modifiers: move.modifiers,
    });
  };
  const queueMove = (event: ReactPointerEvent) => {
    const point = pointAt(event.clientX, event.clientY);
    if (point === null) return;
    pendingMove.current = {
      ...point,
      buttons: buttonsOf(event.buttons),
      modifiers: modifiersOf(event),
    };
    frame.current ??= window.requestAnimationFrame(flushMove);
  };
  const click = (
    action: "down" | "up",
    point: { readonly x: number; readonly y: number },
    button: number,
    buttons: number,
    count: number,
    modifiers: number,
  ) => {
    if (pendingMove.current !== null) flushMove();
    send({
      type: "pointer",
      action,
      x: point.x,
      y: point.y,
      button: buttonOf(button),
      buttons: buttonsOf(buttons),
      clickCount: count,
      modifiers,
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!usable) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointAt(event.clientX, event.clientY);
    if (point === null) return;
    if (event.pointerType === "touch") {
      fingers.current.add(event.pointerId);
      // A finger scrolls by dragging and clicks by tapping; a tap on a field brings the keyboard.
      touch.current =
        fingers.current.size === 1
          ? { x: event.clientX, y: event.clientY, scrolling: false }
          : null;
      return;
    }
    field.current?.focus({ preventScroll: true });
    const now = performance.now();
    const last = press.current;
    const count =
      last !== null &&
      last.button === event.button &&
      now - last.time < MULTI_CLICK_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < MULTI_CLICK_PX
        ? Math.min(last.count + 1, 3)
        : 1;
    press.current = { time: now, x: event.clientX, y: event.clientY, button: event.button, count };
    click("down", point, event.button, event.buttons, count, modifiersOf(event));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!usable) return;
    const finger = touch.current;
    if (event.pointerType === "touch") {
      if (finger === null || viewport === null || canvas.current === null) return;
      const dx = event.clientX - finger.x;
      const dy = event.clientY - finger.y;
      if (!finger.scrolling && Math.hypot(dx, dy) < TOUCH_SLOP) return;
      finger.scrolling = true;
      finger.x = event.clientX;
      finger.y = event.clientY;
      const point = pointAt(event.clientX, event.clientY);
      if (point === null) return;
      send({
        type: "wheel",
        ...point,
        ...wheelDelta(
          { deltaX: -dx, deltaY: -dy, deltaMode: 0 },
          canvas.current.getBoundingClientRect(),
          viewport,
        ),
        modifiers: 0,
      });
      return;
    }
    // Pointing is only reading: it reaches the page while the person holds it, or drags on it.
    if (holding || event.buttons !== 0) queueMove(event);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    fingers.current.delete(event.pointerId);
    if (!usable) return;
    const point = pointAt(event.clientX, event.clientY);
    if (point === null) return;
    if (event.pointerType === "touch") {
      const finger = touch.current;
      touch.current = null;
      if (finger === null || finger.scrolling) return;
      click("down", point, 0, 1, 1, 0);
      click("up", point, 0, 0, 1, 0);
      send({ type: "probe", ...point });
      return;
    }
    click("up", point, event.button, event.buttons, press.current?.count ?? 1, modifiersOf(event));
  };

  // A tap that lands in a field brings the keyboard up; one elsewhere puts it away.
  useEffect(() => {
    if (!usable) return;
    return view.onProbe((probe) => {
      if (probe.editable) field.current?.focus({ preventScroll: true });
      else if (document.activeElement === field.current) field.current?.blur();
    });
  }, [view, usable]);

  // The wheel scrolls the page, not the viewer: its listener must be able to prevent that.
  const wheel = useRef<{
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    modifiers: number;
  } | null>(null);
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (!usable || viewport === null || canvas.current === null) return;
    event.preventDefault();
    const point = pointAt(event.clientX, event.clientY);
    if (point === null) return;
    const delta = wheelDelta(event, canvas.current.getBoundingClientRect(), viewport);
    const held = wheel.current;
    wheel.current = {
      ...point,
      deltaX: (held?.deltaX ?? 0) + delta.deltaX,
      deltaY: (held?.deltaY ?? 0) + delta.deltaY,
      modifiers: modifiersOf(event),
    };
    if (held !== null) return;
    window.requestAnimationFrame(() => {
      const scroll = wheel.current;
      wheel.current = null;
      if (scroll !== null) send({ type: "wheel", ...scroll });
    });
  });
  useEffect(() => {
    const target = canvas.current;
    if (target === null) return;
    const listener = (event: WheelEvent) => onWheel(event);
    target.addEventListener("wheel", listener, { passive: false });
    return () => target.removeEventListener("wheel", listener);
  }, []);

  // A page that can no longer be used puts the keyboard away.
  useEffect(() => {
    if (!usable && document.activeElement === field.current) field.current?.blur();
  }, [usable]);

  return (
    <div className="relative" style={{ width: fitted.width, height: fitted.height }}>
      <canvas
        ref={canvas}
        aria-hidden
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(event) => {
          fingers.current.delete(event.pointerId);
          touch.current = null;
        }}
        onContextMenu={(event) => {
          if (usable) event.preventDefault();
        }}
        className={cn(
          "block size-full rounded-md bg-muted select-none",
          pictureSize === null && "invisible",
          usable ? "cursor-default touch-none" : "pointer-events-none",
        )}
      />
      <BotCursors
        view={view}
        tab={tab}
        address={address}
        viewport={viewport}
        onIt={onIt}
        held={holding}
      />
      {usable && (
        <PageField
          ref={field}
          send={send}
          label={label}
          description={description}
          onLeave={onLeave}
        />
      )}
    </div>
  );
}
