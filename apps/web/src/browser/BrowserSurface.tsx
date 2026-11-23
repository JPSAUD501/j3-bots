// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor, BrowserViewHandle } from "@j3-bots/client-runtime";
import type { BrowserInput } from "@j3-bots/contracts";
import { MousePointer2Icon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "../lib/cn";
import {
  buttonOf,
  buttonsOf,
  type KeyLike,
  keyFrame,
  LEAVE_PAGE_KEY,
  modifiersOf,
  pagePoint,
  type Size,
  textFrames,
  wheelDelta,
} from "./input";

/** Two presses this close in time and place are one double click. */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;
/** A touch that moves this far is a scroll, not a tap. */
const TOUCH_SLOP = 8;
/** The bot's cursor fades once it has stood still this long. */
const CURSOR_REST_MS = 2_000;

interface SurfaceProps {
  readonly view: BrowserViewHandle;
  /** The page's size in CSS pixels; null until the server says. */
  readonly viewport: Size | null;
  /** The stage's size: the picture is drawn as large as fits in it. */
  readonly box: Size;
  /** This device controls the tab: input goes to the page. */
  readonly control: boolean;
  /** What the page's text field is called to assistive technology. */
  readonly label: string;
  readonly description: string;
  /** The operator pressed the key that leaves the page. */
  readonly onLeave: () => void;
  /** The page takes the keyboard as soon as this device has control. */
  readonly focusPage: boolean;
}

/**
 * What the text field holds between keys: one character a phone's keyboard
 * can delete, since it sends Backspace on an empty field to nobody.
 */
const SENTINEL = "\u200B";

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
  viewport,
  box,
  control,
  label,
  description,
  onLeave,
  focusPage,
}: SurfaceProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // The page's text field, which holds the focus while the operator types into the page.
  const field = useRef<HTMLTextAreaElement>(null);
  const [pictureSize, setPictureSize] = useState<Size | null>(null);

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

  const send = (input: BrowserInput) => view.send(input);
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
    if (!control) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointAt(event.clientX, event.clientY);
    if (point === null) return;
    if (event.pointerType === "touch") {
      // A finger scrolls by dragging and clicks by tapping; a tap on a field brings the keyboard.
      touch.current = { x: event.clientX, y: event.clientY, scrolling: false };
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
    if (!control) return;
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
    queueMove(event);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!control) return;
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
    if (!control) return;
    return view.onProbe((probe) => {
      if (probe.editable) field.current?.focus({ preventScroll: true });
      else if (document.activeElement === field.current) field.current?.blur();
    });
  }, [view, control]);

  // The wheel scrolls the page, not the viewer: its listener must be able to prevent that.
  const wheel = useRef<{
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    modifiers: number;
  } | null>(null);
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (!control || viewport === null || canvas.current === null) return;
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

  // Taking control puts the keyboard on the page; losing it puts the keyboard away.
  useEffect(() => {
    if (control && focusPage) field.current?.focus({ preventScroll: true });
    else if (!control && document.activeElement === field.current) field.current?.blur();
  }, [control, focusPage]);

  const keyOf = (event: ReactKeyboardEvent<HTMLTextAreaElement>): KeyLike => ({
    key: event.key,
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    keyCode: event.keyCode,
    altGraph: event.getModifierState("AltGraph"),
  });
  const onKey = (action: "down" | "up") => (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!control) return;
    if (
      action === "down" &&
      event.key === LEAVE_PAGE_KEY &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      onLeave();
      return;
    }
    const key = keyFrame(keyOf(event), action);
    if (key === null) return;
    // The page takes the key, the app's own shortcuts and the browser's do not.
    event.preventDefault();
    send(key);
  };
  const typed = (text: string) => {
    for (const frame of textFrames(text.replaceAll(SENTINEL, ""))) send(frame);
  };
  const pressKey = (key: string, code: string, keyCode: number, text?: string) => {
    for (const action of ["down", "up"] as const) {
      send({
        type: "key",
        action,
        key,
        code,
        ...(text !== undefined && action === "down" ? { text } : {}),
        keyCode,
        modifiers: 0,
      });
    }
  };
  const clear = () => {
    const target = field.current;
    if (target === null) return;
    target.value = SENTINEL;
    target.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };

  return (
    <div className="relative" style={{ width: fitted.width, height: fitted.height }}>
      <canvas
        ref={canvas}
        aria-hidden
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          touch.current = null;
        }}
        onContextMenu={(event) => {
          if (control) event.preventDefault();
        }}
        className={cn(
          "block size-full rounded-md bg-muted select-none",
          pictureSize === null && "invisible",
          control ? "cursor-default touch-none" : "pointer-events-none",
        )}
      />
      {!control && <BotCursor view={view} viewport={viewport} />}
      {control && (
        <textarea
          ref={field}
          data-browser-page=""
          defaultValue={SENTINEL}
          aria-label={label}
          aria-description={description}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onKey("down")}
          onKeyUp={onKey("up")}
          onCompositionEnd={(event) => {
            typed(event.data);
            clear();
          }}
          onInput={(event) => {
            const { nativeEvent } = event;
            if (!(nativeEvent instanceof InputEvent) || nativeEvent.isComposing) return;
            // A phone's keyboard often types, deletes and breaks lines without a key the page could take.
            switch (nativeEvent.inputType) {
              case "insertText":
              case "insertReplacementText":
                typed(nativeEvent.data ?? event.currentTarget.value);
                break;
              case "deleteContentBackward":
                pressKey("Backspace", "Backspace", 8);
                break;
              case "insertLineBreak":
                pressKey("Enter", "Enter", 13, "\r");
                break;
            }
            clear();
          }}
          // The operator's clipboard and files stay theirs: nothing is pasted or dropped into the page.
          onPaste={(event) => event.preventDefault()}
          onDrop={(event) => event.preventDefault()}
          className="pointer-events-none absolute start-0 top-0 size-px resize-none overflow-hidden border-0 p-0 opacity-0"
        />
      )}
    </div>
  );
}

/** Where the bot points while it acts, over the picture; it fades once still. */
function BotCursor({
  view,
  viewport,
}: {
  readonly view: BrowserViewHandle;
  readonly viewport: Size | null;
}) {
  const [cursor, setCursor] = useState<BrowserCursor | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const stop = view.onCursor((next) => {
      window.clearTimeout(timer);
      setCursor(next);
      timer = window.setTimeout(() => setCursor(null), CURSOR_REST_MS);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [view]);
  if (cursor === null || viewport === null || viewport.width === 0 || viewport.height === 0) {
    return null;
  }
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute transition-[left,top] duration-(--duration-state) ease-out"
      style={{
        left: `${(cursor.x / viewport.width) * 100}%`,
        top: `${(cursor.y / viewport.height) * 100}%`,
      }}
    >
      {cursor.action === "click" && (
        <span
          key={cursor.sequence}
          className="pop-in absolute -start-3 -top-3 size-6 rounded-pill border-2 border-foreground/70"
        />
      )}
      <MousePointer2Icon className="size-5 fill-foreground stroke-background" />
    </span>
  );
}
