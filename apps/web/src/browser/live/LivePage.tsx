// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserProbe, BrowserViewHandle } from "@j3-bots/client-runtime";
import {
  drawnRect,
  easedToward,
  fitted,
  keptInView,
  LONG_PRESS_MS,
  NO_TOUCH,
  NO_ZOOM,
  otherButtonAt,
  type PageSize,
  type PageTouch,
  type Point,
  readingScale,
  seenPart,
  type Size,
  type TouchScene,
  type TouchStep,
  touchHeld,
  touchLifted,
  touchMoved,
  touchStarted,
  type Zoom,
  zoomedAbout,
  zoomOn,
} from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserInput, BrowserTabRef } from "@j3-bots/contracts";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "../../onboarding/motion";
import { BotCursors } from "../BotCursors";
import { modifiersOf, wheelDelta } from "../input";
import { PageField } from "../PageField";
import { keepPicture, useLastPicture } from "./pictures";

/** How long the mark of a tap stays where the finger touched. */
const TAP_MARK_MS = 500;
/** Where a field the keyboard types into stands, above the keyboard, in pixels from the view's bottom. */
const FIELD_ABOVE_KEYBOARD = 56;
/** How far from its target a following view still counts as sliding, in pixels. */
const SLIDING = 2;
/** The little map's width. */
const MAP_WIDTH = 72;

const same = (a: Zoom, b: Zoom) =>
  Math.abs(a.x - b.x) < SLIDING &&
  Math.abs(a.y - b.y) < SLIDING &&
  Math.abs(a.scale - b.scale) < 0.01;

/** What the live view asks of its page. */
export interface LivePageHandle {
  /** Moves the keyboard's typing on to the next field of the page, or back to the one before. */
  readonly field: (step: "next" | "previous") => void;
  /** Puts the keyboard down. */
  readonly doneTyping: () => void;
}

const tabKey = (step: "next" | "previous"): ReadonlyArray<BrowserInput> => {
  const modifiers = step === "previous" ? 8 : 0;
  return (["down", "up"] as const).map((action) => ({
    type: "key",
    action,
    key: "Tab",
    code: "Tab",
    keyCode: 9,
    modifiers,
  }));
};

/**
 * The page of the narrow web's live view, as the phone's: drawn from the
 * view's pictures with each bot's pointer over it, and what the person's
 * fingers do sent through the same steps (`pageTouch`). Following a bot, it
 * opens at a size that reads, where the bot acts, and slides after its
 * pointer; moving the view stops following, and the little map shows where
 * the view is. A tap clicks and marks where it landed, unless it only
 * stopped a view still sliding; a long press right-clicks; a tap on a field
 * raises the keyboard, which types into the page through a hidden field, and
 * brings the field up above it. A mouse's wheel scrolls the page.
 */
export function LivePage({
  tabRef,
  address,
  view,
  page,
  usable,
  send,
  onIt,
  follow,
  onFollowing,
  holding,
  onKeyboard,
  keyboardInset,
  label,
  description,
  onLeave,
  ref,
  children,
}: {
  readonly tabRef: BrowserTabRef;
  /** The page's address: the bots' pointers show afresh once it changes. */
  readonly address: string;
  readonly view: BrowserViewHandle;
  readonly page: PageSize | null;
  /** Whether the person's touches reach the page: not while it is frozen or used elsewhere. */
  readonly usable: boolean;
  /** Sends what the person did to the page, holding the tab as it does. */
  readonly send: (input: BrowserInput) => void;
  /** The bots on the tab, whose pointers show. */
  readonly onIt: ReadonlyArray<BotId>;
  /** The bot the view follows, while it does; null while the person moves it themselves. */
  readonly follow: BotId | null;
  /** The person moved the view, which stops following. */
  readonly onFollowing: (following: false) => void;
  /** The person uses the page: the bots' pointers step aside. */
  readonly holding: boolean;
  /** The keyboard rose on a field of the page, or went down. */
  readonly onKeyboard: (up: boolean) => void;
  /** How much of the view's bottom a phone's on-screen keyboard and the bar over it cover, in pixels. */
  readonly keyboardInset: number;
  readonly label: string;
  readonly description: string;
  /** The person pressed the key that leaves the page. */
  readonly onLeave: () => void;
  readonly ref?: Ref<LivePageHandle>;
  /** What stands over the page, as the button to follow again. */
  readonly children?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [viewSize, setViewSize] = useState<Size | null>(null);
  useEffect(() => {
    const element = stage.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setViewSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The newest picture, decoded, drawn at the zoom; acknowledged once drawn, so the next comes then.
  const [frame, setFrame] = useState<{
    readonly bitmap: ImageBitmap;
    readonly sequence: number;
  } | null>(null);
  useEffect(() => {
    let stopped = false;
    let decoding = false;
    let decoded: number | null = null;
    const decodeNewest = async () => {
      const picture = view.picture.get();
      if (decoding || picture === null || picture.sequence === decoded) return;
      decoding = true;
      decoded = picture.sequence;
      try {
        const next = await createImageBitmap(
          new Blob([picture.jpeg.slice()], { type: "image/jpeg" }),
        );
        if (stopped) {
          next.close();
          return;
        }
        keepPicture(tabRef, picture.jpeg, Date.now());
        setFrame({ bitmap: next, sequence: picture.sequence });
      } catch {
        // A picture that does not decode is passed over: the last one drawn stays, and the next comes.
        if (!stopped) view.ack(picture.sequence);
      } finally {
        decoding = false;
        if (!stopped) void decodeNewest();
      }
    };
    const stop = view.picture.subscribe(() => void decodeNewest());
    void decodeNewest();
    return () => {
      stopped = true;
      stop();
    };
  }, [view, tabRef]);
  // A frame is let go once the next is drawn in its place, or the page goes.
  useEffect(() => () => frame?.bitmap.close(), [frame]);

  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const picture = viewSize !== null && page !== null ? fitted(viewSize, page) : null;
  // The keyboard rising makes the view shorter: the picture stays in it.
  const shown =
    picture !== null && viewSize !== null ? keptInView(zoom, picture, viewSize) : NO_ZOOM;
  const drawn = picture === null ? null : drawnRect(picture, shown);

  const left = drawn?.left ?? 0;
  const top = drawn?.top ?? 0;
  const width = drawn?.width ?? 0;
  const height = drawn?.height ?? 0;
  useEffect(() => {
    const target = canvas.current;
    const context = target?.getContext("2d");
    const image = frame?.bitmap ?? null;
    if (target === null || context === null || context === undefined || viewSize === null) return;
    const ratio = window.devicePixelRatio || 1;
    const backing = {
      width: Math.round(viewSize.width * ratio),
      height: Math.round(viewSize.height * ratio),
    };
    if (target.width !== backing.width) target.width = backing.width;
    if (target.height !== backing.height) target.height = backing.height;
    context.clearRect(0, 0, backing.width, backing.height);
    if (image === null || width === 0) return;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, left * ratio, top * ratio, width * ratio, height * ratio);
  }, [frame, viewSize, left, top, width, height]);
  // Acknowledged once its frame is drawn: the server sends the next only then.
  const drawnSequence = frame?.sequence ?? null;
  useEffect(() => {
    if (drawnSequence !== null) view.ack(drawnSequence);
  }, [view, drawnSequence]);

  // Where the followed bot last pointed, in the page's CSS pixels.
  const [pointed, setPointed] = useState<ReadonlyMap<BotId, Point>>(new Map());
  const whose = useEffectEvent((botId: BotId | null) => botId ?? onIt[0] ?? null);
  useEffect(
    () =>
      view.onCursor((cursor) => {
        const botId = whose(cursor.botId);
        if (botId !== null) setPointed((now) => new Map(now).set(botId, cursor));
      }),
    [view],
  );

  // Where the view goes while it follows a bot: its pointer, at a size that reads, or the
  // page's top at that size before the bot has pointed anywhere.
  const followed = follow === null ? null : (pointed.get(follow) ?? null);
  const target =
    follow !== null && picture !== null && viewSize !== null && page !== null
      ? zoomOn(followed ?? { x: 0, y: 0 }, readingScale(viewSize, page), page, picture, viewSize)
      : null;
  const sliding = target !== null && !same(shown, target);
  // The view slides after the pointer, frame by frame, and rests where it gets to.
  const aimed = useEffectEvent(() => target);
  const following = follow !== null;
  useEffect(() => {
    if (!following) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const to = aimed();
      if (to !== null) {
        setZoom((current) => {
          const next = reduced ? to : easedToward(current, to, now - last);
          return same(next, current) && same(next, to) ? current : next;
        });
      }
      last = now;
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [following, reduced]);

  const field = useRef<HTMLTextAreaElement>(null);
  // A phone's keyboard rises for a finger or a pen; with a mouse, the field keeps the focus for the computer's keyboard.
  const coarse = useRef(false);
  /** The probe sent for the last tap, whose answer says whether to raise the keyboard. */
  const lastProbe = useRef<Point | null>(null);
  const sendAll = (inputs: ReadonlyArray<BrowserInput>) => {
    for (const input of inputs) send(input);
  };

  // The field the keyboard types into comes up above it, at a size that reads, and stays there as the keyboard moves.
  const typingAt = useRef<Point | null>(null);
  const bringUp = useEffectEvent((at: Point) => {
    typingAt.current = at;
    if (picture === null || viewSize === null || page === null) return;
    onFollowing(false);
    setZoom(
      zoomOn(at, readingScale(viewSize, page), page, picture, viewSize, {
        x: viewSize.width / 2,
        y: Math.max(viewSize.height - keyboardInset - FIELD_ABOVE_KEYBOARD, 0),
      }),
    );
  });
  // The part of the view the keyboard leaves, whether it covers the view or shrinks it.
  const aboveKeyboard = (viewSize?.height ?? 0) - keyboardInset;
  const keyboardMoved = useEffectEvent((visible: number) => {
    if (typingAt.current !== null && visible > 0) bringUp(typingAt.current);
  });
  useEffect(() => keyboardMoved(aboveKeyboard), [aboveKeyboard]);
  const probed = useEffectEvent((answer: BrowserProbe) => {
    const asked = lastProbe.current;
    // The answer to the probe of the last tap, give or take the rounding of a coordinate.
    if (asked === null || Math.abs(asked.x - answer.x) > 1 || Math.abs(asked.y - answer.y) > 1) {
      return;
    }
    lastProbe.current = null;
    if (!coarse.current) return;
    if (answer.editable) {
      field.current?.focus({ preventScroll: true });
      bringUp(asked);
    } else field.current?.blur();
  });
  useEffect(() => view.onProbe((answer) => probed(answer)), [view]);
  useEffect(() => {
    if (!usable) field.current?.blur();
  }, [usable]);
  // A page that goes, as when it freezes or its view ends, takes its keyboard with it.
  const keyboardGone = useEffectEvent(() => onKeyboard(false));
  useEffect(() => () => keyboardGone(), []);

  useImperativeHandle(
    ref,
    () => ({
      field: (step) => {
        for (const input of tabKey(step)) send(input);
      },
      doneTyping: () => {
        typingAt.current = null;
        field.current?.blur();
      },
    }),
    [send],
  );

  const [mark, setMark] = useState<{ readonly at: Point; readonly id: number } | null>(null);
  const marks = useRef(0);
  useEffect(() => {
    if (mark === null) return;
    const timer = window.setTimeout(() => setMark(null), TAP_MARK_MS);
    return () => window.clearTimeout(timer);
  }, [mark]);

  // The fingers on the page, by pointer, in the order they touched.
  const fingers = useRef(new Map<number, Point>());
  const touch = useRef<PageTouch>(NO_TOUCH);
  const longPress = useRef<number | null>(null);
  const stopLongPress = () => {
    if (longPress.current !== null) window.clearTimeout(longPress.current);
    longPress.current = null;
  };
  const scene = (): TouchScene => ({
    zoom: shown,
    picture,
    view: viewSize,
    page,
    usable,
    sliding,
  });
  /** What a step of the touch did: the view the person moved, a tap's mark, and the page's input. */
  const apply = (next: TouchStep) => {
    touch.current = next.touch;
    if (next.touch._tag !== "pending") stopLongPress();
    if (next.zoom !== null) {
      // The person moves the view themselves: it stays where they leave it.
      onFollowing(false);
      setZoom(next.zoom);
    }
    if (next.tapped !== null) {
      marks.current += 1;
      setMark({ at: next.tapped, id: marks.current });
    }
    const probe = next.send.find((input) => input.type === "probe");
    // Whether the tap lands in a field is asked first, so its answer can raise the keyboard.
    if (probe !== undefined) lastProbe.current = { x: probe.x, y: probe.y };
    sendAll(next.send);
    if (next.longPress) {
      longPress.current = window.setTimeout(() => {
        longPress.current = null;
        apply(touchHeld(touch.current, scene()));
      }, LONG_PRESS_MS);
    }
  };
  const pointOf = (event: ReactPointerEvent<HTMLElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const points = () => [...fingers.current.values()];

  // A mouse's wheel scrolls the page, grouped by frame, and a trackpad's pinch zooms the view, which is
  // only looking. Its listener must be able to prevent the browser's own scroll and zoom.
  const wheel = useRef<{
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    modifiers: number;
  } | null>(null);
  const onWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault();
    const element = stage.current;
    if (element === null || drawn === null || page === null) return;
    const rect = element.getBoundingClientRect();
    const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (event.ctrlKey) {
      if (picture === null || viewSize === null) return;
      onFollowing(false);
      setZoom(keptInView(zoomedAbout(shown, at, Math.exp(-event.deltaY / 100)), picture, viewSize));
      return;
    }
    if (!usable) return;
    const onPage = {
      x: ((at.x - drawn.left) / drawn.width) * page.width,
      y: ((at.y - drawn.top) / drawn.height) * page.height,
    };
    if (onPage.x < 0 || onPage.y < 0 || onPage.x > page.width || onPage.y > page.height) return;
    const delta = wheelDelta(event, drawn, page);
    const held = wheel.current;
    wheel.current = {
      ...onPage,
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
    const element = stage.current;
    if (element === null) return;
    const listener = (event: WheelEvent) => onWheel(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, []);

  const last = useLastPicture(tabRef);
  const map =
    follow === null && shown.scale > 1 && picture !== null && viewSize !== null
      ? seenPart(shown, picture, viewSize)
      : null;

  return (
    <div
      ref={stage}
      role="img"
      aria-label={label}
      className="relative min-h-0 flex-1 touch-none overflow-hidden bg-muted select-none"
      onPointerDown={(event) => {
        event.preventDefault();
        coarse.current = event.pointerType !== "mouse";
        // With a mouse, the computer's keyboard types into the page as soon as it is pressed.
        if (!coarse.current && usable) field.current?.focus({ preventScroll: true });
        if (event.pointerType === "mouse" && event.button !== 0) {
          // A mouse's other buttons click with that button, at once: only the main one taps and drags.
          const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : null;
          if (button !== null) sendAll(otherButtonAt(pointOf(event), button, scene()));
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        fingers.current.set(event.pointerId, pointOf(event));
        stopLongPress();
        apply(touchStarted(touch.current, points(), scene()));
      }}
      onPointerMove={(event) => {
        if (!fingers.current.has(event.pointerId)) return;
        fingers.current.set(event.pointerId, pointOf(event));
        apply(touchMoved(touch.current, points(), scene()));
      }}
      onPointerUp={(event) => {
        if (!fingers.current.delete(event.pointerId)) return;
        apply(touchLifted(touch.current, fingers.current.size, scene()));
      }}
      onPointerCancel={(event) => {
        fingers.current.delete(event.pointerId);
        stopLongPress();
        touch.current = fingers.current.size === 0 ? NO_TOUCH : { _tag: "spent" };
      }}
      // A long press is the page's right-click, not the browser's menu.
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas
        ref={canvas}
        aria-hidden
        className="absolute inset-0 block"
        style={{ width: viewSize?.width ?? 0, height: viewSize?.height ?? 0 }}
      />
      {drawn !== null && (
        <div
          className="pointer-events-none absolute"
          style={{ left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height }}
        >
          <BotCursors
            view={view}
            tab={tabRef}
            address={address}
            viewport={page}
            onIt={onIt}
            faded={holding}
          />
        </div>
      )}
      {mark !== null && (
        <span
          key={mark.id}
          aria-hidden
          className="pop-in pointer-events-none absolute size-9 rounded-pill border-2 border-foreground/60 bg-foreground/10"
          style={{ left: mark.at.x - 18, top: mark.at.y - 18 }}
        />
      )}
      {map !== null && last !== null && picture !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute end-3 top-3 overflow-hidden rounded-md border border-border bg-surface shadow-raised"
          style={{
            width: MAP_WIDTH,
            height: (MAP_WIDTH * picture.height) / Math.max(picture.width, 1),
          }}
        >
          <img src={last.url} alt="" className="size-full" />
          <span
            className="absolute rounded-xs border-2 border-accent"
            style={{
              left: `${map.left * 100}%`,
              top: `${map.top * 100}%`,
              width: `${map.width * 100}%`,
              height: `${map.height * 100}%`,
            }}
          />
        </div>
      )}
      {children}
      <PageField
        ref={field}
        usable={usable}
        send={send}
        label={label}
        description={description}
        onLeave={onLeave}
        onKeyboard={(up) => {
          if (!up) typingAt.current = null;
          if (!up || coarse.current) onKeyboard(up);
        }}
      />
    </div>
  );
}
