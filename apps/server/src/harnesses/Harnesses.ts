// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Conflict,
  type EngineStatus,
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
import { findOnPath } from "../engine/harnesses.ts";
import { Layout } from "../Layout.ts";
import { SettingsService } from "../settings/SettingsService.ts";
import { Host } from "../system/Host.ts";
import { RunningWork } from "../turns/RunningWork.ts";
import { SendPause } from "../turns/SendPause.ts";
import type { Distribution, Release } from "./distributions.ts";
import { HarnessFailed } from "./failure.ts";
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
// (docs/decisions/0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md):
// installed when a client asks, for a harness the operator has none of on
// the server's `PATH`, and kept up to date. Each maker's listing is read a
// minute after the server starts and about every six hours after; a newer
// version than J3 Bots' copy is installed then unless the operator turned
// that off (`autoUpdateHarnesses`), and a client can ask for it at any time.
//
// A new version is downloaded, checked against its maker's SHA-256, run once,
// and installed beside the one the provider runs, which keeps running. The
// switch then waits until no bot on the provider has work running, since
// the engine ends the harness's processes when it runs another executable:
// a turn is never cut. While it switches, no bot's first send goes out (the
// `SendPause`), so none starts on the old copy in between; a turn that would
// start then waits the moment the switch takes. Only once the engine runs the
// new version is `current.json` replaced and the old version removed.

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
   * Removes what an install left that is not the current copy: other
   * versions, unpacking folders, and every download but one of `resume`,
   * which the next install of that version resumes. Only space is at stake,
   * so a failure is logged and left.
   */
  const prune = Effect.fn("Harnesses.prune")(function* (
    harness: SignInHarness,
    slot: Slot,
    resume: string | null,
  ) {
    const layout = layoutOf(harness);
    const current = Option.map(slot.installed, (copy) => copy.version);
    const versions = yield* fs.readDirectory(layout.versions).pipe(Effect.orElseSucceed(() => []));
    const leftovers = [
      ...versions
        .filter((version) => !Option.contains(current, version))
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

  /**
   * Runs the engine's provider on `copy`, once no bot on it has work running,
   * then makes it current and removes the copy before it; false while it
   * waits, for that work or for an engine that is not ready, which runs the
   * copy it ran. An engine that may have taken `copy` without showing it runs
   * it is put back on the copy before, as is one whose `current.json` cannot
   * be written, so the engine and `current.json` name the same copy.
   */
  const switchTo = Effect.fn("Harnesses.switchTo")(function* (
    harness: SignInHarness,
    copy: InstalledCopy,
    before: Option.Option<InstalledCopy>,
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
      .pipe(Effect.ignore);
    const engineFailed = () => new HarnessFailed({ reason: "engine" });
    const switched = yield* options.work
      .paused(
        Effect.gen(function* () {
          if ((yield* options.work.running(providerId)) > 0) return false;
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
          if (!taken) return false;
          yield* currentText(copy).pipe(
            Effect.flatMap((text) => files.writeFile(layout.current, text)),
            Effect.mapError(() => new HarnessFailed({ reason: "storage" })),
            Effect.tapError(() => putBack),
          );
          // Recorded in the same step: a cancel that lands meanwhile finds
          // the copy the engine now runs installed, and keeps it.
          yield* update(harness, (slot) => ({ ...slot, installed: Option.some(copy), task: null }));
          return true;
        }),
      )
      .pipe(Effect.uninterruptible);
    if (!switched) return false;
    if (Option.isSome(before) && before.value.version !== copy.version) {
      yield* fs
        .remove(layout.version(before.value.version), { recursive: true, force: true })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not remove the harness copy a newer one replaced", { cause }),
          ),
        );
    }
    return true;
  });

  // The harnesses whose job a client asked for, rather than the check alone.
  const requested = new Set<SignInHarness>();

  /**
   * An install or update of `harness`, to `known` when given, else to the
   * newest listed: the copy it installed, none when it found nothing newer,
   * or gave the copy up while it waited: for the operator's own, found on
   * `PATH` meanwhile, by a first install, or for updates turned off, by an
   * update the check started and no client asked for.
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
    const copy = yield* installRelease({
      release,
      layout,
      files,
      client: options.distributions[harness].client,
      probe: options.probe(harness),
      platform: options.platform,
      report,
    });
    yield* report({ _tag: "waiting" });
    const giveUp = (why: string) =>
      Effect.logInfo(why).pipe(
        Effect.annotateLogs({ harness, version: copy.version }),
        Effect.andThen(files.writable(layout.version(copy.version))),
        Effect.andThen((location) => fs.remove(location, { recursive: true, force: true })),
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove a harness copy that was given up", { cause }),
        ),
        Effect.as(Option.none<InstalledCopy>()),
      );
    while (true) {
      if (Option.isNone(before) && (yield* options.onPath(harness))) {
        yield* update(harness, (slot) => ({ ...slot, operator: true }));
        return yield* giveUp(
          "The operator installed the harness meanwhile; J3 Bots' copy is not used",
        );
      }
      if (automatic && !requested.has(harness) && !(yield* SubscriptionRef.get(autoUpdate))) {
        return yield* giveUp("Updates were turned off; a waiting update is not installed");
      }
      if (yield* switchTo(harness, copy, before)) break;
      yield* Effect.sleep(WAIT_STEP);
    }
    yield* Effect.logInfo("J3 Bots' copy of a harness was installed").pipe(
      Effect.annotateLogs({ harness, version: copy.version }),
    );
    return Option.some(copy);
  });

  // The job of each harness under way, and the harnesses whose job a client cancelled.
  const jobs = new Map<SignInHarness, Fiber.Fiber<Option.Option<InstalledCopy>, HarnessFailed>>();
  const cancelled = new Set<SignInHarness>();
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
  const start = (harness: SignInHarness, known: Option.Option<Release>, automatic: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!automatic) requested.add(harness);
        if (jobs.has(harness)) return;
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
        return running;
      }),
    );
    // Not waited for: a switch under way finishes first, and its end is on `copies`.
    if (fiber !== undefined) yield* Fiber.interrupt(fiber).pipe(Effect.forkIn(scope));
  });

  /**
   * Reads `harness`'s listing, and installs a newer version than J3 Bots'
   * copy when updates install by themselves, as they do once it was read. A
   * harness the operator has on `PATH`, and no copy of J3 Bots', is theirs
   * to update: it is not read.
   */
  const check = Effect.fn("Harnesses.check")(function* (harness: SignInHarness) {
    const operator = yield* options.onPath(harness);
    yield* update(harness, (slot) => ({ ...slot, operator }));
    const slot = yield* slotOf(harness);
    if (slot === undefined || !options.distributions[harness].installable) return true;
    if (Option.isNone(slot.installed) && operator) return true;
    const release = yield* latestOf(harness).pipe(Effect.option);
    if (Option.isNone(release)) return false;
    if (
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
        if (on && !before) yield* Effect.forEach(HARNESS_IDS, check);
      }),
    ),
    Effect.forkIn(scope),
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
 * distributions and probe of `HarnessSources`, the operator's own found as
 * the engine finds it, the `autoUpdateHarnesses` setting, and a switch that
 * holds bots' first sends and counts the bots whose work runs in a session on the provider.
 */
export const layer = Layer.effect(
  Harnesses,
  Effect.gen(function* () {
    const { home } = yield* ServerConfig;
    const sources = yield* HarnessSources;
    const host = yield* Host;
    const settings = yield* SettingsService;
    const pause = yield* SendPause;
    const runningWork = yield* RunningWork;
    return yield* make({
      home,
      platform: sources.platform,
      distributions: sources.distributions,
      probe: sources.probe,
      onPath: (harness) =>
        findOnPath(harness, Option.none()).pipe(
          Effect.map(({ executable }) => Option.isSome(executable)),
          Effect.provideService(Host, host),
        ),
      autoUpdate: settings.changes.pipe(Stream.map((saved) => saved.autoUpdateHarnesses)),
      work: {
        paused: pause.paused,
        running: (providerId) => Effect.map(runningWork.botsOn(providerId), (bots) => bots.length),
      },
    });
  }),
);

/**
 * `status`, each Claude Code and Codex provider with its harness's copy
 * (`ProviderStatus.copy`). One that runs J3 Bots' own copy leaves out the
 * engine's `version` and `update`: that copy is updated by J3 Bots, never by
 * the engine's update, which would run the harness's own updater on it.
 */
export const withCopies = (
  status: EngineStatus,
  copies: Readonly<Record<SignInHarness, HarnessCopy>>,
): EngineStatus => ({
  ...status,
  providers: status.providers.map((provider) => {
    const harness = HARNESS_IDS.find((id) => id === provider.id);
    if (harness === undefined) return provider;
    const copy = copies[harness];
    if (copy.source !== "j3") return { ...provider, copy };
    const { version: _version, update: _update, ...rest } = provider;
    return { ...rest, copy };
  }),
});
