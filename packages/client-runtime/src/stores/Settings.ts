// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BrowserSignIns,
  type BrowserSite,
  type ModelChoice,
  type NotificationSettingsChange,
  type Settings as SettingsValue,
  TimeZone,
  type VoiceSettingsChange,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Connection, type J3RpcClient, type NotPaired } from "../connection/Connection.ts";
import { DeviceTimeZone } from "../ports.ts";
import { Actions, intentResult, type IntentResult } from "../intents/Actions.ts";
import { Cell, type Readable } from "../Store.ts";
import { makeKeyed } from "./keyed.ts";
import { loading, markStale, ready, type Synced } from "./synced.ts";

/**
 * The sites the person is signed in to in J3 Bots' browser, as Settings
 * shows them; `unsupported` on a server older than the list, which shows
 * none.
 */
export type SignInsState = Synced<BrowserSignIns> | { readonly _tag: "unsupported" };

/** What the profile in Settings changes. Fields left out keep their value. */
export type ProfileChanges = Partial<Pick<SettingsValue, "operatorName" | "timeZone">>;

/**
 * A change of the settings, with the section of Settings that makes it. Each
 * section saves on its own, so one's save never speaks for another's.
 */
export type SettingsChange =
  | { readonly section: "profile"; readonly changes: ProfileChanges }
  | { readonly section: "notifications"; readonly changes: NotificationSettingsChange }
  | { readonly section: "harnesses"; readonly changes: HarnessSettingsChanges }
  /** Sent only to a server whose settings carry `voice`. */
  | { readonly section: "voice"; readonly changes: VoiceSettingsChange }
  | { readonly section: "usage-data"; readonly changes: UsageDataChanges }
  /** Sent only to a server whose settings carry `favoriteModels`. */
  | { readonly section: "favorites"; readonly changes: FavoriteChanges };

/** The starred models, whole, in the order the operator starred them. */
export interface FavoriteChanges {
  readonly favoriteModels: ReadonlyArray<ModelChoice>;
}

/** The operator's switch for usage data; only for a server whose settings carry `telemetry`. */
export interface UsageDataChanges {
  readonly enabled: boolean;
}

/**
 * What the harnesses do on their own: whether the server updates the copies it
 * installed, and whether they guess the operator's next message after a turn.
 * Fields left out keep their value; `suggestReplies` goes only to a server
 * whose settings carry it.
 */
export interface HarnessSettingsChanges {
  readonly autoUpdateHarnesses?: boolean;
  readonly suggestReplies?: boolean;
}

/**
 * A section's save: under way, or how its last one ended, each with what it
 * sends. A failed one keeps what it sent, so a form that did not see it can
 * offer it again.
 */
export type SettingsSave<Changes> =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "saving" | "saved" | "failed";
      readonly changes: Changes;
    };

/** The latest save of each section of Settings. */
export interface SettingsSaves {
  readonly profile: SettingsSave<ProfileChanges>;
  readonly notifications: SettingsSave<NotificationSettingsChange>;
  readonly harnesses: SettingsSave<HarnessSettingsChanges>;
  readonly voice: SettingsSave<VoiceSettingsChange>;
  readonly "usage-data": SettingsSave<UsageDataChanges>;
  readonly favorites: SettingsSave<FavoriteChanges>;
}

/**
 * The operator's preferences. They are read when each socket opens, then
 * followed: the server tells every change, whoever made it, a bot the
 * operator told what to call them included. A server older than that
 * subscription tells none, so they are also read again after each save the
 * server accepts and on `refresh`, and there a change made elsewhere shows
 * after the next reconnect, save or `refresh`. They have no revision, so only
 * the read started or the change told last is shown. What a save returns is
 * not shown: answered again from its receipt after a reconnection, it can be
 * older than what the reconnection read.
 *
 * Each socket first gives the server the device's time zone, which becomes
 * the operator's while they have chosen none, so the first read shows it.
 */
export class Settings extends Context.Service<
  Settings,
  {
    readonly state: Readable<Synced<SettingsValue>>;
    /**
     * Each section's latest save, which outlives any screen that shows it: one
     * that waits through a disconnection is still under way when Settings
     * opens again.
     */
    readonly saves: { readonly [Section in keyof SettingsSaves]: Readable<SettingsSaves[Section]> };
    readonly update: (change: SettingsChange) => Effect.Effect<IntentResult<SettingsValue>>;
    /** Reads them again, as when Settings opens, for a change another device made meanwhile. */
    readonly refresh: Effect.Effect<void, NotPaired>;
    /**
     * The sites the person is signed in to, followed while held: on every
     * socket, each change as the server tells it.
     */
    readonly openSignIns: Effect.Effect<Readable<SignInsState>, never, Scope.Scope>;
    /** Signs J3 Bots' browser out of one site, everywhere. */
    readonly signOutSite: (site: BrowserSite) => Effect.Effect<IntentResult<void>>;
    /** Signs J3 Bots' browser out of every site, everywhere. */
    readonly signOutBrowser: Effect.Effect<IntentResult<void>>;
  }
>()("@j3-bots/client-runtime/stores/Settings") {}

/**
 * Runs reads of one value and passes on only the answer of the read started
 * last: an older read that answers while a newer one is on its way, or after
 * it, would show what the newer one replaces.
 */
export const latestRead = <A>(show: (value: A) => void) => {
  let started = 0;
  return <E, R>(read: Effect.Effect<A, E, R>): Effect.Effect<void, E, R> =>
    Effect.suspend(() => {
      const ticket = ++started;
      return read.pipe(
        Effect.flatMap((value) =>
          Effect.sync(() => {
            if (ticket === started) show(value);
          }),
        ),
      );
    });
};

export const layer = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const connection = yield* Connection;
    const actions = yield* Actions;
    const deviceZone = yield* DeviceTimeZone;
    const scope = yield* Scope.Scope;
    const state = new Cell<Synced<SettingsValue>>(loading);
    const saves = {
      profile: new Cell<SettingsSaves["profile"]>({ _tag: "idle" }),
      notifications: new Cell<SettingsSaves["notifications"]>({ _tag: "idle" }),
      harnesses: new Cell<SettingsSaves["harnesses"]>({ _tag: "idle" }),
      voice: new Cell<SettingsSaves["voice"]>({ _tag: "idle" }),
      "usage-data": new Cell<SettingsSaves["usage-data"]>({ _tag: "idle" }),
      favorites: new Cell<SettingsSaves["favorites"]>({ _tag: "idle" }),
    };

    const latest = latestRead((settings: SettingsValue) => state.set(ready(settings)));
    /** Reads the settings, and shows them unless a read started later is under way or done. */
    const read = (client: J3RpcClient) => latest(client["settings.get"]());

    /**
     * Gives the server this device's time zone. Nothing depends on it, so a
     * zone the contract refuses, a failure or a server older than the RPC
     * changes nothing here.
     */
    const giveZone = (client: J3RpcClient) =>
      deviceZone.current.pipe(
        Effect.map(Option.liftPredicate(Schema.is(TimeZone))),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (timeZone) =>
              client["settings.deviceTimeZone"]({ timeZone }).pipe(Effect.ignoreCause),
          }),
        ),
      );

    /**
     * Shows each change the server tells. A failure of the stream changes
     * nothing here: the settings stay as last read.
     */
    const follow = (client: J3RpcClient) =>
      client["settings.subscribe"]().pipe(
        Stream.runForEach((settings) => latest(Effect.succeed(settings))),
        Effect.ignoreCause,
      );

    yield* connection
      .eachSession((client) =>
        giveZone(client).pipe(
          Effect.andThen(read(client)),
          Effect.andThen(follow(client)),
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => state.update(markStale))),
        ),
      )
      .pipe(Effect.forkScoped);

    const refresh = connection.call(read);

    /** Sends `sent` and follows it in the save of the section that made `changes`. */
    const save = Effect.fn("Settings.save")(function* <Changes>(
      cell: Cell<SettingsSave<Changes>>,
      changes: Changes,
      sent: ProfileChanges &
        HarnessSettingsChanges & {
          readonly notifications?: NotificationSettingsChange;
          readonly voice?: VoiceSettingsChange;
          readonly telemetry?: boolean;
          readonly favoriteModels?: ReadonlyArray<ModelChoice>;
        },
    ) {
      const commandId = yield* actions.commandId;
      const saving: SettingsSave<Changes> = { _tag: "saving", changes };
      cell.set(saving);
      const exit = yield* connection
        .call((client) => client["settings.update"]({ commandId, ...sent }))
        .pipe(Effect.exit);
      const result = intentResult(exit);
      if (result._tag === "done") yield* refresh.pipe(Effect.ignore);
      // A later save of the same section speaks for itself.
      if (cell.get() === saving) {
        cell.set({ _tag: result._tag === "done" ? "saved" : "failed", changes });
      }
      return result;
    });

    const update = Effect.fn("Settings.update")(function* (change: SettingsChange) {
      switch (change.section) {
        case "profile":
          return yield* save(saves.profile, change.changes, change.changes);
        case "notifications":
          return yield* save(saves.notifications, change.changes, {
            notifications: change.changes,
          });
        case "harnesses":
          return yield* save(saves.harnesses, change.changes, change.changes);
        case "voice":
          return yield* save(saves.voice, change.changes, { voice: change.changes });
        case "usage-data":
          return yield* save(saves["usage-data"], change.changes, {
            telemetry: change.changes.enabled,
          });
        case "favorites":
          return yield* save(saves.favorites, change.changes, change.changes);
      }
    });

    const signIns = makeKeyed(
      scope,
      () => "signIns",
      () =>
        Effect.sync(() => {
          const signedIn = new Cell<SignInsState>(loading);
          const run = connection.eachSession((client) =>
            client["browser.signIns"]().pipe(
              Stream.runForEach((value) => Effect.sync(() => signedIn.set(ready(value)))),
              // The list cannot fail on a server that has it: a defect is a
              // server older than it, which has no list to show.
              Effect.catchDefect(() => Effect.sync(() => signedIn.set({ _tag: "unsupported" }))),
              Effect.ensuring(
                Effect.sync(() =>
                  signedIn.update((current) =>
                    current._tag === "unsupported" ? current : markStale(current),
                  ),
                ),
              ),
            ),
          );
          const value: Readable<SignInsState> = signedIn;
          return { value, run, close: () => {} };
        }),
    );

    const signOutSite = (site: BrowserSite) =>
      connection
        .call((client) => client["browser.signOutSite"]({ site }))
        .pipe(Effect.exit, Effect.map(intentResult));

    const signOutBrowser = connection
      .call((client) => client["browser.signOut"]())
      .pipe(Effect.exit, Effect.map(intentResult));

    return Settings.of({
      state,
      saves,
      update,
      refresh,
      openSignIns: signIns.acquire(undefined),
      signOutSite,
      signOutBrowser,
    });
  }),
);
