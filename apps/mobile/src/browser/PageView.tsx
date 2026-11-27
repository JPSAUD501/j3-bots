// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserPicture, BrowserProbe, BrowserViewHandle } from "@j3-bots/client-runtime";
import {
  draggedView,
  dragWheel,
  drawnRect,
  easedToward,
  fitted,
  keptInView,
  NO_ZOOM,
  pagePoint,
  type PageSize,
  pinched,
  type Point,
  readingScale,
  seenPart,
  type Size,
  type Zoom,
  zoomOn,
} from "@j3-bots/client-runtime/presentation";
import type { BotId, BrowserInput, BrowserTabRef } from "@j3-bots/contracts";
import * as Base64 from "effect/encoding/Base64";
import {
  type ComponentRef,
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { type GestureResponderEvent, Image, type LayoutChangeEvent, View } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { useReducedMotion } from "../motion.ts";
import { TextInput } from "../text.tsx";
import { BotCursors, type Cursors, withCursor } from "./BotCursors.tsx";
import { keepPicture } from "./pictures.ts";
import { fieldChange, keyPress, relayed } from "./typing.ts";

/** How far a finger moves before a touch is a drag, not a tap, in points. */
const TAP_SLOP = 8;
/** How long a still finger waits before its touch is a right-click. */
const LONG_PRESS_MS = 500;
/** How long the mark of a tap stays where the finger touched. */
const TAP_MARK_MS = 500;
/** Where a field the keyboard types into stands, above the keyboard, in points from the view's bottom. */
const FIELD_ABOVE_KEYBOARD = 56;
/** How far from its target a following view still counts as sliding, in points. */
const SLIDING = 2;

/** A picture being drawn, and whether it has been. */
interface Layer {
  readonly sequence: number;
  readonly uri: string;
  readonly drawn: boolean;
}

/** What the fingers on the picture are doing. */
type Touch =
  | { readonly _tag: "none" }
  /** One finger down, not moved past the slop yet. `sliding`: the view was still sliding after a bot. */
  | {
      readonly _tag: "pending";
      readonly start: Point;
      readonly zoom: Zoom;
      readonly sliding: boolean;
    }
  /** One finger dragging: the view moves, and past its edge the page scrolls. */
  | { readonly _tag: "dragging"; readonly last: Point }
  /** Two fingers zooming and moving the picture. */
  | { readonly _tag: "pinching"; readonly from: readonly [Point, Point]; readonly zoom: Zoom }
  /** The touch did what it does already, as a long press does; the rest of it does nothing. */
  | { readonly _tag: "spent" };

const layerOf = (picture: BrowserPicture): Layer => ({
  sequence: picture.sequence,
  uri: `data:image/jpeg;base64,${Base64.encode(picture.jpeg)}`,
  drawn: false,
});

const pointsOf = (event: GestureResponderEvent, origin: Point): ReadonlyArray<Point> =>
  event.nativeEvent.touches.map((touch) => ({
    x: touch.pageX - origin.x,
    y: touch.pageY - origin.y,
  }));

const click = (at: Point, button: "left" | "right"): ReadonlyArray<BrowserInput> => {
  const pressed = button === "left" ? 1 : 2;
  const pointer = { x: at.x, y: at.y, clickCount: 1, modifiers: 0 } as const;
  return [
    { type: "pointer", action: "move", button: "none", buttons: 0, ...pointer },
    { type: "pointer", action: "down", button, buttons: pressed, ...pointer },
    { type: "pointer", action: "up", button, buttons: 0, ...pointer },
  ];
};

const same = (a: Zoom, b: Zoom) =>
  Math.abs(a.x - b.x) < SLIDING &&
  Math.abs(a.y - b.y) < SLIDING &&
  Math.abs(a.scale - b.scale) < 0.01;

/** What the live view asks of its page and is told by it. */
export interface PageViewHandle {
  /** Moves the keyboard's typing on to the next field of the page, or back to the one before. */
  readonly field: (step: "next" | "previous") => void;
  /** Puts the keyboard down. */
  readonly doneTyping: () => void;
}

/**
 * The page, drawn from the view's pictures, with each bot's pointer over it.
 *
 * Following a bot, it opens at a size that reads, where the bot acts, and
 * slides after its pointer. Two fingers zoom; one moves the zoomed view and,
 * past its edge, scrolls the page itself, as a phone's browser does. Moving
 * the view stops following, and the little map shows where the view is. A
 * tap clicks the page and marks where it landed, unless it only stopped a
 * view still sliding; a long press right-clicks; a tap on a field raises the
 * phone's keyboard, which types into the page through a hidden field and
 * brings the field up above it.
 *
 * Each picture is drawn over the last and acknowledged once it is, so the
 * server sends the next only then, and the page never flickers between two.
 */
export function PageView({
  tabRef,
  view,
  page,
  usable,
  send,
  onIt,
  follow,
  onFollowing,
  holding,
  onKeyboard,
  ref,
  label,
  children,
}: {
  readonly tabRef: BrowserTabRef;
  readonly view: BrowserViewHandle;
  readonly page: PageSize | null;
  /** Whether the person's touches reach the page: not while it is frozen. */
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
  readonly ref?: Ref<PageViewHandle>;
  readonly label: string;
  /** What stands over the page, as the little map's button to follow again. */
  readonly children?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const [layers, setLayers] = useState<ReadonlyArray<Layer>>(() => {
    const first = view.picture.get();
    return first === null ? [] : [layerOf(first)];
  });
  useEffect(
    () =>
      view.picture.subscribe(() => {
        const picture = view.picture.get();
        if (picture === null) return;
        keepPicture(tabRef, picture.jpeg, Date.now());
        setLayers((now) => [
          // The newest drawn picture stays under the one coming until that one is drawn.
          ...now.filter((layer) => layer.drawn).slice(-1),
          layerOf(picture),
        ]);
      }),
    [view, tabRef],
  );
  const drawnLayer = (sequence: number) => {
    setLayers((now) =>
      now.flatMap((layer) =>
        layer.sequence < sequence
          ? []
          : [layer.sequence === sequence ? { ...layer, drawn: true } : layer],
      ),
    );
    view.ack(sequence);
  };
  /** A picture that cannot be decoded is passed over: the last one drawn stays, and the next comes. */
  const skipLayer = (sequence: number) => {
    setLayers((now) => now.filter((layer) => layer.sequence !== sequence));
    view.ack(sequence);
  };

  // Each bot's newest pointer.
  const [cursors, setCursors] = useState<Cursors>(new Map());
  const onItNow = useRef(onIt);
  useEffect(() => {
    onItNow.current = onIt;
  }, [onIt]);
  useEffect(
    () => view.onCursor((cursor) => setCursors((now) => withCursor(now, cursor, onItNow.current))),
    [view],
  );

  const [viewSize, setViewSize] = useState<Size | null>(null);
  const origin = useRef<Point>({ x: 0, y: 0 });
  const frame = useRef<ComponentRef<typeof View>>(null);
  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setViewSize({ width, height });
    frame.current?.measureInWindow((x, y) => {
      origin.current = { x, y };
    });
  };

  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const picture = viewSize !== null && page !== null ? fitted(viewSize, page) : null;
  // The keyboard rising makes the view shorter: the picture stays in it.
  const shown =
    picture !== null && viewSize !== null ? keptInView(zoom, picture, viewSize) : NO_ZOOM;
  const drawn = picture === null ? null : drawnRect(picture, shown);

  // Where the view goes while it follows a bot: its pointer, at a size that reads, or the
  // page's top at that size before the bot has pointed anywhere.
  const followed = follow === null ? null : (cursors.get(follow) ?? null);
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
    let last = Date.now();
    let frameId = requestAnimationFrame(function step() {
      const now = Date.now();
      const to = aimed();
      if (to !== null) {
        setZoom((current) => {
          const next = reduced ? to : easedToward(current, to, now - last);
          return same(next, current) && same(next, to) ? current : next;
        });
      }
      last = now;
      frameId = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frameId);
  }, [following, reduced]);

  const field = useRef<ComponentRef<typeof TextInput>>(null);
  /** What the hidden field holds: what was typed into the page's field since it was tapped. */
  const typed = useRef("");
  /** The probe sent for the last tap, whose answer says whether to raise the keyboard. */
  const lastProbe = useRef<Point | null>(null);
  const sendAll = (inputs: ReadonlyArray<BrowserInput>) => {
    for (const input of inputs) send(input);
  };
  const focusField = () => {
    typed.current = "";
    field.current?.clear();
    field.current?.focus();
  };

  // The field the keyboard types into comes up above it, at a size that reads.
  const bringUp = useEffectEvent((at: Point) => {
    if (picture === null || viewSize === null || page === null) return;
    onFollowing(false);
    setZoom(
      zoomOn(at, readingScale(viewSize, page), page, picture, viewSize, {
        x: viewSize.width / 2,
        y: viewSize.height - FIELD_ABOVE_KEYBOARD,
      }),
    );
  });
  const probed = useEffectEvent((answer: BrowserProbe) => {
    const asked = lastProbe.current;
    // The answer to the probe of the last tap, give or take the rounding of a coordinate.
    if (asked === null || Math.abs(asked.x - answer.x) > 1 || Math.abs(asked.y - answer.y) > 1) {
      return;
    }
    lastProbe.current = null;
    if (answer.editable) {
      focusField();
      bringUp(asked);
    } else field.current?.blur();
  });
  useEffect(() => view.onProbe((answer) => probed(answer)), [view]);
  useEffect(() => {
    if (!usable) field.current?.blur();
  }, [usable]);

  useImperativeHandle(
    ref,
    () => ({
      field: (step) => {
        for (const input of keyPress("Tab", step === "previous")) send(input);
      },
      doneTyping: () => field.current?.blur(),
    }),
    [send],
  );

  const [mark, setMark] = useState<{ readonly at: Point; readonly id: number } | null>(null);
  const marks = useRef(0);
  useEffect(() => {
    if (mark === null) return;
    const timer = setTimeout(() => setMark(null), TAP_MARK_MS);
    return () => clearTimeout(timer);
  }, [mark]);

  const touch = useRef<Touch>({ _tag: "none" });
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopLongPress = () => {
    if (longPress.current !== null) clearTimeout(longPress.current);
    longPress.current = null;
  };

  /** The page point under `point` on the view, while the picture is laid out. */
  const onPage = (point: Point): Point | null =>
    drawn === null || page === null ? null : pagePoint(point, drawn, page);

  /** The person moves the view themselves: it stays where they leave it. */
  const moveView = (next: Zoom) => {
    onFollowing(false);
    setZoom(next);
  };

  const begin = (event: GestureResponderEvent) => {
    stopLongPress();
    const [first, second] = pointsOf(event, origin.current);
    if (first === undefined) return;
    if (second !== undefined) {
      touch.current = { _tag: "pinching", from: [first, second], zoom: shown };
      return;
    }
    touch.current = { _tag: "pending", start: first, zoom: shown, sliding };
    if (!usable || sliding) return;
    longPress.current = setTimeout(() => {
      longPress.current = null;
      const target = onPage(first);
      if (touch.current._tag !== "pending" || target === null) return;
      touch.current = { _tag: "spent" };
      sendAll(click(target, "right"));
    }, LONG_PRESS_MS);
  };

  const move = (event: GestureResponderEvent) => {
    const [first, second] = pointsOf(event, origin.current);
    if (first === undefined) return;
    const now = touch.current;
    if (second !== undefined) {
      stopLongPress();
      // A second finger joining a drag starts a pinch where both are now.
      if (now._tag !== "pinching") {
        touch.current = { _tag: "pinching", from: [first, second], zoom: shown };
        return;
      }
      moveView(pinched(now.zoom, now.from, [first, second]));
      return;
    }
    switch (now._tag) {
      case "none":
      case "spent":
      case "pinching":
        // A finger left a pinch: the rest of the touch only lets go.
        touch.current = { _tag: "spent" };
        return;
      case "pending": {
        if (Math.hypot(first.x - now.start.x, first.y - now.start.y) < TAP_SLOP) return;
        stopLongPress();
        touch.current = { _tag: "dragging", last: now.start };
        return;
      }
      case "dragging": {
        const moved = { x: first.x - now.last.x, y: first.y - now.last.y };
        touch.current = { _tag: "dragging", last: first };
        if (picture === null || viewSize === null) return;
        const { zoom: next, scroll } = draggedView(shown, moved, picture, viewSize);
        moveView(next);
        // What the view could not take scrolls the page, which is using it.
        if (!usable || (scroll.x === 0 && scroll.y === 0)) return;
        const at = onPage(first);
        if (at === null || drawn === null || page === null) return;
        const wheel = dragWheel(scroll, drawn, page);
        send({ type: "wheel", x: at.x, y: at.y, deltaX: wheel.x, deltaY: wheel.y, modifiers: 0 });
        return;
      }
    }
  };

  const end = () => {
    stopLongPress();
    const now = touch.current;
    touch.current = { _tag: "none" };
    if (now._tag !== "pending") return;
    // A tap on a view still sliding after a bot only stops it, as on any list.
    if (now.sliding) {
      moveView(shown);
      return;
    }
    if (!usable) return;
    const target = onPage(now.start);
    if (target === null) return;
    marks.current += 1;
    setMark({ at: now.start, id: marks.current });
    // Whether the tap lands in a field is asked first, so its answer can raise the keyboard.
    lastProbe.current = target;
    send({ type: "probe", x: target.x, y: target.y });
    sendAll(click(target, "left"));
  };

  const lastDrawn = layers.findLast((layer) => layer.drawn) ?? null;
  const map =
    follow === null && shown.scale > 1 && picture !== null && viewSize !== null
      ? seenPart(shown, picture, viewSize)
      : null;

  return (
    <View
      ref={frame}
      onLayout={onLayout}
      className="flex-1 overflow-hidden"
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={begin}
      // A second finger joins the touch as it lands.
      onResponderStart={begin}
      onResponderMove={move}
      onResponderRelease={end}
      onResponderTerminate={() => {
        stopLongPress();
        touch.current = { _tag: "none" };
      }}
    >
      {drawn !== null &&
        layers.map((layer) => (
          <Image
            key={layer.sequence}
            source={{ uri: layer.uri }}
            fadeDuration={0}
            onLoad={() => drawnLayer(layer.sequence)}
            onError={() => skipLayer(layer.sequence)}
            resizeMode="stretch"
            style={{
              position: "absolute",
              left: drawn.left,
              top: drawn.top,
              width: drawn.width,
              height: drawn.height,
              opacity: layer.drawn ? 1 : 0,
            }}
          />
        ))}
      {drawn !== null && page !== null && (
        <BotCursors cursors={cursors} onIt={onIt} drawn={drawn} page={page} faded={holding} />
      )}
      {mark !== null && (
        <Animated.View
          key={mark.id}
          pointerEvents="none"
          exiting={FadeOut.duration(TAP_MARK_MS)}
          className="absolute size-9 rounded-pill border-2 border-foreground/60 bg-foreground/10"
          style={{ left: mark.at.x - 18, top: mark.at.y - 18 }}
        />
      )}
      {map !== null && lastDrawn !== null && picture !== null && (
        <View
          pointerEvents="none"
          accessibilityLabel={undefined}
          className="absolute end-3 top-3 overflow-hidden rounded-md border border-border bg-surface shadow-raised"
          style={{ width: 72, height: (72 * picture.height) / Math.max(picture.width, 1) }}
        >
          <Image source={{ uri: lastDrawn.uri }} resizeMode="stretch" className="size-full" />
          <View
            className="absolute rounded-xs border-2 border-accent"
            style={{
              left: `${map.left * 100}%`,
              top: `${map.top * 100}%`,
              width: `${map.width * 100}%`,
              height: `${map.height * 100}%`,
            }}
          />
        </View>
      )}
      {children}
      {/* Where the phone's keyboard types: never seen, and never kept or suggested from. */}
      <TextInput
        ref={field}
        editable={usable}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        spellCheck={false}
        keyboardType="visible-password"
        returnKeyType="go"
        submitBehavior="submit"
        caretHidden
        contextMenuHidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onFocus={() => onKeyboard(true)}
        onBlur={() => onKeyboard(false)}
        onChangeText={(next) => {
          sendAll(relayed(fieldChange(typed.current, next)));
          typed.current = next;
        }}
        onKeyPress={({ nativeEvent }) => {
          // An empty field changes nothing on Backspace: the page's field may still hold text.
          if (nativeEvent.key === "Backspace" && typed.current === "") {
            sendAll(keyPress("Backspace"));
          }
        }}
        onSubmitEditing={() => sendAll(keyPress("Enter"))}
        className="absolute -left-24 bottom-0 h-px w-px opacity-0"
      />
    </View>
  );
}
