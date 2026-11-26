// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Conflict,
  type EngineStatus,
  type HarnessCopies,
  type HarnessCopy,
  type HarnessOutcome,
  type HarnessTask,
  isNewerHarness,
  ProviderId,
  type SignInHarness,
  SignInHarness as SignInHarnessSchema,
} from "@j3-bots/contracts";
import { Engine } from "@j3-bots/engine-t3";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ServerConfig } from "../config.ts";
import { Layout } from "../Layout.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { RunningWork } from "../turns/RunningWork.ts";
import { SendPause } from "../turns/SendPause.ts";
import type { Distribution, Release } from "./distributions.ts";
import { fileFailed, HarnessFailed, renameRefused } from "./failure.ts";
import { installRelease, type Probe } from "./install.ts";
import {
  copyLayout,
  type CopyState,
  CopyStateJson,
  currentText,
  EMPTY_STATE,
  type InstalledCopy,
  readCurrent,
} from "./layout.ts";
import { HarnessSources } from "./sources.ts";

// J3 Bots' own copies of Claude Code and Codex
// (docs/decisions/0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md,
// docs/decisions/0064-the-harnesses-install-as-the-server-starts-and-fail-with-the-true-reason.md):
// installed for a harness the operator has none of on the server's `PATH`,
// both at once as soon as the server starts, beside the engine's own
// download, and again at each check while one is missing, whatever
// `autoUpdateHarnesses` says, which is about updates; a client may ask too.
// Each maker's listing is read a minute after the server starts and about
// every six hours after; a newer version than J3 Bots' copy is installed
// then unless the operator turned that off (`autoUpdateHarnesses`), and a
// client can ask for it at any time.
//
// A new version is downloaded, checked against its maker's SHA-256, run once,
// and installed beside the one the provider runs, which keeps running. The
// switch then waits until no bot has work running in a session on the
// provider: the engine rebuilds the provider's instance, and what becomes
// of a turn that runs across that is not known, so none does. While it
// switches, no bot's first send goes out (the `SendPause`), until the
// engine's check of the rebuilt instance shows the new version; only then
// is `current.json` replaced. A session the engine already has open keeps
// running the copy it started on until the engine releases it: each is
// released then, and the copy before removed once all were, else once the
// engine starts again.

/** How often each listing is read on its own, give or take `JITTER`. */
const CHECK_EVERY = Duration.hours(6);
const JITTER = Duration.minutes(30);
/** The first read after a start. */
const FIRST_CHECK_AFTER = Duration.minutes(1);
/** After a read that did not answer, the wait before the next. */
const RETRY_AFTER = Duration.hours(1);
/** How often a switch that waits for running work looks again. */
const WAIT_STEP = Duration.seconds(30);

/** What a provider's work looks like to a switch. */
export interface ProviderWork {
  /** Runs `effect` with no bot's first send going out meanwhile (`SendPause.paused`). */
  readonly paused: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** How many bots on `providerId` have work running in the engine now. */
  readonly running: (providerId: ProviderId) => Effect.Effect<number>;
  /**
   * Has the engine release each session it has open on `providerId`, which
   * starts its harness again, and resumes its conversation, at its next
   * turn: true once every one was.
   */
  readonly release: (providerId: ProviderId) => Effect.Effect<boolean>;
}

export class Harnesses extends Context.Service<
  Harnesses,
  {
    /** Each harness's copy now, then each time one changes. */
    readonly copies: Stream.Stream<Readonly<Record<SignInHarness, HarnessCopy>>>;
    /**
     * Starts installing J3 Bots' copy of `harness`, or updating it to the
     * newest version listed, and answers once it started; one already under
     * way is left to run. `Conflict("harness-not-installable")` when the
     * provider runs the operator's own, or J3 Bots installs no build for
     * this machine.
     */
    readonly install: (harness: SignInHarness) => Effect.Effect<void, Conflict>;
    /** Stops the install or update of `harness` under way, if any; the provider keeps the copy it ran. */
    readonly cancel: (harness: SignInHarness) => Effect.Effect<void>;
  }
>()("@j3-bots/server/harnesses/Harnesses") {}

/** What the service knows of one harness. */
interface Slot {
  readonly installed: Option.Option<InstalledCopy>;
  /** Whether the operator's own is on the server's `PATH`. */
  readonly operator: boolean;
  readonly task: HarnessTask | null;
  readonly state: CopyState;
}

const HARNESS_IDS = SignInHarnessSchema.literals;

const copyOf = (slot: Slot, installable: boolean): HarnessCopy => ({
  source: Option.isSome(slot.installed) ? "j3" : slot.operator ? "operator" : "none",
  version: Option.match(slot.installed, { onNone: () => null, onSome: (copy) => copy.version }),
  latest: slot.state.latest,
  installable,
  task: slot.task,
  last: slot.state.last,
});

/**
 * The service over the server's home `home`, with each harness's
 * distribution, a way to run a copy once (`probe`), whether the operator has
 * their own on `PATH` (`onPath`), whether updates install by themselves
 * (`autoUpdate`: its value now, then each change) and the providers' work.
 */
export const make = Effect.fn("Harnesses.make")(function* (options: {
  readonly home: string;
  readonly platform: string;
  readonly distributions: Readonly<Record<SignInHarness, Distribution>>;
  readonly probe: (harness: SignInHarness) => Probe;
  readonly onPath: (harness: SignInHarness) => Effect.Effect<boolean>;
  readonly autoUpdate: Stream.Stream<boolean>;
  readonly work: ProviderWork;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* Layout;
  const engine = yield* Engine;
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const layoutOf = (harness: SignInHarness) => copyLayout(path, options.home, harness);

  const readState = (harness: SignInHarness) =>
    fs.readFileString(layoutOf(harness).state).pipe(
      Effect.flatMap(Schema.decodeEffect(CopyStateJson)),
      Effect.orElseSucceed(() => EMPTY_STATE),
    );

  /**
   * Removes what an install left that is not the current copy, nor a
   * stranded one: other versions, unpacking folders, and every download but one of `resume`,
   * which the next install of that version resumes. Only space is at stake,
   * so a failure is logged and left.
   */
  /**
   * A copy the engine may run though it is not current: one it was switched
   * to, and then could not be shown to have been switched back from. It is
   * kept on disk, and reused by the next install of its version, until the
   * engine starts again, provisioned with the current copy.
   */
  const stranded = new Map<SignInHarness, InstalledCopy>();

  const prune = Effect.fn("Harnesses.prune")(function* (
    harness: SignInHarness,
    slot: Slot,
    resume: string | null,
  ) {
    const layout = layoutOf(harness);
    const kept = [
      ...Option.toArray(Option.map(slot.installed, (copy) => copy.version)),
      ...Option.toArray(Option.fromNullishOr(stranded.get(harness)?.version)),
    ];
    const versions = yield* fs.readDirectory(layout.versions).pipe(Effect.orElseSucceed(() => []));
    const leftovers = [
      ...versions
        .filter((version) => !kept.includes(version))
        .map((version) => layout.version(version)),
      ...(yield* fs.readDirectory(layout.root).pipe(Effect.orElseSucceed(() => [])))
        .filter(
          (name) =>
            name.endsWith(".staging") ||
            (name.endsWith(".partial") && name !== `${resume}.partial`),
        )
        .map((name) => path.join(layout.root, name)),
    ];
    for (const leftover of leftovers) {
      yield* files.writable(leftover).pipe(
        Effect.andThen(fs.remove(leftover, { recursive: true, force: true })),
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove what an install of a harness left", { cause }),
        ),
      );
    }
  });

  const initial = yield* Effect.forEach(HARNESS_IDS, (harness) =>
    Effect.gen(function* () {
      const slot: Slot = {
        installed: yield* readCurrent(options.home, harness),
        operator: yield* options.onPath(harness),
        task: null,
        state: yield* readState(harness),
      };
      yield* prune(harness, slot, slot.state.latest);
      return [harness, slot] as const;
    }),
  );
  const slots = yield* Ref.make<ReadonlyMap<SignInHarness, Slot>>(new Map(initial));
  const copiesNow = Effect.map(Ref.get(slots), (now) => {
    const of = (harness: SignInHarness) =>
      copyOf(
        now.get(harness) ?? {
          installed: Option.none(),
          operator: false,
          task: null,
          state: EMPTY_STATE,
        },
        options.distributions[harness].installable,
      );
    return { "claude-code": of("claude-code"), codex: of("codex") } satisfies Record<
      SignInHarness,
      HarnessCopy
    >;
  });
  const published = yield* SubscriptionRef.make(yield* copiesNow);
  const publish = SubscriptionRef.updateEffect(published, () => copiesNow);

  const update = (harness: SignInHarness, change: (slot: Slot) => Slot) =>
    Ref.update(slots, (now) => {
      const slot = now.get(harness);
      return slot === undefined ? now : new Map(now).set(harness, change(slot));
    }).pipe(Effect.andThen(publish));
  const slotOf = (harness: SignInHarness) => Effect.map(Ref.get(slots), (now) => now.get(harness));

  const saveState = Effect.fn("Harnesses.saveState")(function* (
    harness: SignInHarness,
    change: (state: CopyState) => CopyState,
  ) {
    yield* update(harness, (slot) => ({ ...slot, state: change(slot.state) }));
    const slot = yield* slotOf(harness);
    if (slot === undefined) return;
    yield* Schema.encodeEffect(CopyStateJson)(slot.state).pipe(
      Effect.flatMap((text) => files.writeFile(layoutOf(harness).state, text)),
      Effect.catch((cause) =>
        Effect.logWarning("Could not keep the state of a harness's copy", { cause }),
      ),
    );
  });

  const latestOf = (harness: SignInHarness) =>
    options.distributions[harness].latest.pipe(
      Effect.tap((release) =>
        saveState(harness, (state) => ({ ...state, latest: release.version })),
      ),
    );

  const autoUpdate = yield* SubscriptionRef.make(true);

  // The harnesses whose job a client asked for, rather than the check alone.
  const requested = new Set<SignInHarness>();
  // The copy each job made current, though the job may still be interrupted after.
  const committed = new Map<SignInHarness, InstalledCopy>();

  /** Why a switch to a copy waiting for it is no longer wanted, if it is not. */
  const unwanted = Effect.fn("Harnesses.unwanted")(function* (
    harness: SignInHarness,
    before: Option.Option<InstalledCopy>,
    automatic: boolean,
  ) {
    if (Option.isNone(before) && (yield* options.onPath(harness))) {
      yield* update(harness, (slot) => ({ ...slot, operator: true }));
      return Option.some("The operator installed the harness meanwhile; J3 Bots' copy is not used");
    }
    if (automatic && !requested.has(harness) && !(yield* SubscriptionRef.get(autoUpdate))) {
      return Option.some("Updates were turned off; a waiting update is not installed");
    }
    return Option.none<string>();
  });

  /**
   * Runs the engine's provider on `copy`, once no bot has work running in a
   * session on it, then makes it current: `switched`; `waiting` while that
   * work runs or the engine is not ready, which runs the copy it ran; or
   * `unwanted`, with why, looked at with first sends held, just before the
   * engine is given it. An engine that may have taken `copy` without showing
   * it runs it is put back on the copy before, as is one whose
   * `current.json` cannot be written, so the engine and `current.json` name
   * the same copy; one that cannot be shown put back keeps `copy` stranded.
   * A session the engine has open keeps running the copy it started on
   * until the engine releases it, so each is released then; the copy before
   * is removed once all were, else once the engine starts again.
   */
  const switchTo = Effect.fn("Harnesses.switchTo")(function* (
    harness: SignInHarness,
    copy: InstalledCopy,
    before: Option.Option<InstalledCopy>,
    automatic: boolean,
  ) {
    const providerId = ProviderId.make(harness);
    const layout = layoutOf(harness);
    const putBack = engine
      .setHarnessExecutable({
        providerId,
        executable: Option.match(before, {
          onNone: () => null,
          onSome: (previous) => previous.executable,
        }),
        version: Option.match(before, {
          onNone: () => null,
          onSome: (previous) => previous.version,
        }),
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "The engine could not be shown to run the harness copy before again; the new one is kept",
            { cause },
          ).pipe(Effect.andThen(Effect.sync(() => void stranded.set(harness, copy)))),
        ),
      );
    const engineFailed = () => new HarnessFailed({ reason: "engine" });
    // From here a client's cancel no longer stops the job (`cancel`): the
    // engine may take the copy at any moment, and `current.json` must then
    // name it. The server's stop still does, at once, though the engine may
    // take long to show it runs the copy: its next start runs whichever copy
    // `current.json` names, and the engine starts anew with it.
    const begun = yield* lock.withPermits(1)(
      Effect.sync(() => {
        if (cancelled.has(harness)) return false;
        switching.add(harness);
        return true;
      }),
    );
    if (!begun) return yield* Effect.interrupt;
    const outcome = yield* options.work
      .paused(
        Effect.gen(function* () {
          const why = yield* unwanted(harness, before, automatic);
          if (Option.isSome(why)) return { _tag: "unwanted", why: why.value } as const;
          if ((yield* options.work.running(providerId)) > 0) return { _tag: "waiting" } as const;
          const taken = yield* engine
            .setHarnessExecutable({
              providerId,
              executable: copy.executable,
              version: copy.version,
            })
            .pipe(
              Effect.as(true),
              Effect.catchTags({
                EngineUnavailable: () => Effect.succeed(false),
                EngineIncompatible: () => Effect.fail(engineFailed()),
                EngineIndeterminate: () =>
                  putBack.pipe(Effect.andThen(Effect.fail(engineFailed()))),
              }),
            );
          if (!taken) return { _tag: "waiting" } as const;
          yield* currentText(copy).pipe(
            // An installed copy always encodes: a failure is a defect.
            Effect.orDie,
            Effect.flatMap((text) => files.writeFile(layout.current, text)),
            // The write ends in a rename over the file, which Windows refuses
            // while another program holds it; it was tried again a while.
            Effect.catch((error) => fileFailed(options.platform, renameRefused(error))(error)),
            Effect.tapError(() => putBack),
          );
          // Recorded at once: a cancel that landed meanwhile finds the copy
          // the engine now runs installed, keeps it, and is told so.
          committed.set(harness, copy);
          if (stranded.get(harness)?.version === copy.version) stranded.delete(harness);
          yield* update(harness, (slot) => ({ ...slot, installed: Option.some(copy), task: null }));
          // Still with first sends held: no turn reaches a session on the copy before.
          const released = yield* options.work.release(providerId);
          return { _tag: "switched", released } as const;
        }),
      )
      .pipe(Effect.ensuring(lock.withPermits(1)(Effect.sync(() => switching.delete(harness)))));
    if (outcome._tag !== "switched") return outcome;
    if (!outcome.released) {
      yield* Effect.logInfo(
        "A session may still run the harness copy before; it is removed once the engine starts again",
      ).pipe(Effect.annotateLogs({ harness }));
    } else if (Option.isSome(before) && before.value.version !== copy.version) {
      yield* files.writable(layout.version(before.value.version)).pipe(
        Effect.flatMap((location) => fs.remove(location, { recursive: true, force: true })),
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove the harness copy a newer one replaced", { cause }),
        ),
      );
    }
    return outcome;
  });

  /**
   * An install or update of `harness`, to `known` when given, else to the
   * newest listed: the copy it installed, none when it found nothing newer,
   * or gave the copy up while it waited (`unwanted`).
   */
  const job = Effect.fn("Harnesses.job")(function* (
    harness: SignInHarness,
    known: Option.Option<Release>,
    automatic: boolean,
  ) {
    const report = (task: HarnessTask) => update(harness, (slot) => ({ ...slot, task }));
    // Under way, and so cancellable, from the start: the listing too is the maker's to answer.
    yield* report({ _tag: "downloading", receivedBytes: 0, totalBytes: null });
    const release = Option.isSome(known) ? known.value : yield* latestOf(harness);
    const before = (yield* slotOf(harness))?.installed ?? Option.none();
    if (Option.isSome(before) && !isNewerHarness(release.version, before.value.version)) {
      return Option.none<InstalledCopy>();
    }
    const layout = layoutOf(harness);
    // A stranded copy of this version may be what the engine runs: it is not replaced.
    const left = stranded.get(harness);
    const copy =
      left !== undefined && left.version === release.version
        ? left
        : yield* installRelease({
            release,
            layout,
            files,
            client: options.distributions[harness].client,
            probe: options.probe(harness),
            platform: options.platform,
            report,
          });
    yield* report({ _tag: "waiting" });
    while (true) {
      const outcome = yield* switchTo(harness, copy, before, automatic);
      if (outcome._tag === "switched") break;
      if (outcome._tag === "unwanted") {
        yield* Effect.logInfo(outcome.why).pipe(
          Effect.annotateLogs({ harness, version: copy.version }),
        );
        if (stranded.get(harness)?.version !== copy.version) {
          yield* files.writable(layout.version(copy.version)).pipe(
            Effect.flatMap((location) => fs.remove(location, { recursive: true, force: true })),
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove a harness copy that was given up", { cause }),
            ),
          );
        }
        return Option.none<InstalledCopy>();
      }
      yield* Effect.sleep(WAIT_STEP);
    }
    yield* Effect.logInfo("J3 Bots' copy of a harness was installed").pipe(
      Effect.annotateLogs({ harness, version: copy.version }),
    );
    return Option.some(copy);
  });

  // The job of each harness under way, the harnesses whose job a client
  // cancelled, and those whose job is switching the engine to its copy.
  const jobs = new Map<SignInHarness, Fiber.Fiber<Option.Option<InstalledCopy>, HarnessFailed>>();
  const cancelled = new Set<SignInHarness>();
  const switching = new Set<SignInHarness>();
  const lock = yield* Semaphore.make(1);

  const end = Effect.fn("Harnesses.end")(function* (
    harness: SignInHarness,
    outcome: HarnessOutcome | null,
  ) {
    yield* update(harness, (slot) => ({ ...slot, task: null }));
    if (outcome !== null) yield* saveState(harness, (state) => ({ ...state, last: outcome }));
  });

  /** How `harness`'s job ended, recorded, and what it left removed when a client cancelled it. */
  const ended = Effect.fn("Harnesses.ended")(function* (
    harness: SignInHarness,
    exit: Exit.Exit<Option.Option<InstalledCopy>, HarnessFailed>,
  ) {
    const at = yield* DateTime.now;
    const wasCancelled = cancelled.delete(harness);
    const made = committed.get(harness);
    committed.delete(harness);
    // A job that made a copy current installed it, whatever came after.
    if (made !== undefined) {
      return yield* end(harness, { _tag: "installed", version: made.version, at });
    }
    if (Exit.isSuccess(exit)) {
      return yield* end(
        harness,
        Option.match(exit.value, {
          onNone: () => null,
          onSome: (copy): HarnessOutcome => ({ _tag: "installed", version: copy.version, at }),
        }),
      );
    }
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure)) {
      yield* Effect.logWarning("Installing J3 Bots' copy of a harness failed").pipe(
        Effect.annotateLogs({ harness, reason: failure.value.reason }),
      );
      return yield* end(harness, { _tag: "failed", reason: failure.value.reason, at });
    }
    if (!Cause.hasInterruptsOnly(exit.cause)) {
      yield* Effect.logError("Installing J3 Bots' copy of a harness failed", exit.cause);
      return yield* end(harness, null);
    }
    // Interrupted: by a cancel, which drops what was downloaded, or by the
    // server's stop, which keeps it for the next install to resume.
    if (!wasCancelled) return yield* end(harness, null);
    const slot = yield* slotOf(harness);
    if (slot !== undefined) yield* prune(harness, slot, null);
    return yield* end(harness, { _tag: "cancelled", at });
  });

  /**
   * Starts `harness`'s job unless one runs. It is registered under the lock,
   * and leaves under it, recording how it ended, so it never leaves before
   * it is registered, and a job started after it never sees it still there.
   */
  /**
   * Starts `harness`'s install, or joins the one under way. With `when`, only
   * if its slot still says so once no other start, cancel or end runs: a
   * cancel that lands while a check reads the listing is not overridden.
   */
  const start = (
    harness: SignInHarness,
    known: Option.Option<Release>,
    automatic: boolean,
    when?: (slot: Slot) => boolean,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (jobs.has(harness)) {
          if (!automatic) requested.add(harness);
          return;
        }
        if (when !== undefined) {
          const slot = yield* slotOf(harness);
          if (slot === undefined || !when(slot)) return;
        }
        if (!automatic) requested.add(harness);
        const fiber = yield* job(harness, known, automatic).pipe(
          Effect.onExit((exit) =>
            lock.withPermits(1)(
              Effect.sync(() => {
                jobs.delete(harness);
                requested.delete(harness);
              }).pipe(Effect.andThen(ended(harness, exit))),
            ),
          ),
          Effect.provideContext(context),
          Effect.forkIn(scope),
        );
        jobs.set(harness, fiber);
      }),
    );

  const install = Effect.fn("Harnesses.install")(function* (harness: SignInHarness) {
    const slot = yield* slotOf(harness);
    const operator =
      slot !== undefined && Option.isNone(slot.installed) && (yield* options.onPath(harness));
    if (slot === undefined || operator || !options.distributions[harness].installable) {
      if (slot !== undefined && slot.operator !== operator) {
        yield* update(harness, (now) => ({ ...now, operator }));
      }
      return yield* new Conflict({ reason: "harness-not-installable" });
    }
    yield* start(harness, Option.none(), false);
  });

  const cancel = Effect.fn("Harnesses.cancel")(function* (harness: SignInHarness) {
    const fiber = yield* lock.withPermits(1)(
      Effect.sync(() => {
        const running = jobs.get(harness);
        if (running !== undefined) cancelled.add(harness);
        return switching.has(harness) ? undefined : running;
      }),
    );
    // Not waited for: its end is on `copies`. A switch under way is not
    // stopped: it finishes, and a copy it made current stays installed.
    if (fiber !== undefined) yield* Fiber.interrupt(fiber).pipe(Effect.forkIn(scope));
  });

  /**
   * Whether `harness` has no copy at all to run and J3 Bots should install
   * one without being asked: none of J3 Bots', none of the operator's, a
   * build for this machine, and no install of it the operator cancelled.
   */
  const missing = (harness: SignInHarness, slot: Slot) =>
    Option.isNone(slot.installed) &&
    !slot.operator &&
    options.distributions[harness].installable &&
    slot.state.last?._tag !== "cancelled";

  /**
   * Reads `harness`'s listing, and installs it when it is `missing`, or a
   * newer version than J3 Bots' copy when updates install by themselves, as
   * they do once it was read. A harness the operator has on `PATH`, and no
   * copy of J3 Bots', is theirs to update: it is not read.
   */
  const check = Effect.fn("Harnesses.check")(function* (harness: SignInHarness) {
    const operator = yield* options.onPath(harness);
    yield* update(harness, (slot) => ({ ...slot, operator }));
    const slot = yield* slotOf(harness);
    if (slot === undefined || !options.distributions[harness].installable) return true;
    if (Option.isNone(slot.installed) && operator) return true;
    const release = yield* latestOf(harness).pipe(Effect.option);
    if (Option.isNone(release)) return false;
    if (missing(harness, slot)) {
      yield* start(harness, release, false, (now) => missing(harness, now));
    } else if (
      (yield* SubscriptionRef.get(autoUpdate)) &&
      Option.isSome(slot.installed) &&
      isNewerHarness(release.value.version, slot.installed.value.version)
    ) {
      yield* start(harness, release, true);
    }
    return true;
  });

  yield* options.autoUpdate.pipe(
    Stream.changes,
    Stream.runForEach((on) =>
      Effect.gen(function* () {
        const before = yield* SubscriptionRef.getAndSet(autoUpdate, on);
        // Turned on: what is newer installs now, not at the next check.
        if (on && !before) {
          yield* Effect.forEach(HARNESS_IDS, check, { discard: true }).pipe(Effect.forkIn(scope));
        }
      }),
    ),
    Effect.forkIn(scope),
  );

  // Each time the engine is ready again it is a new engine, which releases
  // every session the one before had open, and runs the current copies: a
  // copy before one of them, or a stranded one, runs nowhere now. A harness
  // whose job is under way is left to it.
  yield* engine.status.pipe(
    Stream.map((status) => status.state._tag === "ready"),
    Stream.changes,
    Stream.filter((ready) => ready),
    Stream.runForEach(() =>
      lock.withPermits(1)(
        Effect.forEach(
          HARNESS_IDS,
          (harness) =>
            Effect.gen(function* () {
              if (jobs.has(harness)) return;
              stranded.delete(harness);
              const slot = yield* slotOf(harness);
              if (slot !== undefined) yield* prune(harness, slot, slot.state.latest);
            }),
          { discard: true },
        ),
      ),
    ),
    Effect.forkIn(scope),
  );

  // Each harness that is missing starts installing now, beside the other and
  // the engine's download, so that a first run finds them installed or under
  // way. As a client's request, it is not given up when updates are off.
  yield* Effect.forEach(
    HARNESS_IDS,
    (harness) => start(harness, Option.none(), false, (slot) => missing(harness, slot)),
    { discard: true },
  );

  // Each listing on its own: a minute after the start, then about every six
  // hours, or an hour after a read that did not answer. A defect in one
  // round is logged, and the next comes an hour later.
  yield* Effect.forEach(
    HARNESS_IDS,
    (harness) =>
      Effect.gen(function* () {
        yield* Effect.sleep(FIRST_CHECK_AFTER);
        return yield* Effect.forever(
          Effect.gen(function* () {
            const answered = yield* check(harness);
            const jitter = Duration.millis(
              yield* Random.nextIntBetween(0, Duration.toMillis(JITTER)),
            );
            yield* Effect.sleep(answered ? Duration.sum(CHECK_EVERY, jitter) : RETRY_AFTER);
          }).pipe(
            Effect.catchDefect((defect) =>
              Effect.logError("Could not check for a newer harness", { defect }).pipe(
                Effect.andThen(Effect.sleep(RETRY_AFTER)),
              ),
            ),
          ),
        );
      }).pipe(Effect.forkIn(scope)),
    { discard: true },
  );

  return Harnesses.of({
    copies: SubscriptionRef.changes(published),
    install,
    cancel,
  });
});

/**
 * The service as the server runs it: in the server's home, with the
 * distributions, probe and operator's own of `HarnessSources`, the
 * `autoUpdateHarnesses` setting, and a switch that
 * holds bots' first sends, counts the bots whose work runs in a session on
 * the provider, and has the engine release that provider's sessions.
 */
export const layer = Layer.effect(
  Harnesses,
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const sources = yield* HarnessSources;
    const settings = yield* SettingsService;
    const pause = yield* SendPause;
    const runningWork = yield* RunningWork;
    const engine = yield* Engine;
    return yield* make({
      home,
      platform: sources.platform,
      distributions: sources.distributions,
      probe: sources.probe,
      onPath: sources.onPath,
      autoUpdate: settings.changes.pipe(Stream.map((saved) => saved.autoUpdateHarnesses)),
      work: {
        paused: pause.paused,
        running: (providerId) => Effect.map(runningWork.botsOn(providerId), (bots) => bots.length),
        release: Effect.fn("Harnesses.release")(function* (providerId: ProviderId) {
          const sessions = yield* runningWork.sessionsOn(providerId);
          const each = yield* Effect.forEach(sessions, (sessionId) =>
            engine.configureSession({ sessionId, reloadTools: true }).pipe(
              Effect.as(true),
              Effect.catch((cause) =>
                Effect.logWarning("The engine did not release a session for a harness update", {
                  cause,
                }).pipe(Effect.as(false)),
              ),
            ),
          );
          return each.every(Boolean);
        }),
      },
    });
  }),
);

/**
 * `status` with each harness's copy (`EngineStatus.harnesses`), whatever the
 * engine's state, and each Claude Code and Codex provider with its harness's
 * copy (`ProviderStatus.copy`). One that runs J3 Bots' own copy leaves out the
 * engine's `version` and `update`: that copy is updated by J3 Bots, never by
 * the engine's update, which would run the harness's own updater on it.
 */
export const withCopies = (status: EngineStatus, copies: HarnessCopies): EngineStatus => ({
  ...status,
  harnesses: copies,
  providers: status.providers.map((provider) => {
    const harness = HARNESS_IDS.find((id) => id === provider.id);
    if (harness === undefined) return provider;
    const copy = copies[harness];
    if (copy.source !== "j3") return { ...provider, copy };
    const { version: _version, update: _update, ...rest } = provider;
    return { ...rest, copy };
  }),
});
