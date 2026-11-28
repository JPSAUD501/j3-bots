// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserPicture, BrowserProbe, BrowserViewHandle } from "@j3-bots/client-runtime";
import {
  drawnRect,
  followedView,
  glidedBetween,
  fitted,
  keptInView,
  LONG_PRESS_MS,
  NO_TOUCH,
  NO_ZOOM,
  type PageSize,
  type PageTouch,
  type Point,
  readingScale,
  restingZoom,
  seenPart,
  type Size,
  type TouchScene,
  type TouchStep,
  touchHeld,
  touchLifted,
  touchMoved,
  touchStarted,
  viewGlideFor,
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
 * A computer's page, wider than the view's shape, rests filling the view's
 * height from its top-left (`restingZoom`). Following a bot, the view keeps
 * its point in sight, gliding as the pointer does once the bot works near an
 * edge (`followedView`). Two fingers zoom; one moves the zoomed view and,
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
  ref,
  label,
  children,
}: {
  readonly tabRef: BrowserTabRef;
  /** The page's address: the bots' pointers show afresh once it changes. */
  readonly address: string;
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
  // Kept with the address the page has as the picture comes.
  const keep = useEffectEvent((jpeg: Uint8Array) => keepPicture(tabRef, jpeg, Date.now(), address));
  useEffect(
    () =>
      view.picture.subscribe(() => {
        const picture = view.picture.get();
        if (picture === null) return;
        keep(picture.jpeg);
        setLayers((now) => [
          // The newest drawn picture stays under the one coming until that one is drawn.
          ...now.filter((layer) => layer.drawn).slice(-1),
          layerOf(picture),
        ]);
      }),
    [view],
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

  // Null while the view rests, until the person moves it or it follows a bot.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const picture = viewSize !== null && page !== null ? fitted(viewSize, page) : null;
  // The keyboard rising makes the view shorter: the picture stays in it.
  const shown =
    picture === null || viewSize === null
      ? NO_ZOOM
      : zoom === null
        ? restingZoom(picture, viewSize)
        : keptInView(zoom, picture, viewSize);
  const drawn = picture === null ? null : drawnRect(picture, shown);

  // Where the view heads while it follows a bot: from where it rests, moved only as far as keeps
  // the bot's point in sight, each time the bot points elsewhere.
  const point = follow === null ? null : (cursors.get(follow) ?? null);
  const aimFor =
    follow === null || picture === null || viewSize === null || page === null
      ? null
      : `${follow} ${point?.x ?? ""} ${point?.y ?? ""} ${viewSize.width} ${viewSize.height} ${page.width} ${page.height}`;
  const [aim, setAim] = useState<{ readonly for: string; readonly zoom: Zoom } | null>(null);
  if ((aim?.for ?? null) !== aimFor) {
    setAim(
      aimFor === null || picture === null || viewSize === null || page === null
        ? null
        : { for: aimFor, zoom: followedView(aim?.zoom ?? null, point, page, picture, viewSize) },
    );
  }
  const target = aim !== null && aim.for === aimFor ? aim.zoom : null;
  const sliding = target !== null && !same(shown, target);
  // The view glides after the point as the pointer does, and rests where it gets to.
  const aimed = useEffectEvent(() => ({ to: target, from: shown, view: viewSize }));
  const following = follow !== null;
  useEffect(() => {
    if (!following) return;
    let glide: {
      readonly from: Zoom;
      readonly to: Zoom;
      readonly start: number;
      readonly duration: number;
    } | null = null;
    let frameId = requestAnimationFrame(function step() {
      const now = Date.now();
      const { to, from, view: size } = aimed();
      if (to !== null && size !== null) {
        if (glide === null || !same(glide.to, to)) {
          glide = { from, to, start: now, duration: reduced ? 0 : viewGlideFor(from, to, size) };
        }
        const next = glidedBetween(glide.from, glide.to, now - glide.start, glide.duration);
        setZoom((current) => (current !== null && same(next, current) ? current : next));
      }
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

  const touch = useRef<PageTouch>(NO_TOUCH);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopLongPress = () => {
    if (longPress.current !== null) clearTimeout(longPress.current);
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
      longPress.current = setTimeout(() => {
        longPress.current = null;
        apply(touchHeld(touch.current, scene()));
      }, LONG_PRESS_MS);
    }
  };
  const fingers = (event: GestureResponderEvent) => pointsOf(event, origin.current);

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
      onResponderGrant={(event) => {
        stopLongPress();
        apply(touchStarted(touch.current, fingers(event), scene()));
      }}
      // A second finger joins the touch as it lands.
      onResponderStart={(event) => {
        stopLongPress();
        apply(touchStarted(touch.current, fingers(event), scene()));
      }}
      onResponderMove={(event) => apply(touchMoved(touch.current, fingers(event), scene()))}
      // The responder lets go once the last finger has.
      onResponderRelease={() => apply(touchLifted(touch.current, 0, scene()))}
      onResponderTerminate={() => {
        stopLongPress();
        touch.current = NO_TOUCH;
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
        <BotCursors
          cursors={cursors}
          tab={tabRef}
          address={address}
          onIt={onIt}
          drawn={drawn}
          page={page}
          held={holding}
        />
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
