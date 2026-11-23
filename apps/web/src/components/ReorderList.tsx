// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lifts,
  moveDelay,
  rosterMotion,
  type RosterView,
  type RowMove,
} from "@j3-bots/client-runtime/presentation";
import { lift, springs } from "@j3-bots/design-tokens";
import { Component, createRef, type ReactNode, type RefObject } from "react";
import { reducedMotion } from "../lib/motion";

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
}

const KEY = "reorderKey";
/** Marks a row lifted off the list while it travels; `index.css` draws it. */
const LIFTED = "data-lifted";

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
 * ms later, all on transforms alone. A burst retargets every row from where
 * it is drawn. Focus stays on the same row, and while the list is scrolled
 * the rows in view stay where they are as rows move above them. Under
 * reduced motion the rows take their places at once.
 *
 * It is a class for `getSnapshotBeforeUpdate`, React's one place to read
 * the rows just before it moves them.
 */
export class ReorderList extends Component<ReorderListProps> {
  private readonly list = createRef<HTMLUListElement>();
  /** Each travelling row's motion, by key. */
  private readonly flights = new Map<string, Animation>();

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
    return {
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
    if (previous.view.query !== this.props.view.query) {
      // What a search lists just appears: nothing still moving goes on.
      for (const key of this.flights.keys()) this.land(key, rows.get(key));
      return;
    }
    this.keepPlace(previous.view.keys, moves, rows, snapshot);
    if (reducedMotion()) return;
    this.travel(moves, rows, snapshot.drawn);
  }

  override componentWillUnmount(): void {
    for (const flight of this.flights.values()) flight.cancel();
    this.flights.clear();
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

  /** Sets each moved row, and each row still travelling, off from where it was drawn. */
  private travel(
    moves: ReadonlyMap<string, RowMove>,
    rows: ReadonlyMap<string, HTMLElement>,
    drawn: ReadonlyMap<string, number>,
  ): void {
    const travelling = new Set(this.flights.keys());
    const going = [...new Set([...moves.keys(), ...travelling])].flatMap((key) => {
      const row = rows.get(key);
      return row === undefined ? [] : [{ key, row, move: moves.get(key) }];
    });
    // Every row in its place first, then every measure, then every motion: one layout in all.
    for (const { key } of going) this.flights.get(key)?.cancel();
    const offsets = going.map(({ key, row }) => (drawn.get(key) ?? middle(row)) - middle(row));
    going.forEach(({ key, row, move }, index) => {
      const offset = offsets[index] ?? 0;
      if (Math.abs(offset) < 1) {
        this.land(key, row);
        return;
      }
      // A row already on its way goes on at once, toward its new place.
      const delay =
        move === undefined || travelling.has(key) ? 0 : moveDelay(move, moves, lift.stepDelay);
      const flight = row.animate(
        [{ transform: `translateY(${offset}px)` }, { transform: "none" }],
        {
          duration: springs.slide.duration,
          easing: springs.slide.easing,
          delay,
          fill: "backwards",
        },
      );
      this.flights.set(key, flight);
      flight.addEventListener("finish", () => {
        if (this.flights.get(key) === flight) this.land(key, row);
      });
      if (move !== undefined && lifts(move) && !row.hasAttribute(LIFTED)) {
        // Lifted once for its whole way: a row a burst moves again stays up and does not hop again.
        row.setAttribute(LIFTED, "");
        if (move === "rise") this.props.onRise(key);
      }
    });
  }

  /** A row at rest in its place: no motion left, and set down. */
  private land(key: string, row: HTMLElement | undefined): void {
    this.flights.get(key)?.cancel();
    this.flights.delete(key);
    row?.removeAttribute(LIFTED);
  }

  override render(): ReactNode {
    return (
      <ul ref={this.list} className="relative flex flex-col gap-px">
        {this.props.children}
      </ul>
    );
  }
}

/** One row of a `ReorderList`: the list item it moves and lifts. */
export function ReorderRow({
  rowKey,
  children,
}: {
  readonly rowKey: string;
  readonly children: ReactNode;
}) {
  return (
    <li data-reorder-key={rowKey} className="reorder-row">
      {children}
    </li>
  );
}
