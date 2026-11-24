// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserPicture, BrowserProbe, BrowserViewHandle } from "@j3-bots/client-runtime";
import {
  dragWheel,
  pagePoint,
  type PageSize,
  type Point,
} from "@j3-bots/client-runtime/presentation";
import type { BrowserInput } from "@j3-bots/contracts";
import * as Base64 from "effect/encoding/Base64";
import { type ComponentRef, useEffect, useEffectEvent, useRef, useState } from "react";
import { type GestureResponderEvent, Image, type LayoutChangeEvent, View } from "react-native";
import { TextInput } from "../text.tsx";
import { fieldChange, keyPress, relayed } from "./typing.ts";
import {
  dragged,
  drawnRect,
  fitted,
  keptInView,
  NO_ZOOM,
  pinched,
  type Size,
  type Zoom,
} from "./zoom.ts";

/** How far a finger moves before a touch is a drag, not a tap, in points. */
const TAP_SLOP = 8;
/** How long a still finger waits before its touch is a right-click. */
const LONG_PRESS_MS = 500;

/** A picture being drawn, and whether it has been. */
interface Layer {
  readonly sequence: number;
  readonly uri: string;
  readonly drawn: boolean;
}

/** What the fingers on the picture are doing. */
type Touch =
  | { readonly _tag: "none" }
  /** One finger down, not moved past the slop yet. */
  | {
      readonly _tag: "pending";
      readonly start: Point;
      readonly at: number;
      readonly zoom: Zoom;
    }
  /** One finger dragging: the page scrolls, or, only watching, the zoomed picture moves. */
  | { readonly _tag: "dragging"; readonly start: Point; readonly last: Point; readonly zoom: Zoom }
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

/**
 * The page, drawn from the view's pictures, fitted to the width at the top.
 * Two fingers zoom and move the picture; with one, a zoomed picture moves
 * while the operator only watches. While `interactive`, a tap clicks the
 * page, a drag scrolls it, a long press right-clicks, and a tap on a field
 * raises the keyboard, whose typing goes to the page through a hidden field.
 *
 * Each picture is drawn over the last and acknowledged once it is, so the
 * server sends the next only then, and the page never flickers between two.
 */
export function PageView({
  view,
  page,
  interactive,
  keyboardRequests,
  label,
}: {
  readonly view: BrowserViewHandle;
  readonly page: PageSize | null;
  readonly interactive: boolean;
  /** Grows each time the operator asks for the keyboard with its button. */
  readonly keyboardRequests: number;
  readonly label: string;
}) {
  const [layers, setLayers] = useState<ReadonlyArray<Layer>>(() => {
    const first = view.picture.get();
    return first === null ? [] : [layerOf(first)];
  });
  useEffect(
    () =>
      view.picture.subscribe(() => {
        const picture = view.picture.get();
        if (picture === null) return;
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
  const shape = viewSize !== null && page !== null ? fitted(viewSize, page) : null;
  // The keyboard rising makes the view shorter: the picture stays in it.
  const shown = shape !== null && viewSize !== null ? keptInView(zoom, shape, viewSize) : NO_ZOOM;
  const drawn = shape === null ? null : drawnRect(shape, shown);

  const field = useRef<ComponentRef<typeof TextInput>>(null);
  /** What the hidden field holds: what was typed into the page's field since it was tapped. */
  const typed = useRef("");
  /** The probe sent for the last tap, whose answer says whether to raise the keyboard. */
  const lastProbe = useRef<Point | null>(null);
  const sendAll = (inputs: ReadonlyArray<BrowserInput>) => {
    for (const input of inputs) view.send(input);
  };
  const focusField = () => {
    typed.current = "";
    field.current?.clear();
    field.current?.focus();
  };
  const raiseKeyboard = useEffectEvent(() => {
    if (interactive) focusField();
  });

  const probed = useEffectEvent((answer: BrowserProbe) => {
    const asked = lastProbe.current;
    // The answer to the probe of the last tap, give or take the rounding of a coordinate.
    if (asked === null || Math.abs(asked.x - answer.x) > 1 || Math.abs(asked.y - answer.y) > 1) {
      return;
    }
    lastProbe.current = null;
    if (answer.editable) focusField();
    else field.current?.blur();
  });
  useEffect(() => view.onProbe((answer) => probed(answer)), [view]);
  useEffect(() => {
    if (keyboardRequests > 0) raiseKeyboard();
  }, [keyboardRequests]);
  useEffect(() => {
    if (!interactive) field.current?.blur();
  }, [interactive]);

  const touch = useRef<Touch>({ _tag: "none" });
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopLongPress = () => {
    if (longPress.current !== null) clearTimeout(longPress.current);
    longPress.current = null;
  };

  /** The page point under `point` on the view, while the picture is laid out. */
  const onPage = (point: Point): Point | null =>
    drawn === null || page === null ? null : pagePoint(point, drawn, page);

  const begin = (event: GestureResponderEvent) => {
    stopLongPress();
    const points = pointsOf(event, origin.current);
    const [first, second] = points;
    if (first === undefined) return;
    if (second !== undefined) {
      touch.current = { _tag: "pinching", from: [first, second], zoom: shown };
      return;
    }
    touch.current = { _tag: "pending", start: first, at: Date.now(), zoom: shown };
    if (!interactive) return;
    longPress.current = setTimeout(() => {
      longPress.current = null;
      const target = onPage(first);
      if (touch.current._tag !== "pending" || target === null) return;
      touch.current = { _tag: "spent" };
      sendAll(click(target, "right"));
    }, LONG_PRESS_MS);
  };

  const move = (event: GestureResponderEvent) => {
    const points = pointsOf(event, origin.current);
    const [first, second] = points;
    if (first === undefined) return;
    const now = touch.current;
    if (second !== undefined) {
      stopLongPress();
      // A second finger joining a drag starts a pinch where both are now.
      if (now._tag !== "pinching") {
        touch.current = { _tag: "pinching", from: [first, second], zoom: shown };
        return;
      }
      setZoom(pinched(now.zoom, now.from, [first, second]));
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
        touch.current = { _tag: "dragging", start: now.start, last: now.start, zoom: now.zoom };
        return;
      }
      case "dragging": {
        const moved = { x: first.x - now.last.x, y: first.y - now.last.y };
        touch.current = { ...now, last: first };
        if (interactive) {
          const at = onPage(now.start);
          if (at === null || drawn === null || page === null) return;
          const wheel = dragWheel(moved, drawn, page);
          view.send({
            type: "wheel",
            x: at.x,
            y: at.y,
            deltaX: wheel.x,
            deltaY: wheel.y,
            modifiers: 0,
          });
          return;
        }
        setZoom(dragged(now.zoom, { x: first.x - now.start.x, y: first.y - now.start.y }));
        return;
      }
    }
  };

  const end = () => {
    stopLongPress();
    const now = touch.current;
    touch.current = { _tag: "none" };
    if (now._tag !== "pending" || !interactive) return;
    const target = onPage(now.start);
    if (target === null) return;
    // Whether the tap lands in a field is asked first, so its answer can raise the keyboard.
    lastProbe.current = target;
    view.send({ type: "probe", x: target.x, y: target.y });
    sendAll(click(target, "left"));
  };

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
      {/* Where the phone's keyboard types: never seen, and never kept or suggested from. */}
      <TextInput
        ref={field}
        editable={interactive}
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
