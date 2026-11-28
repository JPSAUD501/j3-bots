// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BrowserCursor } from "@j3-bots/client-runtime";
import type { DrawnRect, PageSize } from "@j3-bots/client-runtime/presentation";
import type { Bot, BotId, BrowserTabRef } from "@j3-bots/contracts";
import { glideCurve, glideFor, motion } from "@j3-bots/design-tokens";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { useBots } from "../presentation.tsx";
import { Text } from "../text.tsx";
import { useBotInk } from "../conversation/tint.ts";
import { useReducedMotion } from "../motion.ts";

const glideEase = Easing.bezier(...glideCurve);

/** How long a still pointer keeps its name before only its face shows. */
const NAME_FOR_MS = 2_000;
/** How long the ring of a bot's click shows. */
const CLICK_RING_MS = 450;

/** Each bot's newest pointer on the tab, by bot. */
export type Cursors = ReadonlyMap<BotId, BrowserCursor>;

/**
 * Adds `cursor` to `cursors`. A pointer from a server before shared tabs
 * names no bot: it is the tab's one bot's.
 */
export const withCursor = (
  cursors: Cursors,
  cursor: BrowserCursor,
  onIt: ReadonlyArray<BotId>,
): Cursors => {
  const botId = cursor.botId ?? onIt[0];
  if (botId === undefined) return cursors;
  return new Map(cursors).set(botId, cursor);
};

/**
 * Each bot's pointer over the page, in its own color, with a small label of
 * its face and name on the surface, so it reads in every theme, the way documents written by several hands show who is
 * where. The label shrinks to the face after two seconds still and comes
 * back as the pointer moves. While the person uses the page the pointers
 * step aside, faded. Only bots on the tab show. A pointer fades in where it
 * first points and glides to each next spot; one from another tab, or from
 * before the page went to `address`, waits to show again where it next points.
 */
export function BotCursors({
  cursors,
  tab,
  address,
  onIt,
  drawn,
  page,
  faded,
}: {
  readonly cursors: Cursors;
  readonly tab: BrowserTabRef;
  readonly address: string;
  readonly onIt: ReadonlyArray<BotId>;
  readonly drawn: DrawnRect;
  readonly page: PageSize;
  readonly faded: boolean;
}) {
  const bots = useBots();
  // The pointers there were as the tab or its page last changed, which no longer say where the bots are.
  const place = `${tab} ${address}`;
  const [since, setSince] = useState<{ readonly place: string; readonly stale: Cursors }>({
    place,
    stale: new Map(),
  });
  if (since.place !== place) setSince({ place, stale: cursors });
  return (
    <View
      pointerEvents="none"
      className="absolute inset-0"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {onIt.flatMap((botId) => {
        const cursor = cursors.get(botId);
        const bot = bots.get(botId);
        if (
          cursor === undefined ||
          cursor === since.stale.get(botId) ||
          bot === undefined ||
          page.width <= 0 ||
          page.height <= 0
        ) {
          return [];
        }
        return [
          <Pointer key={botId} bot={bot} cursor={cursor} page={page} drawn={drawn} faded={faded} />,
        ];
      })}
    </View>
  );
}

function Pointer({
  bot,
  cursor,
  page,
  drawn,
  faded,
}: {
  readonly bot: Bot;
  readonly cursor: BrowserCursor;
  readonly page: PageSize;
  readonly drawn: DrawnRect;
  readonly faded: boolean;
}) {
  const ink = useBotInk(bot.profile.avatar);
  const reduced = useReducedMotion();
  // Where it points, as shares of the page, so zooming and panning the page move it at once.
  const x = useSharedValue(cursor.x / page.width);
  const y = useSharedValue(cursor.y / page.height);
  useEffect(() => {
    const toX = cursor.x / page.width;
    const toY = cursor.y / page.height;
    if (reduced) {
      x.set(toX);
      y.set(toY);
      return;
    }
    // The move's length as a share of the page's diagonal sets how long it glides.
    const share =
      Math.hypot((toX - x.get()) * page.width, (toY - y.get()) * page.height) /
      Math.hypot(page.width, page.height);
    const glide = { duration: glideFor(share), easing: glideEase };
    x.set(withTiming(toX, glide));
    y.set(withTiming(toY, glide));
  }, [cursor.x, cursor.y, page.width, page.height, reduced, x, y]);
  const placed = useAnimatedStyle(() => ({
    left: drawn.left + x.get() * drawn.width,
    top: drawn.top + y.get() * drawn.height,
  }));
  // The name shows from each move until it has been still a while; a click rings where it landed.
  const [seen, setSeen] = useState(cursor.sequence);
  // The move the name shows from, null once it has been still a while.
  const [namedAt, setNamedAt] = useState<number | null>(cursor.sequence);
  const named = namedAt !== null;
  const [ring, setRing] = useState<number | null>(
    cursor.action === "click" ? cursor.sequence : null,
  );
  if (seen !== cursor.sequence) {
    setSeen(cursor.sequence);
    if (cursor.action === "move") setNamedAt(cursor.sequence);
    else setRing(cursor.sequence);
  }
  useEffect(() => {
    if (namedAt === null) return;
    const timer = setTimeout(() => setNamedAt(null), NAME_FOR_MS);
    return () => clearTimeout(timer);
  }, [namedAt]);
  useEffect(() => {
    if (ring === null) return;
    const timer = setTimeout(() => setRing(null), CLICK_RING_MS);
    return () => clearTimeout(timer);
  }, [ring]);
  return (
    <Animated.View
      entering={FadeIn.duration(motion.state)}
      style={[{ position: "absolute", opacity: faded ? 0.35 : 1 }, placed]}
    >
      {ring !== null && (
        <Animated.View
          key={ring}
          exiting={FadeOut.duration(CLICK_RING_MS)}
          style={{
            position: "absolute",
            left: -12,
            top: -12,
            width: 24,
            height: 24,
            borderRadius: 12,
            borderWidth: 2,
            borderColor: ink,
          }}
        />
      )}
      <Svg width={14} height={18} viewBox="0 0 14 18">
        <Path
          d="M1 1 L1 15 L4.8 11.4 L7.4 17 L9.8 16 L7.3 10.4 L12.6 10.4 Z"
          fill={ink}
          stroke="white"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      </Svg>
      <View
        className="absolute flex-row items-center gap-1 rounded-pill border bg-surface py-0.5 ps-0.5"
        style={{ left: 12, top: 14, borderColor: ink, paddingEnd: named ? 8 : 2 }}
      >
        <BotAvatar avatar={bot.profile.avatar} seed={bot.id} state="idle" size={14} still />
        {named && (
          <Text numberOfLines={1} className="text-2xs font-semibold text-foreground">
            {bot.profile.name}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}
