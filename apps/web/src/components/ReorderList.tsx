// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lifts,
  moveDelay,
  rosterMotion,
  type RosterView,
  type RowMove,
} from "@j3-bots/client-runtime/presentation";
import { eases, lift, springs, stage } from "@j3-bots/design-tokens";
import { Component, createRef, type ReactNode, type RefObject } from "react";
import { reducedMotion } from "../lib/motion";
import { type Sprung, sprung } from "../lib/sprung";

interface ReorderListProps {
  /** The rows' keys in order, and the search that listed them. */
  readonly view: RosterView;
  /** What the list scrolls in, whose place on the list is kept when rows move above it. */
  readonly scroller: RefObject<HTMLElement | null>;
  /** A row set off rising: its bot answers with a hop. */
  readonly onRise: (key: string) => void;
  /** The rows: one `ReorderRow` each, keyed as in `view`. */
  readonly children: ReactNode;
}

/** The list as it stood just before React moved its rows. */
interface Snapshot {
  /** Each row's middle as drawn, mid-move included, in viewport px. */
  readonly drawn: ReadonlyMap<string, number>;
  /** Each row's place in the list's layout, in px from the list's top. */
  readonly placed: ReadonlyMap<string, number>;
  readonly scrollTop: number;
  /** The list's top in the scroller's content, in px. */
  readonly listTop: number;
  /** What had focus inside the list, which moving it in the document takes away. */
  readonly focused: HTMLElement | null;
  /** A copy of each row about to leave, with where it stood in the list, in px. */
  readonly leaving: ReadonlyArray<{
    readonly ghost: HTMLElement;
    readonly top: number;
    readonly height: number;
  }>;
}

const KEY = "reorderKey";
/**
 * Marks a row lifted off the list while it travels, `index.css` draws it:
 * `now` for a row the latest move lifted, over `earlier`, a row still up
 * from a move before it.
 */
const LIFTED = "data-lifted";
/** Marks a row that comes in with its own entrance (`ReorderRow`), which the list does not fade in. */
const ENTERING = "data-entering";

/** One row on its way: how far it is drawn from its place, in px, on a spring. */
type Flight = Sprung<"y">;

const sameKeys = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

const middle = (element: Element) => {
  const box = element.getBoundingClientRect();
  return (box.top + box.bottom) / 2;
};

/**
 * The roster's rows, which travel to their new places when the order
 * changes instead of jumping (`rosterMotion`): a row that rose or sank lifts
 * and travels on `slide`, and the rows it passes step aside `lift.stepDelay`
 * ms later, all on `translate` alone. Each row rides its own spring
 * (`sprung`), so a burst bends every row from where it is drawn and at the
 * speed it has, toward its new place. A row that left sinks and fades where
 * it stood as the others close up. Focus stays on the same row, and while the
 * list is scrolled the rows in view stay where they are as rows move above
 * them. Under reduced motion the rows take their places at once.
 *
 * It is a class for `getSnapshotBeforeUpdate`, React's one place to read
 * the rows just before it moves them.
 */
export class ReorderList extends Component<ReorderListProps> {
  private readonly list = createRef<HTMLUListElement>();
  private readonly ghosts = createRef<HTMLDivElement>();
  /** Each travelling row's motion, by key. */
  private readonly flights = new Map<string, Flight>();

  private rows(): ReadonlyMap<string, HTMLElement> {
    const list = this.list.current;
    if (list === null) return new Map();
    return new Map(
      [...list.children].flatMap((child) =>
        child instanceof HTMLElement && child.dataset[KEY] !== undefined
          ? [[child.dataset[KEY], child] as const]
          : [],
      ),
    );
  }

  override getSnapshotBeforeUpdate(previous: Readonly<ReorderListProps>): Snapshot | null {
    const { view } = this.props;
    const list = this.list.current;
    const scroller = this.props.scroller.current;
    if (list === null || scroller === null) return null;
    if (previous.view.query === view.query && sameKeys(previous.view.keys, view.keys)) return null;
    const rows = this.rows();
    const active = document.activeElement;
    const stays = new Set(view.keys);
    // Copied now: once React has taken a row out, there is nothing left to show leaving.
    const leaving =
      previous.view.query !== view.query || reducedMotion()
        ? []
        : [...rows].flatMap(([key, row]) =>
            stays.has(key)
              ? []
              : [{ ghost: ghostOf(row), top: row.offsetTop, height: row.offsetHeight }],
          );
    return {
      leaving,
      drawn: new Map([...rows].map(([key, row]) => [key, middle(row)])),
      placed: new Map([...rows].map(([key, row]) => [key, row.offsetTop])),
      scrollTop: scroller.scrollTop,
      listTop:
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop,
      focused: active instanceof HTMLElement && list.contains(active) ? active : null,
    };
  }

  override componentDidUpdate(
    previous: Readonly<ReorderListProps>,
    _state: unknown,
    snapshot: Snapshot | null,
  ): void {
    if (snapshot === null) return;
    const { focused } = snapshot;
    if (
      focused !== null &&
      focused.isConnected &&
      (document.activeElement === null || document.activeElement === document.body)
    ) {
      focused.focus({ preventScroll: true });
    }
    const moves = rosterMotion(previous.view, this.props.view);
    const rows = this.rows();
    for (const key of this.flights.keys()) {
      // A row that left has nothing more to travel.
      if (!rows.has(key)) this.land(key, undefined);
    }
    if (previous.view.query !== this.props.view.query) {
      // What a search lists just appears: nothing still moving goes on.
      for (const key of this.flights.keys()) this.land(key, rows.get(key));
      return;
    }
    this.keepPlace(previous.view.keys, moves, rows, snapshot);
    if (reducedMotion()) return;
    this.leave(snapshot.leaving);
    this.travel(moves, rows, snapshot.drawn);
  }

  override componentWillUnmount(): void {
    for (const flight of this.flights.values()) flight.stop();
    this.flights.clear();
  }

  /** Shows each row that left where it stood, sinking and fading, over the rows closing up under it. */
  private leave(leaving: Snapshot["leaving"]): void {
    const layer = this.ghosts.current;
    if (layer === null) return;
    for (const { ghost, top, height } of leaving) {
      ghost.style.top = `${top}px`;
      ghost.style.height = `${height}px`;
      layer.append(ghost);
      const gone = ghost.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateY(6px) scale(0.94)" },
        ],
        { duration: stage.rowLeave, easing: eases.out, fill: "forwards" },
      );
      const remove = () => ghost.remove();
      gone.addEventListener("finish", remove);
      gone.addEventListener("cancel", remove);
    }
  }

  /**
   * While the list is scrolled, keeps the first row in view that does not
   * itself move where it was, so rows that move above the view do not push
   * what the operator is looking at. At the top, the list stays at the top.
   */
  private keepPlace(
    before: ReadonlyArray<string>,
    moves: ReadonlyMap<string, RowMove>,
    rows: ReadonlyMap<string, HTMLElement>,
    { placed, scrollTop, listTop }: Snapshot,
  ): void {
    const scroller = this.props.scroller.current;
    if (scroller === null || scrollTop <= 0) return;
    const anchor = before.find((key) => {
      const top = placed.get(key);
      const row = rows.get(key);
      const move = moves.get(key);
      return (
        top !== undefined &&
        row !== undefined &&
        (move === undefined || !lifts(move)) &&
        listTop + top + row.offsetHeight > scrollTop
      );
    });
    const top = anchor === undefined ? undefined : placed.get(anchor);
    const row = anchor === undefined ? undefined : rows.get(anchor);
    if (top === undefined || row === undefined) return;
    scroller.scrollTop = scrollTop + (row.offsetTop - top);
  }

  /**
   * Sets every row off from where it was drawn toward its new place: a row
   * the order moved, one still travelling, and one the list's own scroll
   * moved on screen. A row new to the list fades in as the others make room.
   */
  private travel(
    moves: ReadonlyMap<string, RowMove>,
    rows: ReadonlyMap<string, HTMLElement>,
    drawn: ReadonlyMap<string, number>,
  ): void {
    const going = [...rows].flatMap(([key, row]) => {
      const was = drawn.get(key);
      return was === undefined ? [] : [{ key, row, was }];
    });
    // Every measure first, then every motion: one layout in all. A row still on its way is
    // measured where it is drawn, which is that far from where it is laid out.
    const offsets = going.map(
      ({ key, row, was }) => was - (middle(row) - (this.flights.get(key)?.now().y ?? 0)),
    );
    // A row the last move lifted that is still up now passes under the rows this one lifts.
    for (const row of rows.values()) {
      if (row.getAttribute(LIFTED) === "now") row.setAttribute(LIFTED, "earlier");
    }
    let moving = false;
    going.forEach(({ key, row }, index) => {
      const offset = offsets[index] ?? 0;
      const flying = this.flights.get(key);
      if (flying === undefined && Math.abs(offset) < 1) {
        this.land(key, row);
        return;
      }
      moving = true;
      const move = moves.get(key);
      if (flying !== undefined) {
        // Already on its way: it goes on from where it is drawn, at the speed it has.
        flying.shift({ y: offset - flying.now().y });
        flying.to({ y: 0 });
      } else {
        const flight: Flight = sprung(
          { y: offset },
          "slide",
          ({ y }) => {
            row.style.translate = `0 ${Math.round(y * 100) / 100}px`;
          },
          () => {
            if (this.flights.get(key) === flight) this.land(key, row);
          },
        );
        this.flights.set(key, flight);
        // Drawn where it was before it sets off; a row only the list's scroll moved follows
        // the rows that lift, like the rows they pass.
        flight.jump({ y: offset });
        flight.to({ y: 0 }, { delay: moveDelay(move ?? "step", moves, lift.stepDelay) });
      }
      if (move !== undefined && lifts(move)) {
        // Lifted once for its whole way: a row a burst moves again stays up and does not hop again.
        if (move === "rise" && !row.hasAttribute(LIFTED)) this.props.onRise(key);
        row.setAttribute(LIFTED, "now");
      }
    });
    if (!moving) return;
    for (const [key, row] of rows) {
      // A row with an entrance of its own brings itself in.
      if (!drawn.has(key) && !row.hasAttribute(ENTERING)) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: springs.soft.duration,
          easing: springs.soft.easing,
        });
      }
    }
  }

  /** A row at rest in its place: no motion left, and set down. */
  private land(key: string, row: HTMLElement | undefined): void {
    this.flights.get(key)?.stop();
    this.flights.delete(key);
    if (row === undefined) return;
    row.style.translate = "";
    row.removeAttribute(LIFTED);
  }

  override render(): ReactNode {
    return (
      <div className="relative">
        <ul ref={this.list} className="relative flex flex-col gap-px">
          {this.props.children}
        </ul>
        {/* Where the rows that left are shown leaving: nothing React draws, so nothing it moves. */}
        <div ref={this.ghosts} aria-hidden className="pointer-events-none absolute inset-0" />
      </div>
    );
  }
}

/**
 * A copy of `row` to show leaving: what it looked like, and nothing that
 * answers, takes focus or is found as a row.
 */
function ghostOf(row: HTMLElement): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "absolute inset-x-0";
  ghost.inert = true;
  for (const child of row.childNodes) ghost.append(child.cloneNode(true));
  for (const marked of ghost.querySelectorAll("[data-roster-row], [id]")) {
    marked.removeAttribute("data-roster-row");
    marked.removeAttribute("id");
  }
  return ghost;
}

/** One row of a `ReorderList`: the list item it moves and lifts. `entering` marks one that brings itself in. */
export function ReorderRow({
  rowKey,
  entering = false,
  children,
}: {
  readonly rowKey: string;
  readonly entering?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li
      data-reorder-key={rowKey}
      className="reorder-row"
      {...(entering ? { "data-entering": "" } : {})}
    >
      {children}
    </li>
  );
}
