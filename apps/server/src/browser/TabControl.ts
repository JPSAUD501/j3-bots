// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  BROWSER_PERSON_HOLD_MS,
  type BrowserTabHolder,
  type DeviceId,
} from "@j3-bots/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

// Who acts on one tab now (decision 0110). Reading never takes the tab. An
// action takes the tab's lease: the bot keeps it for a short while after the
// action, so its click, type and Enter are not interleaved with another
// bot's, and others' actions wait in a FIFO queue for a while, then fail. A
// person's input to the page takes the tab at once, fails the queued
// actions, and holds the tab until a while after their last input, or, when
// they asked the bots to wait for them, until they give it back. The
// server's fill of a saved login is a holder too, after a person and before
// bots. Each change of hands moves the tab's `epoch`.

/** How long a bot keeps a tab's lease after its action ends. */
export const BOT_LEASE = Duration.seconds(5);
/** How long a bot's action waits in a tab's queue before it fails. */
export const QUEUE_WAIT = Duration.seconds(20);
/** How long the person holds a tab after their last input to its page. */
export const PERSON_HOLD = Duration.millis(BROWSER_PERSON_HOLD_MS);

/** Who acts on a tab, and the bot whose action runs there now. */
interface ControlState {
  readonly holder: BrowserTabHolder | null;
  readonly acting: BotId | null;
  /** Grows with each change of hands. */
  readonly epoch: number;
}

/**
 * Why a bot's action did not run: a person holds the tab (`person`), or
 * asked the bots to wait for them (`waiting`); another bot held it for as
 * long as the action could wait (`bot`, which names it); the bot may no
 * longer browse (`withdrawn`); or the tab closed.
 */
export class ActRefused extends Schema.TaggedError<ActRefused>()("ActRefused", {
  reason: Schema.Literals(["person", "waiting", "bot", "withdrawn", "closed"]),
  botId: Schema.optionalKey(BotId),
}) {}

/** The server's fill could not hold the tab: a person holds it, or it closed. */
class FillRefused extends Schema.TaggedError<FillRefused>()("FillRefused", {
  reason: Schema.Literals(["person", "closed"]),
}) {}

/** One tab's control. Every method is safe to call from any fiber. */
export interface TabControl {
  /** Who acts now, with any hold that has lapsed taken off. */
  readonly state: Effect.Effect<ControlState>;
  /** `state`, now and after every change, a hold lapsing included. */
  readonly changes: Stream.Stream<ControlState>;
  /**
   * Runs `run` as `botId`'s action once the tab's lease is the bot's. Fails
   * with `ActRefused`, without running it, while a person holds the tab, or
   * when another holder kept it for all of `QUEUE_WAIT`. A person who takes
   * the tab while it runs lets the running step finish.
   */
  readonly act: <A, E, R>(
    botId: BotId,
    run: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ActRefused, R>;
  /**
   * The person used the page from `device`: they hold it until
   * `PERSON_HOLD` from now, or keep the open hold they asked for. Queued
   * actions fail. False, changing nothing, while a person on another device
   * holds the tab: their input is then not applied.
   */
  readonly personInput: (device: DeviceId) => Effect.Effect<boolean>;
  /**
   * "Wait for me": the person on `device` holds the tab until they give it
   * back. False, changing nothing, while a person on another device holds it.
   */
  readonly waitForMe: (device: DeviceId) => Effect.Effect<boolean>;
  /**
   * The person on `device` gives the tab back: at once, or, with `idle`,
   * `PERSON_HOLD` from now. Nothing when another holds it.
   */
  readonly release: (device: DeviceId, idle: boolean) => Effect.Effect<void>;
  /**
   * Runs `run` while the server holds the tab to type a saved login. It
   * waits for a bot's running action to finish, and goes before queued
   * ones. `stillHeld` fails once a person took the tab meanwhile.
   */
  readonly fill: <A, E, R>(
    run: (stillHeld: Effect.Effect<void, FillRefused>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | FillRefused, R>;
  /**
   * `botId` may browse no more: its lease ends and its queued actions fail
   * as `withdrawn`. A running action finishes its step.
   */
  readonly withdraw: (botId: BotId) => Effect.Effect<void>;
  /** The tab closed: every queued action fails as `closed`, and none runs again. */
  readonly close: Effect.Effect<void>;
}

type Holder =
  | { readonly kind: "person"; readonly device: DeviceId; readonly until: number | null }
  | { readonly kind: "bot"; readonly botId: BotId; readonly until: number }
  | { readonly kind: "fill" };

interface Waiter {
  readonly kind: "bot" | "fill";
  readonly botId: BotId | null;
  /** Completed at every change, or failed when the waiter is refused. */
  wake: Deferred.Deferred<void, ActRefused>;
}

const toHolder = (holder: Holder): BrowserTabHolder => {
  switch (holder.kind) {
    case "person":
      return {
        kind: "person",
        device: holder.device,
        until: holder.until === null ? null : DateTime.makeUnsafe(holder.until),
      };
    case "bot":
      return {
        kind: "bot",
        botId: holder.botId,
        until: DateTime.makeUnsafe(holder.until),
      };
    case "fill":
      return { kind: "fill" };
  }
};

const sameHands = (left: Holder | null, right: Holder | null): boolean => {
  if (left === null || right === null) return left === right;
  if (left.kind === "person" && right.kind === "person") return left.device === right.device;
  if (left.kind === "bot" && right.kind === "bot") return left.botId === right.botId;
  return left.kind === right.kind;
};

/** One tab's control, for as long as the scope lives. */
export const makeTabControl: Effect.Effect<TabControl, never, Scope.Scope> = Effect.gen(
  function* () {
    let holder: Holder | null = null;
    let acting: BotId | null = null;
    let epoch = 0;
    let closed = false;
    const queue: Array<Waiter> = [];
    /** Woken at every change: the fiber that publishes a hold's end. */
    let watcher = Deferred.makeUnsafe<void, ActRefused>();
    const published = yield* SubscriptionRef.make<ControlState>({
      holder: null,
      acting: null,
      epoch: 0,
    });

    const snapshot = (): ControlState => ({
      holder: holder === null ? null : toHolder(holder),
      acting,
      epoch,
    });

    const setHolder = (next: Holder | null) => {
      if (!sameHands(holder, next)) epoch++;
      holder = next;
    };

    /** A hold whose time passed is no hold. A bot's lease lasts while its action runs. */
    const lapse = (now: number) => {
      if (holder === null || holder.kind === "fill" || holder.until === null) return;
      if (holder.kind === "bot" && holder.botId === acting) return;
      if (holder.until <= now) setHolder(null);
    };

    /** Publishes the state, and wakes every waiter to look again. */
    const changed = Effect.suspend(() => {
      for (const waiter of queue) Deferred.doneUnsafe(waiter.wake, Effect.void);
      Deferred.doneUnsafe(watcher, Effect.void);
      return SubscriptionRef.set(published, snapshot());
    });

    /** Fails and dequeues each waiter `refuse` names a refusal for. */
    const refuseWaiting = (refuse: (waiter: Waiter) => ActRefused | null) => {
      for (let index = queue.length - 1; index >= 0; index--) {
        const waiter = queue[index];
        if (waiter === undefined) continue;
        const refusal = refuse(waiter);
        if (refusal === null) continue;
        queue.splice(index, 1);
        Deferred.doneUnsafe(waiter.wake, Effect.fail(refusal));
      }
    };

    const dequeue = (waiter: Waiter | null) => {
      if (waiter === null) return;
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
    };

    const now = Clock.currentTimeMillis;

    /**
     * Waits for the next change, or until `at + millis`. A refusal of the
     * waiter while it waits fails this.
     */
    const awaitChange = (waiter: Waiter, millis: number) =>
      Deferred.await(waiter.wake).pipe(
        Effect.timeoutOption(Duration.millis(Math.max(0, millis))),
        Effect.asVoid,
      );

    const act = Effect.fn("TabControl.act")(function* <A, E, R>(
      botId: BotId,
      run: Effect.Effect<A, E, R>,
    ) {
      const deadline = (yield* now) + Duration.toMillis(QUEUE_WAIT);
      let waiter: Waiter | null = null;
      const entered = Effect.gen(function* () {
        for (;;) {
          const at = yield* now;
          lapse(at);
          // The decision and the queueing happen in one step, so no change
          // can slip between them unseen.
          const decision = ((): ActRefused | "go" | number => {
            if (closed) return new ActRefused({ reason: "closed" });
            if (holder?.kind === "person")
              return new ActRefused({ reason: holder.until === null ? "waiting" : "person" });
            const fillAhead = queue.some((queued) => queued.kind === "fill");
            const firstBot = queue.find((queued) => queued.kind === "bot");
            const ownTurn = firstBot === undefined || firstBot === waiter;
            const free =
              acting === null &&
              !fillAhead &&
              ownTurn &&
              (holder === null || (holder.kind === "bot" && holder.botId === botId));
            if (free) return "go";
            const blocker =
              acting ?? (holder?.kind === "bot" ? holder.botId : null) ?? firstBot?.botId ?? null;
            if (at >= deadline)
              return new ActRefused(
                blocker === null ? { reason: "bot" } : { reason: "bot", botId: blocker },
              );
            if (waiter === null) {
              waiter = { kind: "bot", botId, wake: Deferred.makeUnsafe() };
              queue.push(waiter);
            } else {
              waiter.wake = Deferred.makeUnsafe();
            }
            const lapsesAt =
              holder?.kind === "bot" && holder.botId !== acting ? holder.until : deadline;
            return Math.min(deadline, lapsesAt) - at;
          })();
          if (decision === "go") {
            dequeue(waiter);
            setHolder({ kind: "bot", botId, until: at + Duration.toMillis(BOT_LEASE) });
            acting = botId;
            yield* changed;
            return;
          }
          if (typeof decision !== "number") {
            dequeue(waiter);
            yield* changed;
            return yield* decision;
          }
          if (waiter !== null) yield* awaitChange(waiter, decision);
        }
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => dequeue(waiter))));
      yield* entered;
      return yield* run.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            acting = null;
            if (holder?.kind === "bot" && holder.botId === botId) {
              holder = { kind: "bot", botId, until: (yield* now) + Duration.toMillis(BOT_LEASE) };
            }
            yield* changed;
          }),
        ),
      );
    });

    /** Whether a person on a device other than `device` holds the tab now. */
    const heldElsewhere = (device: DeviceId) =>
      holder?.kind === "person" && holder.device !== device;

    const personInput = Effect.fn("TabControl.personInput")(function* (device: DeviceId) {
      const at = yield* now;
      lapse(at);
      if (heldElsewhere(device)) return false;
      if (!(holder?.kind === "person" && holder.until === null)) {
        setHolder({ kind: "person", device, until: at + Duration.toMillis(PERSON_HOLD) });
      }
      refuseWaiting(() => new ActRefused({ reason: "person" }));
      yield* changed;
      return true;
    });

    const waitForMe = Effect.fn("TabControl.waitForMe")(function* (device: DeviceId) {
      lapse(yield* now);
      if (heldElsewhere(device)) return false;
      setHolder({ kind: "person", device, until: null });
      refuseWaiting(() => new ActRefused({ reason: "waiting" }));
      yield* changed;
      return true;
    });

    const release = Effect.fn("TabControl.release")(function* (device: DeviceId, idle: boolean) {
      const at = yield* now;
      lapse(at);
      if (holder?.kind !== "person" || holder.device !== device) return yield* changed;
      setHolder(idle ? { ...holder, until: at + Duration.toMillis(PERSON_HOLD) } : null);
      yield* changed;
    });

    const fill = Effect.fn("TabControl.fill")(function* <A, E, R>(
      run: (stillHeld: Effect.Effect<void, FillRefused>) => Effect.Effect<A, E, R>,
    ) {
      let waiter: Waiter | null = null;
      const entered = Effect.gen(function* () {
        for (;;) {
          lapse(yield* now);
          const decision = ((): FillRefused | "go" | "wait" => {
            if (closed) return new FillRefused({ reason: "closed" });
            if (holder?.kind === "person") return new FillRefused({ reason: "person" });
            if (acting === null && holder?.kind !== "fill") return "go";
            if (waiter === null) {
              waiter = { kind: "fill", botId: null, wake: Deferred.makeUnsafe() };
              queue.unshift(waiter);
            } else {
              waiter.wake = Deferred.makeUnsafe();
            }
            return "wait";
          })();
          if (decision === "go") {
            dequeue(waiter);
            setHolder({ kind: "fill" });
            yield* changed;
            return;
          }
          if (decision !== "wait") {
            dequeue(waiter);
            yield* changed;
            return yield* decision;
          }
          if (waiter !== null)
            yield* Deferred.await(waiter.wake).pipe(
              Effect.catchTag("ActRefused", (refused) =>
                Effect.fail(
                  new FillRefused({
                    reason:
                      refused.reason === "person" || refused.reason === "waiting"
                        ? "person"
                        : "closed",
                  }),
                ),
              ),
            );
        }
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => dequeue(waiter))));
      yield* entered;
      const stillHeld = Effect.suspend(() =>
        holder?.kind === "fill"
          ? Effect.void
          : Effect.fail(new FillRefused({ reason: closed ? "closed" : "person" })),
      );
      return yield* run(stillHeld).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (holder?.kind === "fill") setHolder(null);
            return changed;
          }),
        ),
      );
    });

    const withdraw = (botId: BotId) =>
      Effect.suspend(() => {
        if (holder?.kind === "bot" && holder.botId === botId && acting !== botId) setHolder(null);
        refuseWaiting((waiter) =>
          waiter.botId === botId ? new ActRefused({ reason: "withdrawn" }) : null,
        );
        return changed;
      });

    const close = Effect.suspend(() => {
      closed = true;
      refuseWaiting(() => new ActRefused({ reason: "closed" }));
      return changed;
    });

    // Publishes a hold's end when its time passes, so the tab list and the
    // viewers show it without anyone asking.
    yield* Effect.gen(function* () {
      for (;;) {
        const at = yield* now;
        const before = epoch;
        lapse(at);
        if (epoch !== before) yield* changed;
        watcher = Deferred.makeUnsafe<void, ActRefused>();
        const until =
          holder === null ||
          holder.kind === "fill" ||
          holder.until === null ||
          (holder.kind === "bot" && holder.botId === acting)
            ? null
            : holder.until;
        const woken = Deferred.await(watcher).pipe(Effect.ignore);
        yield* until === null
          ? woken
          : woken.pipe(Effect.timeoutOption(Duration.millis(Math.max(0, until - at))));
      }
    }).pipe(Effect.forkScoped);

    return {
      state: Effect.map(now, (at) => {
        lapse(at);
        return snapshot();
      }),
      changes: SubscriptionRef.changes(published),
      act,
      personInput,
      waitForMe,
      release,
      fill,
      withdraw,
      close,
    } satisfies TabControl;
  },
);
