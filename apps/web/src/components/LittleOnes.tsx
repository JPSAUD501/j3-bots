// SPDX-License-Identifier: AGPL-3.0-or-later
import { Popover } from "@base-ui/react/popover";
import type { Avatar, LittleOne, LittleOnes as TurnLittleOnes } from "@j3-bots/contracts";
import {
  type AvatarPoke,
  createLitter,
  dismissLitter,
  litterLines,
  type LitterPlace,
  litterPokes,
  type LitterSim,
  litterStrands,
  litterTravels,
  littleFace,
  littleSpot,
  perkLittle,
  settleLitter,
  shortDuration,
  shownLittleOnes,
  stepLitter,
  stillLittle,
  syncLitter,
} from "@j3-bots/client-runtime/presentation";
import { type AvatarShapeName, litter, resolveAvatar } from "@j3-bots/design-tokens";
import * as DateTime from "effect/DateTime";
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import { useSeconds } from "../app/clock";
import { useI18n } from "../app/context";
import { type AvatarHandle, AvatarParts, AVATAR_VIEW_BOX, painter } from "./avatar/BotAvatar";
import { animate, reducedMotion } from "./avatar/ticker";

/** A little one's line, its own size and the bot's beside the turn, in px. */
const ROW = 28;
const PARENT = 24;
const SIZE = PARENT * litter.share;

/** What a mounted family takes from its component. */
interface Controller {
  /** Who works now, who failed, and whether a line counts those not shown. */
  readonly sync: (
    working: ReadonlyArray<string>,
    failed: ReadonlyArray<string>,
    more: boolean,
  ) => void;
  /** The turn is over: the family goes with the bot's face. */
  readonly dismiss: () => void;
  /** The pointer came over one. */
  readonly perk: (id: string) => void;
  readonly stop: () => void;
}

/** One little one's elements, and what was last written to them. */
interface Drawn {
  readonly row: HTMLElement;
  readonly body: HTMLElement;
  readonly paint: ReturnType<typeof painter>;
}

/**
 * Starts the family drawn in `root` on the shared frame loop. Its rows are
 * React's (`[data-little]`, one per little one); a frame writes each one's
 * place and face, the strands that hold them to the bot, and the block's
 * height. `anchor` is the element that frames the bot's face, which says how
 * far above the block its feet stand; `poke` makes the bot answer; `left`
 * names the little ones the family still holds whenever one is gone.
 */
function mountLitter(
  root: HTMLElement,
  strand: SVGPathElement,
  count: HTMLElement,
  working: ReadonlyArray<string>,
  more: boolean,
  on: {
    readonly shape: () => AvatarShapeName;
    readonly anchor: () => HTMLElement | null;
    readonly poke: (poke: AvatarPoke) => void;
    readonly left: (ids: ReadonlyArray<string>) => void;
  },
): Controller {
  let place: LitterPlace = { row: ROW, size: SIZE, parent: PARENT, rise: 4 };
  let sim = createLitter(working, more, place);
  let held = sim.ones.map((one) => one.id).join("\n");
  let failing = 0;
  const drawn = new Map<string, Drawn>();
  const written = new WeakMap<Element, Map<string, string>>();
  /** Writes `value` only when it is not what was last written there. */
  const write = (element: Element, name: string, value: string, set: () => void) => {
    let values = written.get(element);
    if (values === undefined) {
      values = new Map();
      written.set(element, values);
    }
    if (values.get(name) === value) return;
    values.set(name, value);
    set();
  };
  const style = (element: HTMLElement, name: string, value: string) =>
    write(element, name, value, () => element.style.setProperty(name, value));
  const attribute = (element: Element, name: string, value: string) =>
    write(element, name, value, () => element.setAttribute(name, value));

  const find = (id: string): Drawn | null => {
    const known = drawn.get(id);
    if (known !== undefined && known.row.isConnected) return known;
    drawn.delete(id);
    const row = root.querySelector<HTMLElement>(`[data-little="${CSS.escape(id)}"]`);
    const body = row?.querySelector<HTMLElement>("[data-little-body]");
    const svg = body?.querySelector("svg");
    if (row === null || row === undefined || body === null || body === undefined) return null;
    if (svg === null || svg === undefined) return null;
    const found = { row, body, paint: painter(svg, () => SIZE, on.shape, true) };
    drawn.set(id, found);
    return found;
  };

  /** Where the bot's feet stand above the block, as the page lays them out now. */
  const measure = () => {
    const anchor = on.anchor();
    if (anchor === null) return;
    const rise = root.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom;
    place = { ...place, rise: Math.round(rise * 4) / 4 };
  };

  const draw = (still: boolean) => {
    style(root, "height", `${Math.max(0, Math.round(sim.height.x * 4) / 4)}px`);
    for (const one of sim.ones) {
      const parts = find(one.id);
      if (parts === null) continue;
      const spot = littleSpot(one);
      const rest = spot.line + place.row / 2 + place.size / 2;
      style(parts.row, "transform", `translateY(${spot.line}px)`);
      // One on its way passes behind the ones that stand.
      style(parts.row, "z-index", spot.travelling ? "0" : "1");
      attribute(parts.row, "data-shown", String(spot.shown));
      attribute(parts.row, "data-words", String(spot.words));
      attribute(parts.row, "data-failed", String(spot.failed));
      style(parts.body, "transform", `translateY(${spot.y - rest}px) scale(${spot.scale})`);
      parts.paint(still ? stillLittle(spot.failed) : littleFace(one, sim.time));
    }
    attribute(strand, "d", still ? "" : litterStrands(sim, place));
    // The line that counts the rest stands under the last line taken.
    style(count, "transform", `translateY(${litterLines(sim) * place.row}px)`);
  };

  /** Tells the component who is left once someone is gone. */
  const report = () => {
    const ids = sim.ones.map((one) => one.id);
    const key = ids.join("\n");
    if (key === held) return;
    held = key;
    on.left(ids);
  };

  /** The family as it is with nothing travelling: off screen, over the cap, under reduced motion. */
  const settle = () => {
    sim = settleLitter(sim, place, reducedMotion());
    draw(true);
    report();
  };

  const running = animate(
    {
      size: SIZE,
      moving: () => !reducedMotion() && (sim.ones.length > 0 || litterTravels(sim)),
      measure: null,
      step: (dt) => {
        const before = sim;
        sim = stepLitter(sim, dt, place);
        for (const poke of litterPokes(before, sim)) on.poke(poke);
        draw(false);
        report();
      },
      still: settle,
      everyFrame: () => litterTravels(sim),
    },
    root,
  );

  /** What changed is drawn: by the loop when it moves, at once when it does not. */
  const changed = (before: LitterSim) => {
    if (reducedMotion()) {
      settle();
      // Reduced motion keeps that one failed, grey at its line, and lets it go a moment later.
      window.clearTimeout(failing);
      if (sim.ones.some((one) => littleSpot(one).failed)) {
        failing = window.setTimeout(() => {
          sim = settleLitter(sim, place, false);
          draw(true);
          report();
        }, litter.failed * 1000);
      }
      return;
    }
    for (const poke of litterPokes(before, sim)) on.poke(poke);
    report();
    running.restate();
  };

  return {
    sync: (nowWorking, failed, nowMore) => {
      const before = sim;
      measure();
      sim = syncLitter(sim, nowWorking, failed, nowMore, place);
      changed(before);
    },
    dismiss: () => {
      const before = sim;
      sim = dismissLitter(sim);
      changed(before);
    },
    perk: (id) => {
      if (reducedMotion()) return;
      sim = perkLittle(sim, id);
      running.restate();
    },
    stop: () => {
      window.clearTimeout(failing);
      running.stop();
    },
  };
}

interface LittleOnesProps {
  /** The turn's little ones, as the server tells them; null for a turn that has none. */
  readonly littleOnes: TurnLittleOnes | null;
  /** Whether the turn runs: a turn that is over shows none. */
  readonly live: boolean;
  /** The bot's own look, which each little one is a small copy of. */
  readonly avatar: Avatar;
  /** The bot's face beside the turn, which answers as they come and go. */
  readonly face: RefObject<AvatarHandle | null>;
  /** The element that frames that face: the little ones come out from under it. */
  readonly anchor: RefObject<HTMLElement | null>;
}

/**
 * A bot's little ones, under its face: the small copies of itself it splits
 * into while part of its turn runs in parallel. Each stands by one line of
 * what it does, four at most and a count of the rest. They come out from
 * under the bot one after another, land by their lines and bob there; one
 * that ends jumps back up into the bot, grey first if it failed. Hovering or
 * pressing one shows its line in full and how long it has worked.
 *
 * Everything that moves is drawn from the shared model
 * (`presentation/littleOnes.ts`) on the page's frame loop: no render of this
 * component moves anything. Under reduced motion they appear by their lines
 * and leave, with no travel.
 */
export function LittleOnes({ littleOnes, live, avatar, face, anchor }: LittleOnesProps) {
  const { plural } = useI18n();
  const { shape, color } = resolveAvatar(avatar);
  const shown = shownLittleOnes(littleOnes, live);
  const key = shown.ones.map((one) => one.id).join("\n");
  // The ones that no longer work stay drawn until the family says they are home.
  const [seen, setSeen] = useState({ key, ones: shown.ones });
  const [kept, setKept] = useState<ReadonlyArray<LittleOne>>([]);
  if (seen.key !== key) {
    const left = seen.ones.filter((one) => !shown.ones.some((now) => now.id === one.id));
    setSeen({ key, ones: shown.ones });
    if (left.length > 0) setKept([...kept, ...left]);
  }
  const rows = [...shown.ones, ...kept.filter((one) => !shown.ones.some((now) => now.id === one.id))];
  const more = shown.more > 0;

  const root = useRef<HTMLDivElement>(null);
  const strand = useRef<SVGPathElement>(null);
  const count = useRef<HTMLParagraphElement>(null);
  const controller = useRef<Controller | null>(null);
  const latest = useRef<{
    readonly shape: AvatarShapeName;
    readonly working: ReadonlyArray<string>;
    readonly more: boolean;
  }>({ shape, working: shown.ones.map((one) => one.id), more });
  useEffect(() => {
    const element = root.current;
    const path = strand.current;
    const line = count.current;
    if (element === null || path === null || line === null) return;
    // A family there as the conversation opens is simply there: nothing plays for it.
    const { working, more: counted } = latest.current;
    const mounted = mountLitter(element, path, line, working, counted, {
      shape: () => latest.current.shape,
      anchor: () => anchor.current,
      poke: (poke) => face.current?.poke(poke),
      left: (ids) => setKept((current) => current.filter((one) => ids.includes(one.id))),
    });
    controller.current = mounted;
    return () => {
      mounted.stop();
      controller.current = null;
    };
  }, [anchor, face]);

  const failedKey = shown.failed.join("\n");
  useEffect(() => {
    const working = key === "" ? [] : key.split("\n");
    latest.current = { shape, working, more };
    if (live) controller.current?.sync(working, failedKey === "" ? [] : failedKey.split("\n"), more);
    else controller.current?.dismiss();
  }, [key, failedKey, more, live, shape]);

  const colors = {
    "--avatar-body": `var(--bot-little-${color})`,
    "--avatar-rim": `var(--bot-${color})`,
  } as CSSProperties;
  return (
    <div
      ref={root}
      className="little-ones"
      style={colors}
      {...(shown.ones.length > 0
        ? { role: "group", "aria-label": plural("littleOnes.label", shown.ones.length + shown.more) }
        : {})}
    >
      <svg aria-hidden className="little-strand" width={PARENT} height={1}>
        <path ref={strand} transform={`translate(${PARENT / 2} 0)`} fill={`var(--bot-${color})`} />
      </svg>
      {rows.map((one) => (
        <LittleRow
          key={one.id}
          one={one}
          shape={shape}
          failed={shown.failed.includes(one.id)}
          onPerk={() => controller.current?.perk(one.id)}
        />
      ))}
      <p ref={count} className="little-more" data-shown={more}>
        <span aria-hidden className="little-more-dots">
          <span />
          <span />
        </span>
        {shown.more > 0 && plural("littleOnes.more", shown.more)}
      </p>
    </div>
  );
}

/**
 * One little one and its line. The whole line is what opens its details: the
 * line in full and how long it has worked. Nothing else: it has no name, no
 * conversation and no result of its own.
 */
function LittleRow({
  one,
  shape,
  failed,
  onPerk,
}: {
  readonly one: LittleOne;
  readonly shape: AvatarShapeName;
  readonly failed: boolean;
  readonly onPerk: () => void;
}) {
  return (
    <div data-little={one.id} className="little-row">
      <Popover.Root>
        <Popover.Trigger
          openOnHover
          delay={140}
          closeDelay={80}
          className="little-line"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") onPerk();
          }}
          onPointerDown={onPerk}
        >
          <span aria-hidden data-little-body className="little-body">
            <svg width={SIZE} height={SIZE} viewBox={AVATAR_VIEW_BOX} className="avatar overflow-visible">
              <AvatarParts shape={shape} little />
            </svg>
          </span>
          <span className="little-words">{one.label}</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={4} className="z-50">
            <Popover.Popup className="flex w-max max-w-[min(22rem,calc(100vw-2rem))] origin-(--transform-origin) flex-col gap-0.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-90 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out">
              <LittleDetails one={one} failed={failed} />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** A little one's line in full, and how long it has worked, counted while this shows. */
function LittleDetails({ one, failed }: { readonly one: LittleOne; readonly failed: boolean }) {
  const i18n = useI18n();
  const now = useSeconds(!failed);
  const worked = Math.max(0, now - DateTime.toEpochMillis(one.startedAt));
  return (
    <>
      <span className="wrap-break-word">{one.label}</span>
      <span className="text-muted-foreground">
        {failed
          ? i18n.t("littleOnes.failed")
          : i18n.t("littleOnes.workingFor", { duration: shortDuration(worked, i18n) })}
      </span>
    </>
  );
}
