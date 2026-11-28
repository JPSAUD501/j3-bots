// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PageHost } from "@j3-bots/browser";
import {
  type BotId,
  type BrowserAction,
  type BrowserActResult,
  type BrowserBotName,
  type BrowserDialog,
  type BrowserDoneResult,
  type BrowserEvaluateResult,
  BrowserHostError,
  type BrowserHostEvent,
  type BrowserHostHello,
  type BrowserLoadError,
  type BrowserPageState,
  type BrowserSnapshotResult,
  type BrowserTab,
  type BrowserTabOpener,
  BrowserTabRef,
  type BrowserTabResult,
  type BrowserTabs,
  type BrowserTabWhere,
  type BrowserToolTab,
  type DeviceId,
  Label,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_SIZE,
  NotFound,
  type SharedBrowserTab,
  type SharedBrowserTabs,
} from "@j3-bots/contracts";
import { BROWSER_NOTES, type BrowserToolInput, type ServerBrowserProblem } from "@j3-bots/prompts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { workspaceReader } from "../attachments/workspaceFile.ts";
import { DeviceAuth } from "../auth/DeviceAuth.ts";
import { BotStore } from "../bots/BotStore.ts";
import { Devices } from "../devices/Devices.ts";
import { Ids } from "../Ids.ts";
import { makeRegistryStore, type StoredTab } from "./registry.ts";
import { ServerBrowser } from "./server/ServerBrowser.ts";
import { FillHoldRefused, TabAccess } from "./TabAccess.ts";
import { type ActRefused, makeTabControl, QUEUE_WAIT, type TabControl } from "./TabControl.ts";

// J3 Bots' browser (decision 0110): every tab, wherever it runs, as one
// shared list. Tabs belong to nobody: each bot that may browse sees every
// tab but the person's private ones, and may act on any. A tab runs in one
// page host at a time, a desktop app's own browser or the server's, and
// keeps its ref when it moves. This service decides where a new tab opens
// (the desktop the person used last, else the server), parks a tab whose
// host went away, and opens a parked tab again where tabs open now when a
// bot uses it. Who acts on a tab is each tab's `TabControl`.

/** How long a desktop's tabs wait for it to come back before they are parked. */
export const DESKTOP_GRACE = Duration.seconds(45);
/** The most tabs the server's browser keeps live: past it, the least used idle one is parked. */
export const SERVER_TAB_CAP = 3;
/** How long a server tab may go unused and unwatched before it is parked. */
const SERVER_TAB_IDLE = Duration.minutes(5);
/** How long a tab no person opened may go unused before it is closed. */
const UNUSED_TAB_LIFE = Duration.hours(24);
/** How long a bot counts as on a tab after it last used it. */
const ON_IT_FOR = Duration.minutes(30);
/** How often idle tabs are parked and closed, and an empty server browser closed. */
const SWEEP_EVERY = Duration.seconds(30);
/** The actions on a tab whose authors a bot is told of. */
const ACTION_LOG = 20;
/** Where a bot's downloads land in its workspace. */
const DOWNLOADS = "downloads";

/** A tool call the browser refused, in words for the bot. */
export class BrowserToolRefused extends Schema.TaggedError<BrowserToolRefused>()(
  "BrowserToolRefused",
  { text: Schema.String },
) {
  override get message(): string {
    return this.text;
  }
}

const refusal = (text: string) => new BrowserToolRefused({ text });

/** A tab a viewer watches: its host while it has one, and who acts on it. */
export interface WatchedTab {
  readonly ref: BrowserTabRef;
  /** The host the tab runs on now, and again whenever that changes; none while it has none. */
  readonly host: Stream.Stream<Option.Option<PageHost>>;
  /** The tab as the list shows it, now and on every change, until it closes. */
  readonly tab: Stream.Stream<SharedBrowserTab>;
  readonly control: TabControl;
  /** Ends once the tab closes. */
  readonly closed: Effect.Effect<void>;
}

/** Where a bot's action points while it runs, for its cursor. */
export interface BotPointer {
  readonly tab: BrowserTabRef;
  readonly botId: BotId | null;
  readonly action: "move" | "click";
  readonly x: number;
  readonly y: number;
}

/** A tab's control and its live host, for the server's own fill. */
export interface TabHands {
  readonly control: TabControl;
  readonly host: Option.Option<PageHost>;
  readonly page: BrowserPageState;
}

type Noticed<A> = A & { readonly notice?: string };

/** The `browser_*` tools, as the bridge's handlers call them. */
export interface BrowserTools {
  readonly tabs: (botId: BotId) => Effect.Effect<ReadonlyArray<BrowserToolTab>>;
  readonly open: (
    botId: BotId,
    input: BrowserToolInput<"browser_open">,
  ) => Effect.Effect<BrowserTabResult, BrowserToolRefused>;
  readonly navigate: (
    botId: BotId,
    input: BrowserToolInput<"browser_navigate">,
  ) => Effect.Effect<BrowserTabResult, BrowserToolRefused>;
  readonly snapshot: (
    botId: BotId,
    input: BrowserToolInput<"browser_snapshot">,
  ) => Effect.Effect<BrowserSnapshotResult, BrowserToolRefused>;
  readonly act: (
    botId: BotId,
    tab: BrowserTabRef | undefined,
    action: BrowserAction,
  ) => Effect.Effect<BrowserActResult, BrowserToolRefused>;
  readonly evaluate: (
    botId: BotId,
    input: BrowserToolInput<"browser_evaluate">,
  ) => Effect.Effect<BrowserEvaluateResult, BrowserToolRefused>;
  readonly waitFor: (
    botId: BotId,
    input: BrowserToolInput<"browser_wait_for">,
  ) => Effect.Effect<BrowserDoneResult, BrowserToolRefused>;
  readonly dialog: (
    botId: BotId,
    input: BrowserToolInput<"browser_dialog">,
  ) => Effect.Effect<BrowserTabResult, BrowserToolRefused>;
  readonly close: (
    botId: BotId,
    input: BrowserToolInput<"browser_close">,
  ) => Effect.Effect<BrowserDoneResult, BrowserToolRefused>;
}

export class Browser extends Context.Service<
  Browser,
  {
    /** Every tab, private ones included, now and on every change: the person's view. */
    readonly all: Stream.Stream<SharedBrowserTabs>;
    /** The tabs `botId` is on, as `device` sees them, now and on every change. */
    readonly ofBot: (botId: BotId, device: DeviceId) => Stream.Stream<BrowserTabs, NotFound>;
    /**
     * Opens a tab for the person on `device` as `ref`: on that desktop, else
     * where new tabs open. A tab already open as `ref` is left as it is.
     */
    readonly openForPerson: (input: {
      readonly device: DeviceId;
      readonly ref: BrowserTabRef;
      readonly url?: string | undefined;
    }) => Effect.Effect<void, BrowserToolRefused>;
    /** Closes a tab for the person. */
    readonly close: (ref: BrowserTabRef) => Effect.Effect<void, NotFound>;
    /** A viewer of `ref` while the scope lives, which keeps the tab from being parked. */
    readonly watch: (
      ref: BrowserTabRef,
    ) => Effect.Effect<Option.Option<WatchedTab>, never, Scope.Scope>;
    /** Where bots' actions point, as they act. */
    readonly pointers: Stream.Stream<BotPointer>;
    /**
     * The person used `ref`'s page from `device`, through a viewer: they hold
     * it. False when the tab is gone, or a person on another device holds it:
     * their input is then not applied.
     */
    readonly personUsed: (ref: BrowserTabRef, device: DeviceId) => Effect.Effect<boolean>;
    /**
     * `botId` may browse no more, its browser turned off or the bot deleted:
     * its queued actions fail, its leases end, and it is on no tab.
     */
    readonly withdraw: (botId: BotId) => Effect.Effect<void>;
    /**
     * Serves `host` until the scope closes or its events end: its tabs join
     * the list, and new tabs may open on it. A desktop's tabs then wait
     * `DESKTOP_GRACE` for it to come back before they are parked. Answers
     * the host's hello, and `ended`, which returns once its events end.
     */
    readonly attachHost: (
      host: PageHost,
    ) => Effect.Effect<
      { readonly hello: BrowserHostHello; readonly ended: Effect.Effect<void> },
      BrowserHostError,
      Scope.Scope
    >;
    /** Why the server's own browser could not start the last time it was asked to; none once it did. */
    readonly serverProblem: Stream.Stream<Option.Option<ServerBrowserProblem>>;
    /** The tab a bot's call works on, as the `browser_*` tools resolve it. */
    readonly toolTab: (
      botId: BotId,
      ref: BrowserTabRef | undefined,
    ) => Effect.Effect<Option.Option<SharedBrowserTab>>;
    /** A tab's control and live host. */
    readonly handsOf: (ref: BrowserTabRef) => Effect.Effect<Option.Option<TabHands>>;
    readonly tools: BrowserTools;
  }
>()("@j3-bots/server/browser/Browser") {}

/** A host, by what it runs on: `server`, or `desktop:<device>`. */
type HostKey = string;
const SERVER: HostKey = "server";
const desktopKey = (device: DeviceId): HostKey => `desktop:${device}`;
const keyOfHello = (hello: BrowserHostHello): HostKey =>
  hello.host.kind === "server" ? SERVER : desktopKey(hello.host.device);

interface Host {
  readonly key: HostKey;
  readonly host: PageHost;
  readonly hello: BrowserHostHello;
  /** When the person last used this desktop, as far as its host says. */
  activeAt: number;
  /** The tab the person has in front of them in this desktop's app. */
  focused: BrowserTabRef | null;
  focusedAt: number;
}

interface Tab {
  readonly ref: BrowserTabRef;
  readonly openedBy: BrowserTabOpener;
  readonly private: boolean;
  readonly createdAt: number;
  url: string;
  title: string;
  loading: boolean;
  loadError: BrowserLoadError | null;
  dialog: BrowserDialog | null;
  /** Where it runs, also while it waits for its desktop to come back. */
  where: BrowserTabWhere;
  /** When each bot last used it. */
  readonly bots: Map<BotId, number>;
  usedAt: number;
  readonly control: TabControl;
  readonly scope: Scope.Closeable;
  /** Its last actions, with who made each. */
  readonly actions: Array<{ readonly n: number; readonly by: BotId }>;
  actionCount: number;
  /** How many times it was opened again after its host lost it. */
  reopened: number;
  viewers: number;
  readonly hostChanges: SubscriptionRef.SubscriptionRef<BrowserTabWhere>;
}

const keyOfWhere = (where: BrowserTabWhere): HostKey | null => {
  switch (where.kind) {
    case "parked":
      return null;
    case "server":
      return SERVER;
    case "desktop":
      return desktopKey(where.device);
  }
};

const whereOfHello = (hello: BrowserHostHello): BrowserTabWhere =>
  hello.host.kind === "server"
    ? { kind: "server" }
    : { kind: "desktop", device: hello.host.device };

/** What a bot saw of a tab when it last used it, for the notice of its next call. */
interface Seen {
  readonly actions: number;
  readonly reopened: number;
}

/** A file name with no folder in it, at most an attachment name's length. */
const plainName = (name: string): string => {
  const plain = name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, MAX_ATTACHMENT_NAME_LENGTH);
  return plain.length === 0 || plain === "." || plain === ".." ? "file" : plain;
};

export const layer = Layer.effect(
  Browser,
  Effect.gen(function* () {
    const store = yield* makeRegistryStore;
    const bots = yield* BotStore;
    const devices = yield* Devices;
    const auth = yield* DeviceAuth;
    const ids = yield* Ids;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const readWorkspaceFile = yield* workspaceReader;
    const serverBrowser = yield* ServerBrowser;
    const serviceScope = yield* Effect.scope;

    const tabs = new Map<BrowserTabRef, Tab>();
    const hosts = new Map<HostKey, Host>();
    /** Each bot's current tab: the one it last opened or used. */
    const current = new Map<BotId, BrowserTabRef>();
    const seen = new Map<string, Seen>();
    /** Lines a bot reads with its next result on a tab: what happened there meanwhile. */
    const pending = new Map<string, Array<string>>();
    const graces = new Map<HostKey, Fiber.Fiber<void>>();
    const version = yield* SubscriptionRef.make(0);
    const pointers = yield* PubSub.unbounded<BotPointer>();
    const serverProblem = yield* SubscriptionRef.make<Option.Option<ServerBrowserProblem>>(
      Option.none(),
    );
    /** One start or stop of the server's browser at a time. */
    const serverLock = yield* Semaphore.make(1);
    let server: Scope.Closeable | null = null;
    /** When the server's browser last started or had a tab used, so an empty one closes only once idle. */
    let serverUsedAt = 0;

    const now = Clock.currentTimeMillis;
    const bump = SubscriptionRef.update(version, (n) => n + 1);
    const seenKey = (botId: BotId, ref: BrowserTabRef) => `${botId}\u0000${ref}`;

    const nameOf = Effect.fnUntraced(function* (botId: BotId) {
      const found = yield* bots.find(botId);
      return Option.match(found, {
        onNone: () => "Another bot",
        onSome: (stored) => stored.bot.profile.name,
      });
    });

    const botName = Effect.fnUntraced(function* (botId: BotId) {
      return { bot: botId, name: Label.make(yield* nameOf(botId)) } satisfies BrowserBotName;
    });

    const deviceName = Effect.fnUntraced(function* (device: DeviceId) {
      const listed = yield* devices.list(device);
      const name = listed.find((each) => each.id === device)?.name ?? "";
      return name.length === 0 ? Option.none() : Option.some(Label.make(name.slice(0, 64)));
    });

    /** The bots on a tab within `ON_IT_FOR` of `at`, or every one it keeps, the most recent first. */
    const onItOf = (tab: Tab, at: number | null): ReadonlyArray<BotId> =>
      [...tab.bots.entries()]
        .filter(([, usedAt]) => at === null || at - usedAt < Duration.toMillis(ON_IT_FOR))
        .sort((left, right) => right[1] - left[1])
        .map(([botId]) => botId);

    const persist = (tab: Tab) =>
      tab.private
        ? Effect.void
        : store.save({
            ref: tab.ref,
            url: tab.url,
            title: tab.title,
            openedBy: tab.openedBy,
            onIt: onItOf(tab, null),
            createdAt: tab.createdAt,
            usedAt: tab.usedAt,
          } satisfies StoredTab);

    /**
     * A person's holds from `device` end once it is revoked: nobody can give
     * the tabs back from it then, and a "Wait for me" would hold them for
     * good. One watch per device that holds a tab.
     */
    const revokeWatched = new Set<DeviceId>();
    const endsOnRevoke = (device: DeviceId) =>
      Effect.suspend(() => {
        if (revokeWatched.has(device)) return Effect.void;
        revokeWatched.add(device);
        return auth.revoked(device).pipe(
          // Another device's release gives nothing back, so every tab is asked.
          Effect.andThen(
            Effect.suspend(() =>
              Effect.forEach(tabs.values(), (each) => each.control.release(device, false), {
                discard: true,
              }),
            ),
          ),
          Effect.ensuring(Effect.sync(() => revokeWatched.delete(device))),
          Effect.forkIn(serviceScope),
          Effect.asVoid,
        );
      });

    const hostOf = (tab: Tab): Host | undefined => {
      const key = keyOfWhere(tab.where);
      return key === null ? undefined : hosts.get(key);
    };

    const makeTab = Effect.fnUntraced(function* (input: {
      readonly ref: BrowserTabRef;
      readonly openedBy: BrowserTabOpener;
      readonly private: boolean;
      readonly createdAt: number;
      readonly usedAt: number;
      readonly url: string;
      readonly title: string;
      readonly where: BrowserTabWhere;
      readonly onIt: ReadonlyArray<BotId>;
    }) {
      const scope = yield* Scope.fork(serviceScope);
      const control = yield* makeTabControl.pipe(Scope.provide(scope));
      const tab: Tab = {
        ref: input.ref,
        openedBy: input.openedBy,
        private: input.private,
        createdAt: input.createdAt,
        url: input.url,
        title: input.title,
        loading: false,
        loadError: null,
        dialog: null,
        where: input.where,
        bots: new Map(input.onIt.map((botId) => [botId, input.usedAt])),
        usedAt: input.usedAt,
        control,
        scope,
        actions: [],
        actionCount: 0,
        reopened: 0,
        viewers: 0,
        hostChanges: yield* SubscriptionRef.make(input.where),
      };
      tabs.set(tab.ref, tab);
      // Each change of hands changes the list.
      yield* control.changes.pipe(
        Stream.runForEach((state) =>
          state.holder?.kind === "person"
            ? endsOnRevoke(state.holder.device).pipe(Effect.andThen(bump))
            : bump,
        ),
        Effect.forkIn(scope),
      );
      return tab;
    });

    const moveTo = Effect.fnUntraced(function* (tab: Tab, where: BrowserTabWhere) {
      tab.where = where;
      if (where.kind === "server") serverUsedAt = yield* now;
      yield* SubscriptionRef.set(tab.hostChanges, where);
    });

    /** Forgets a tab: it closed. */
    const forget = Effect.fnUntraced(function* (tab: Tab) {
      if (tabs.get(tab.ref) !== tab) return;
      tabs.delete(tab.ref);
      for (const [botId, ref] of current) if (ref === tab.ref) current.delete(botId);
      yield* tab.control.close;
      yield* store.remove(tab.ref);
      yield* Scope.close(tab.scope, Exit.void);
      yield* bump;
    });

    /** Parks a tab: its host lost it or let it go. It keeps its ref, address and title. */
    const park = Effect.fnUntraced(function* (tab: Tab) {
      if (tab.private) return yield* forget(tab);
      yield* moveTo(tab, { kind: "parked" });
      tab.loading = false;
      tab.dialog = null;
      yield* bump;
    });

    const pageOf = (tab: Tab): BrowserPageState => ({
      tab: tab.ref,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      loadError: tab.loadError,
      dialog: tab.dialog,
    });

    const learnPage = (tab: Tab, page: BrowserPageState) => {
      tab.url = page.url;
      tab.title = page.title;
      tab.loading = page.loading;
      tab.loadError = page.loadError;
      tab.dialog = page.dialog;
    };

    const tell = (botId: BotId, ref: BrowserTabRef, line: string) => {
      const key = seenKey(botId, ref);
      const lines = pending.get(key) ?? [];
      lines.push(line);
      pending.set(key, lines);
    };

    // -----------------------------------------------------------------------
    // Downloads

    /** A free name in `folder` for `name`: `name`, then `name (2)`, and on. */
    const freeName = Effect.fnUntraced(function* (folder: string, name: string) {
      const dot = name.lastIndexOf(".");
      const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      for (let count = 1; count < 1_000; count++) {
        const candidate = count === 1 ? name : `${stem} (${count})${extension}`;
        const taken = yield* fs
          .exists(path.join(folder, candidate))
          .pipe(Effect.orElseSucceed(() => true));
        if (!taken) return Option.some(candidate);
      }
      return Option.none<string>();
    });

    /**
     * Keeps a file a bot's action downloaded in the bot's workspace, and
     * tells the bot with its next result on the tab. A download no bot's
     * action made is let go.
     */
    const keepDownload = Effect.fnUntraced(function* (
      host: Host,
      event: Extract<BrowserHostEvent, { readonly type: "download.finished" }>,
    ) {
      const tab = tabs.get(event.tab);
      const state = tab === undefined ? null : yield* tab.control.state;
      const botId =
        state === null
          ? null
          : (state.acting ?? (state.holder?.kind === "bot" ? state.holder.botId : null));
      const letGo = host.host.takeDownload({ download: event.download }).pipe(Effect.ignore);
      if (botId === null) return yield* letGo;
      if (event.size > MAX_ATTACHMENT_SIZE) {
        tell(botId, event.tab, BROWSER_NOTES.downloadTooLarge(event.name));
        return yield* letGo;
      }
      const stored = yield* bots.find(botId);
      const root = Option.flatMap(stored, (found) => found.workspaceRoot);
      if (Option.isNone(root)) return yield* letGo;
      const { bytes } = yield* host.host.takeDownload({ download: event.download });
      const folder = path.join(root.value, DOWNLOADS);
      yield* fs.makeDirectory(folder, { recursive: true });
      const name = yield* freeName(folder, plainName(event.name));
      if (Option.isNone(name)) return;
      yield* fs.writeFile(path.join(folder, name.value), bytes, { flag: "wx" });
      tell(botId, event.tab, BROWSER_NOTES.downloaded(`${DOWNLOADS}/${name.value}`));
    });

    // -----------------------------------------------------------------------
    // Hosts

    /** A tab its host opened by itself: a pop-up, or a tab the person opened in the app. */
    const adoptUnknown = Effect.fnUntraced(function* (
      hello: BrowserHostHello,
      page: BrowserPageState,
      opener: BrowserTabRef | null,
      isPrivate: boolean,
    ) {
      const at = yield* now;
      const openedBy: BrowserTabOpener =
        opener !== null
          ? { kind: "page", tab: opener }
          : hello.host.kind === "desktop"
            ? { kind: "person", device: hello.host.device }
            : { kind: "page", tab: page.tab };
      const openerTab = opener === null ? undefined : tabs.get(opener);
      const tab = yield* makeTab({
        ref: page.tab,
        openedBy,
        private: isPrivate,
        createdAt: at,
        usedAt: at,
        url: page.url,
        title: page.title,
        where: whereOfHello(hello),
        // The bots on its opener are on a pop-up, as on a sign-in's.
        onIt: openerTab === undefined ? [] : onItOf(openerTab, at),
      });
      learnPage(tab, page);
      // A pop-up becomes the current tab of the bots whose current tab opened it.
      if (opener !== null) {
        for (const [botId, ref] of current) if (ref === opener) current.set(botId, tab.ref);
      }
      yield* persist(tab);
      yield* bump;
    });

    const onHostEvent = (entry: Host) =>
      Effect.fnUntraced(function* (event: BrowserHostEvent) {
        const { key, hello } = entry;
        const own = (ref: BrowserTabRef) => {
          const tab = tabs.get(ref);
          return tab !== undefined && keyOfWhere(tab.where) === key ? tab : undefined;
        };
        switch (event.type) {
          case "tab.opened": {
            const known = tabs.get(event.page.tab);
            if (known === undefined)
              return yield* adoptUnknown(hello, event.page, event.opener, event.private);
            learnPage(known, event.page);
            yield* moveTo(known, whereOfHello(hello));
            return yield* bump;
          }
          case "tab.changed": {
            const tab = own(event.page.tab);
            if (tab === undefined) return;
            const moved = tab.url !== event.page.url || tab.title !== event.page.title;
            learnPage(tab, event.page);
            if (moved) yield* persist(tab);
            return yield* bump;
          }
          case "tab.closed": {
            const tab = own(event.tab);
            if (tab === undefined) return;
            // A tab that crashed is parked, so the bots on it can open it again.
            return yield* event.crashed ? park(tab) : forget(tab);
          }
          case "tab.focused": {
            const at = yield* now;
            entry.focused = event.tab;
            entry.focusedAt = at;
            entry.activeAt = at;
            return yield* bump;
          }
          case "person.input": {
            const tab = own(event.tab);
            const at = yield* now;
            entry.activeAt = at;
            if (tab === undefined || hello.host.kind !== "desktop") return;
            tab.usedAt = at;
            // Applied in the app already, also while another device holds
            // the tab: then it changes no hands.
            yield* tab.control.personInput(hello.host.device);
            return;
          }
          case "pointer": {
            const tab = own(event.tab);
            if (tab === undefined) return;
            const state = yield* tab.control.state;
            return yield* PubSub.publish(pointers, {
              tab: event.tab,
              botId: state.acting,
              action: event.action,
              x: event.x,
              y: event.y,
            });
          }
          case "download.finished":
            // Aside, so a slow transfer holds up none of the host's other events.
            return yield* keepDownload(entry, event).pipe(
              Effect.catchCause((cause) => Effect.logWarning("A download was not kept", cause)),
              Effect.forkIn(serviceScope),
              Effect.asVoid,
            );
          case "cookies.changed":
          case "storage.changed":
            // The shared sign-ins read these.
            return;
        }
      });

    /** The host is gone: the server's tabs are parked now, a desktop's after its grace. */
    const detach = Effect.fnUntraced(function* (entry: Host) {
      if (hosts.get(entry.key) !== entry) return;
      hosts.delete(entry.key);
      if (entry.key === SERVER) {
        for (const tab of tabs.values()) if (keyOfWhere(tab.where) === SERVER) yield* park(tab);
        return yield* bump;
      }
      const fiber = yield* Effect.sleep(DESKTOP_GRACE).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            graces.delete(entry.key);
            if (hosts.has(entry.key)) return;
            for (const tab of tabs.values())
              if (keyOfWhere(tab.where) === entry.key) yield* park(tab);
          }),
        ),
        Effect.forkIn(serviceScope),
      );
      graces.set(entry.key, fiber);
      yield* bump;
    });

    const closeServerBrowser = Effect.suspend(() => {
      const running = server;
      if (running === null) return Effect.void;
      server = null;
      return Scope.close(running, Exit.void);
    });

    const attach = Effect.fn("Browser.attachHost")(function* (host: PageHost) {
      const hello = yield* host.hello;
      const key = keyOfHello(hello);
      const at = yield* now;
      const grace = graces.get(key);
      if (grace !== undefined) {
        graces.delete(key);
        yield* Fiber.interrupt(grace);
      }
      const entry: Host = { key, host, hello, activeAt: at, focused: null, focusedAt: 0 };
      hosts.set(key, entry);
      // The host's tabs, matched with the registry. One that runs on another
      // live host since is closed here, so a tab runs in one place.
      const held = [
        ...hello.tabs.map((page) => ({ page, isPrivate: false })),
        ...(hello.privateTabs ?? []).map((page) => ({ page, isPrivate: true })),
      ];
      for (const { page, isPrivate } of held) {
        const known = tabs.get(page.tab);
        if (known === undefined) {
          yield* adoptUnknown(hello, page, null, isPrivate);
          continue;
        }
        const elsewhere = keyOfWhere(known.where);
        if (elsewhere !== null && elsewhere !== key && hosts.has(elsewhere)) {
          yield* host.close(page.tab).pipe(Effect.ignore);
          continue;
        }
        learnPage(known, page);
        yield* moveTo(known, whereOfHello(hello));
      }
      // Tabs that waited for this desktop and that it no longer holds are parked.
      for (const tab of tabs.values())
        if (keyOfWhere(tab.where) === key && !held.some(({ page }) => page.tab === tab.ref))
          yield* park(tab);
      yield* bump;
      const ended = yield* Deferred.make<void>();
      yield* host.events.pipe(
        Stream.runForEach(onHostEvent(entry)),
        Effect.catchCause((cause) => Effect.logWarning("A browser host's events ended", cause)),
        Effect.ensuring(Deferred.succeed(ended, undefined)),
        // A host whose events end is gone. The server's own is closed too,
        // from outside the scope this runs in.
        Effect.andThen(
          key === SERVER
            ? Effect.asVoid(
                Effect.forkIn(serverLock.withPermits(1)(closeServerBrowser), serviceScope),
              )
            : detach(entry),
        ),
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() => detach(entry));
      return { hello, ended: Deferred.await(ended) };
    });

    /** The server's browser, started if it is not running. */
    const serverHost = serverLock.withPermits(1)(
      Effect.gen(function* () {
        const running = hosts.get(SERVER);
        if (running !== undefined) return running;
        const scope = yield* Scope.make();
        serverUsedAt = yield* now;
        yield* serverBrowser.launch.pipe(
          Effect.mapError((cause): ServerBrowserProblem => cause.reason),
          Effect.flatMap((launched) =>
            attach(launched).pipe(Effect.mapError((): ServerBrowserProblem => "failed")),
          ),
          Scope.provide(scope),
          Effect.tapError((problem) => SubscriptionRef.set(serverProblem, Option.some(problem))),
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        );
        yield* SubscriptionRef.set(serverProblem, Option.none());
        server = scope;
        const host = hosts.get(SERVER);
        if (host === undefined) return yield* Effect.fail<ServerBrowserProblem>("failed");
        return host;
      }),
    );

    // -----------------------------------------------------------------------
    // Placement

    /** Parks the least used server tab nobody acts on, holds or watches, once the cap is reached. */
    const makeRoomOnServer = Effect.gen(function* () {
      const host = hosts.get(SERVER);
      if (host === undefined) return;
      const live = [...tabs.values()].filter((tab) => tab.where.kind === "server");
      if (live.length < SERVER_TAB_CAP) return;
      const idle: Array<Tab> = [];
      for (const tab of live) {
        const state = yield* tab.control.state;
        if (state.acting === null && state.holder === null && tab.viewers === 0) idle.push(tab);
      }
      idle.sort((left, right) => left.usedAt - right.usedAt);
      const oldest = idle[0];
      if (oldest === undefined) return;
      // Parked first, so the host's word that the tab closed is not taken for a close.
      yield* park(oldest);
      yield* host.host.close(oldest.ref).pipe(Effect.ignore);
    });

    /** Where a new tab opens: the desktop the person used last, else the server. */
    const placement = Effect.gen(function* () {
      const desktops = [...hosts.values()].filter((host) => host.key !== SERVER);
      desktops.sort((left, right) => right.activeAt - left.activeAt);
      const desktop = desktops[0];
      if (desktop !== undefined) return desktop;
      yield* makeRoomOnServer;
      return yield* serverHost;
    }).pipe(Effect.mapError((problem) => refusal(BROWSER_NOTES.unavailable(problem))));

    const hostFailed = (error: BrowserHostError) => refusal(error.message);

    /**
     * The host `tab` runs on, opening it again where tabs open now when it
     * has none. A tab opened again keeps its ref and its last address.
     */
    const liveHost = Effect.fnUntraced(function* (tab: Tab) {
      const running = hostOf(tab);
      if (running !== undefined) return running;
      const target = yield* placement;
      const page = yield* target.host
        .open({
          tab: tab.ref,
          ...(tab.url.length === 0 ? {} : { url: tab.url }),
          background: true,
          private: false,
        })
        .pipe(Effect.mapError(hostFailed));
      learnPage(tab, page);
      yield* moveTo(tab, whereOfHello(target.hello));
      tab.reopened++;
      yield* bump;
      return target;
    });

    // -----------------------------------------------------------------------
    // The tools

    /** The bot uses `tab`: it is its current tab, the bot is on it, and it was used now. */
    const using = Effect.fnUntraced(function* (botId: BotId, tab: Tab) {
      const at = yield* now;
      const isNew = !tab.bots.has(botId);
      tab.bots.set(botId, at);
      tab.usedAt = at;
      if (tab.where.kind === "server") serverUsedAt = at;
      current.set(botId, tab.ref);
      if (isNew) yield* persist(tab);
      yield* bump;
    });

    /**
     * What changed `tab` since the bot last used it that it did not cause, in
     * one line, and the note that it sees the tab as it is now.
     */
    const noticeFor = Effect.fnUntraced(function* (botId: BotId, tab: Tab) {
      const key = seenKey(botId, tab.ref);
      const before = seen.get(key);
      seen.set(key, { actions: tab.actionCount, reopened: tab.reopened });
      const lines = pending.get(key) ?? [];
      pending.delete(key);
      const state = yield* tab.control.state;
      if (state.holder?.kind === "person") lines.push(BROWSER_NOTES.personUsing);
      if (before !== undefined && tab.reopened > before.reopened)
        lines.push(BROWSER_NOTES.reopened);
      if (before !== undefined) {
        const other = [...tab.actions]
          .reverse()
          .find((action) => action.n > before.actions && action.by !== botId);
        if (other !== undefined) lines.push(BROWSER_NOTES.actedSince(yield* nameOf(other.by)));
      }
      return lines.length === 0 ? Option.none<string>() : Option.some(lines.join(" "));
    });

    /** The bot saw the tab as its own action left it. */
    const sawOwn = (botId: BotId, tab: Tab) => {
      seen.set(seenKey(botId, tab.ref), { actions: tab.actionCount, reopened: tab.reopened });
    };

    const withNotice = <A extends object>(value: A, notice: Option.Option<string>): Noticed<A> =>
      Option.match(notice, {
        onNone: () => value,
        onSome: (text) => ({ ...value, notice: text }),
      });

    /** The person's tab in front of them now: the latest focused tab of any desktop. */
    const lookingTab = (): Tab | undefined => {
      let best: Host | undefined;
      for (const host of hosts.values())
        if (host.focused !== null && (best === undefined || host.focusedAt > best.focusedAt))
          best = host;
      const ref = best?.focused ?? null;
      const tab = ref === null ? undefined : tabs.get(ref);
      return tab === undefined || tab.private ? undefined : tab;
    };

    /** The tab a call works on: the one it names, else the bot's current tab, else the person's. */
    const resolve = (botId: BotId, ref: BrowserTabRef | undefined) =>
      Effect.suspend(() => {
        if (ref !== undefined) {
          const named = tabs.get(ref);
          return named === undefined || named.private
            ? Effect.fail(refusal(BROWSER_NOTES.noTab(ref)))
            : Effect.succeed(named);
        }
        const mine = current.get(botId);
        const tab = (mine === undefined ? undefined : tabs.get(mine)) ?? lookingTab();
        return tab === undefined
          ? Effect.fail(refusal(BROWSER_NOTES.noCurrent))
          : Effect.succeed(tab);
      });

    const actRefused = Effect.fnUntraced(function* (refused: ActRefused) {
      switch (refused.reason) {
        case "person":
          return refusal(BROWSER_NOTES.personHolds);
        case "waiting":
          return refusal(BROWSER_NOTES.waitingForUser);
        case "bot":
          return refusal(
            BROWSER_NOTES.botHolds(
              refused.botId === undefined ? "Another bot" : yield* nameOf(refused.botId),
            ),
          );
        case "withdrawn":
          return refusal(BROWSER_NOTES.off);
        case "closed":
          return refusal(BROWSER_NOTES.closed);
      }
    });

    /** Runs `run` as `botId`'s action on `tab`, under its lease. */
    const underLease = <A>(
      tab: Tab,
      botId: BotId,
      run: Effect.Effect<A, BrowserHostError | BrowserToolRefused>,
    ): Effect.Effect<A, BrowserToolRefused> =>
      tab.control.act(botId, run).pipe(
        Effect.catchTags({
          ActRefused: (refused) => Effect.flatMap(actRefused(refused), Effect.fail),
          BrowserHostError: (error) => Effect.fail(hostFailed(error)),
        }),
      );

    /** Reads `tab`'s page with `run` on its host, opening it again first if it must. */
    const reading = Effect.fnUntraced(function* <A extends object>(
      botId: BotId,
      ref: BrowserTabRef | undefined,
      run: (host: PageHost, tab: Tab) => Effect.Effect<A, BrowserHostError>,
    ) {
      const tab = yield* resolve(botId, ref);
      const host = yield* liveHost(tab);
      const notice = yield* noticeFor(botId, tab);
      yield* using(botId, tab);
      const value = yield* run(host.host, tab).pipe(Effect.mapError(hostFailed));
      return withNotice(value, notice);
    });

    /** Runs `run` as the bot's action on the tab, under its lease. */
    const acting = Effect.fnUntraced(function* <A extends object>(
      botId: BotId,
      ref: BrowserTabRef | undefined,
      run: (host: Host, tab: Tab) => Effect.Effect<A, BrowserHostError | BrowserToolRefused>,
    ) {
      const tab = yield* resolve(botId, ref);
      const notice = yield* noticeFor(botId, tab);
      const value = yield* underLease(
        tab,
        botId,
        Effect.gen(function* () {
          const host = yield* liveHost(tab);
          yield* using(botId, tab);
          tab.actionCount++;
          tab.actions.push({ n: tab.actionCount, by: botId });
          if (tab.actions.length > ACTION_LOG) tab.actions.shift();
          sawOwn(botId, tab);
          return yield* run(host, tab);
        }),
      );
      return withNotice(value, notice);
    });

    /**
     * The files a bot names in its workspace, put on `host` for `tab`, as
     * paths that host reads. Each is read as an attachment is: inside the
     * workspace, a regular file, at most an attachment's size.
     */
    const uploadPaths = Effect.fnUntraced(function* (
      botId: BotId,
      host: Host,
      tab: Tab,
      given: ReadonlyArray<string>,
    ) {
      if (host.hello.capabilities.files !== true)
        return yield* refusal(BROWSER_NOTES.uploadUnsupported);
      const stored = yield* bots.find(botId);
      const root = Option.flatMap(stored, (found) => found.workspaceRoot);
      if (Option.isNone(root)) return yield* refusal(BROWSER_NOTES.workspaceNotReady);
      const paths: Array<string> = [];
      for (const file of given) {
        const read = yield* readWorkspaceFile(root.value, file, MAX_ATTACHMENT_SIZE);
        switch (read._tag) {
          case "missing":
          case "unreadable":
            return yield* refusal(BROWSER_NOTES.uploadMissing(file));
          case "outside":
            return yield* refusal(BROWSER_NOTES.uploadOutside(file));
          case "not-a-file":
            return yield* refusal(BROWSER_NOTES.uploadNotFile(file));
          case "too-large":
            return yield* refusal(
              BROWSER_NOTES.uploadTooLarge(file, MAX_ATTACHMENT_SIZE / 1024 / 1024),
            );
          case "read": {
            const put = yield* host.host
              .putFile({ tab: tab.ref, name: plainName(read.name), bytes: read.bytes })
              .pipe(Effect.mapError(hostFailed));
            paths.push(put.path);
          }
        }
      }
      return paths;
    });

    const toolTabOf = Effect.fnUntraced(function* (botId: BotId, tab: Tab, at: number) {
      const state = yield* tab.control.state;
      const computer =
        tab.where.kind === "desktop" ? yield* deviceName(tab.where.device) : Option.none();
      const holder = state.holder;
      const using =
        holder?.kind === "person"
          ? ("person" as const)
          : holder?.kind === "fill"
            ? ("server" as const)
            : state.acting !== null
              ? yield* botName(state.acting)
              : holder?.kind === "bot"
                ? yield* botName(holder.botId)
                : ("nobody" as const);
      return {
        tab: tab.ref,
        url: tab.url,
        title: tab.title,
        loading: tab.loading,
        where: tab.where.kind === "desktop" ? "app" : tab.where.kind,
        ...(Option.isSome(computer) ? { computer: computer.value } : {}),
        looking: lookingTab() === tab,
        current: current.get(botId) === tab.ref,
        openedBy:
          tab.openedBy.kind === "bot"
            ? yield* botName(tab.openedBy.botId)
            : tab.openedBy.kind === "person"
              ? ("person" as const)
              : ("page" as const),
        onIt: yield* Effect.forEach(onItOf(tab, at), botName),
        using,
        dialog: tab.dialog,
      } satisfies BrowserToolTab;
    });

    /**
     * Opens a new tab on `target`, registered first so it is listed while it
     * loads, and forgotten if the host cannot open it. A bot's tab opens
     * under the bot's lease.
     */
    const openTab = Effect.fnUntraced(function* (input: {
      readonly ref?: BrowserTabRef;
      readonly openedBy: BrowserTabOpener;
      readonly target: Host;
      readonly url: string | undefined;
      readonly background: boolean;
      readonly readiness?: BrowserToolInput<"browser_open">["readiness"];
      readonly timeoutMs?: number | undefined;
    }) {
      const ref = input.ref ?? BrowserTabRef.make(yield* ids.make("tab"));
      const at = yield* now;
      const bot = input.openedBy.kind === "bot" ? input.openedBy.botId : null;
      const tab = yield* makeTab({
        ref,
        openedBy: input.openedBy,
        private: false,
        createdAt: at,
        usedAt: at,
        url: input.url ?? "",
        title: "",
        where: whereOfHello(input.target.hello),
        onIt: bot === null ? [] : [bot],
      });
      yield* persist(tab);
      yield* bump;
      const open = input.target.host.open({
        tab: ref,
        ...(input.url === undefined ? {} : { url: input.url }),
        background: input.background,
        private: false,
        ...(input.readiness === undefined ? {} : { readiness: input.readiness }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });
      const page = yield* (
        bot === null ? open.pipe(Effect.mapError(hostFailed)) : underLease(tab, bot, open)
      ).pipe(Effect.tapError(() => forget(tab)));
      learnPage(tab, page);
      yield* persist(tab);
      yield* bump;
      return { tab, page };
    });

    const tools: BrowserTools = {
      tabs: Effect.fn("Browser.tools.tabs")(function* (botId: BotId) {
        const at = yield* now;
        const listed = [...tabs.values()].filter((tab) => !tab.private);
        return yield* Effect.forEach(listed, (tab) => toolTabOf(botId, tab, at));
      }),
      open: Effect.fn("Browser.tools.open")(function* (
        botId: BotId,
        input: BrowserToolInput<"browser_open">,
      ) {
        const target = yield* placement;
        const { tab, page } = yield* openTab({
          openedBy: { kind: "bot", botId },
          target,
          url: input.url,
          background: input.background ?? false,
          readiness: input.readiness,
          timeoutMs: input.timeoutMs,
        });
        yield* using(botId, tab);
        sawOwn(botId, tab);
        return page;
      }),
      navigate: (botId, input) =>
        acting(botId, input.tab, (host, tab) =>
          host.host
            .navigate({
              tab: tab.ref,
              to:
                input.url !== undefined
                  ? { kind: "url", url: input.url }
                  : { kind: input.go ?? "reload" },
              ...(input.readiness === undefined ? {} : { readiness: input.readiness }),
              ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            })
            .pipe(Effect.tap((page) => Effect.sync(() => learnPage(tab, page)))),
        ),
      snapshot: (botId, input) =>
        reading(botId, input.tab, (host, tab) =>
          host.snapshot({ tab: tab.ref, includeImage: input.includeImage ?? false }),
        ),
      act: (botId, ref, action) =>
        acting(botId, ref, (host, tab) =>
          action.action === "upload"
            ? uploadPaths(botId, host, tab, action.paths).pipe(
                Effect.flatMap((paths) =>
                  host.host.act({ tab: tab.ref, action: { ...action, paths } }),
                ),
              )
            : host.host.act({ tab: tab.ref, action }),
        ),
      evaluate: (botId, input) =>
        acting(botId, input.tab, (host, tab) =>
          host.host.evaluate({
            tab: tab.ref,
            expression: input.expression,
            awaitPromise: input.awaitPromise ?? true,
          }),
        ),
      waitFor: (botId, input) =>
        reading(botId, input.tab, (host, tab) =>
          host
            .waitFor({
              tab: tab.ref,
              condition: {
                ...(input.locator === undefined ? {} : { locator: input.locator }),
                ...(input.text === undefined ? {} : { text: input.text }),
                ...(input.urlIncludes === undefined ? {} : { urlIncludes: input.urlIncludes }),
                ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
              },
            })
            .pipe(Effect.as({})),
        ),
      dialog: (botId, input) =>
        acting(botId, input.tab, (host, tab) =>
          host.host
            .dialog({
              tab: tab.ref,
              accept: input.accept,
              ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
            })
            .pipe(
              Effect.andThen(
                Effect.sync(() => {
                  tab.dialog = null;
                  return pageOf(tab);
                }),
              ),
            ),
        ),
      close: Effect.fn("Browser.tools.close")(function* (
        botId: BotId,
        input: BrowserToolInput<"browser_close">,
      ) {
        const tab = yield* resolve(botId, input.tab);
        const notice = yield* noticeFor(botId, tab);
        yield* underLease(
          tab,
          botId,
          Effect.suspend(() => {
            const host = hostOf(tab);
            return host === undefined ? Effect.void : host.host.close(tab.ref);
          }),
        );
        yield* forget(tab);
        return withNotice({}, notice);
      }),
    };

    // -----------------------------------------------------------------------
    // Clients

    const sharedOf = Effect.fnUntraced(function* (tab: Tab, at: number) {
      const state = yield* tab.control.state;
      return {
        ref: tab.ref,
        url: tab.url,
        title: tab.title,
        loading: tab.loading,
        where: tab.where,
        openedBy: tab.openedBy,
        onIt: onItOf(tab, at),
        acting: state.acting,
        heldBy: state.holder,
        dialog: tab.dialog,
        private: tab.private,
      } satisfies SharedBrowserTab;
    });

    /** Equal frames go out once: the list changes for reasons a frame does not show. */
    const sameFrame = <A>(left: A, right: A) => JSON.stringify(left) === JSON.stringify(right);

    const all: Stream.Stream<SharedBrowserTabs> = SubscriptionRef.changes(version).pipe(
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          const at = yield* now;
          return { tabs: yield* Effect.forEach([...tabs.values()], (tab) => sharedOf(tab, at)) };
        }),
      ),
      Stream.changesWith(sameFrame),
    );

    const ofBot = (botId: BotId, device: DeviceId): Stream.Stream<BrowserTabs, NotFound> =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (Option.isNone(yield* bots.find(botId)))
            return yield* new NotFound({ resource: "bot" });
          return SubscriptionRef.changes(version).pipe(
            Stream.mapEffect(() =>
              Effect.gen(function* () {
                const at = yield* now;
                const mine = [...tabs.values()].filter(
                  (tab) =>
                    !tab.private &&
                    (onItOf(tab, at).includes(botId) ||
                      (tab.openedBy.kind === "bot" && tab.openedBy.botId === botId) ||
                      current.get(botId) === tab.ref),
                );
                const listed = yield* Effect.forEach(mine, (tab) =>
                  Effect.map(sharedOf(tab, at), (shared): BrowserTab => {
                    const holder = shared.heldBy;
                    return {
                      ref: tab.ref,
                      botId,
                      url: tab.url,
                      title: tab.title,
                      loading: tab.loading,
                      controller:
                        holder?.kind === "person"
                          ? holder.device === device
                            ? "you"
                            : "another-device"
                          : "bot",
                      front: current.get(botId) === tab.ref,
                      where: shared.where,
                      openedBy: shared.openedBy,
                      onIt: shared.onIt,
                      acting: shared.acting,
                      heldBy: shared.heldBy,
                    };
                  }),
                );
                return { tabs: listed } satisfies BrowserTabs;
              }),
            ),
            Stream.changesWith(sameFrame),
          );
        }),
      );

    const openForPerson = Effect.fn("Browser.openForPerson")(function* (input: {
      readonly device: DeviceId;
      readonly ref: BrowserTabRef;
      readonly url?: string | undefined;
    }) {
      if (tabs.has(input.ref)) return;
      const own = hosts.get(desktopKey(input.device));
      const target = own ?? (yield* placement);
      yield* openTab({
        ref: input.ref,
        openedBy: { kind: "person", device: input.device },
        target,
        url: input.url,
        background: false,
      });
    });

    const closeTab = Effect.fn("Browser.close")(function* (ref: BrowserTabRef) {
      const tab = tabs.get(ref);
      if (tab === undefined) return yield* new NotFound({ resource: "browser-tab" });
      const host = hostOf(tab);
      if (host !== undefined) yield* host.host.close(ref).pipe(Effect.ignore);
      yield* forget(tab);
    });

    const watch = Effect.fn("Browser.watch")(function* (ref: BrowserTabRef) {
      const tab = tabs.get(ref);
      if (tab === undefined) return Option.none<WatchedTab>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          tab.viewers++;
        }),
        () =>
          Effect.sync(() => {
            tab.viewers--;
          }),
      );
      return Option.some({
        ref,
        host: SubscriptionRef.changes(tab.hostChanges).pipe(
          Stream.map(() => Option.fromUndefinedOr(hostOf(tab)?.host)),
        ),
        tab: SubscriptionRef.changes(version).pipe(
          Stream.takeWhile(() => tabs.get(ref) === tab),
          Stream.mapEffect(() => Effect.flatMap(now, (at) => sharedOf(tab, at))),
          Stream.changesWith(sameFrame),
        ),
        control: tab.control,
        closed: SubscriptionRef.changes(version).pipe(
          Stream.filter(() => tabs.get(ref) !== tab),
          Stream.runHead,
          Effect.asVoid,
        ),
      } satisfies WatchedTab);
    });

    const personUsed = Effect.fn("Browser.personUsed")(function* (
      ref: BrowserTabRef,
      device: DeviceId,
    ) {
      const tab = tabs.get(ref);
      if (tab === undefined) return false;
      if (!(yield* tab.control.personInput(device))) return false;
      const at = yield* now;
      tab.usedAt = at;
      const desktop = hosts.get(desktopKey(device));
      if (desktop !== undefined) desktop.activeAt = at;
      return true;
    });

    const withdraw = Effect.fn("Browser.withdraw")(function* (botId: BotId) {
      for (const tab of tabs.values()) {
        yield* tab.control.withdraw(botId);
        if (tab.bots.delete(botId)) yield* persist(tab);
      }
      current.delete(botId);
      yield* bump;
    });

    const toolTab = (botId: BotId, ref: BrowserTabRef | undefined) =>
      resolve(botId, ref).pipe(
        Effect.flatMap((tab) => Effect.flatMap(now, (at) => sharedOf(tab, at))),
        Effect.option,
      );

    const handsOf = (ref: BrowserTabRef) =>
      Effect.sync((): Option.Option<TabHands> => {
        const tab = tabs.get(ref);
        if (tab === undefined) return Option.none();
        return Option.some({
          control: tab.control,
          host: Option.fromUndefinedOr(hostOf(tab)?.host),
          page: pageOf(tab),
        });
      });

    // -----------------------------------------------------------------------
    // Start: the stored tabs, all parked until a browser holds them.

    for (const stored of yield* store.load) {
      yield* makeTab({
        ref: stored.ref,
        openedBy: stored.openedBy,
        private: false,
        createdAt: stored.createdAt,
        usedAt: stored.usedAt,
        url: stored.url,
        title: stored.title,
        where: { kind: "parked" },
        onIt: stored.onIt,
      });
    }

    // Parks server tabs nobody used for a while, closes tabs no person
    // opened that went unused for a day, and closes the server's browser
    // once it has had no tab for a sweep.
    const sweep = Effect.gen(function* () {
      const at = yield* now;
      for (const tab of tabs.values()) {
        const state = yield* tab.control.state;
        if (state.acting !== null || state.holder !== null || tab.viewers > 0) continue;
        const host = hostOf(tab);
        if (
          tab.openedBy.kind !== "person" &&
          at - tab.usedAt >= Duration.toMillis(UNUSED_TAB_LIFE)
        ) {
          if (host !== undefined) yield* host.host.close(tab.ref).pipe(Effect.ignore);
          yield* forget(tab);
          continue;
        }
        if (tab.where.kind === "server" && at - tab.usedAt >= Duration.toMillis(SERVER_TAB_IDLE)) {
          // Parked first, so the host's word that the tab closed is not taken for a close.
          yield* park(tab);
          if (host !== undefined) yield* host.host.close(tab.ref).pipe(Effect.ignore);
        }
      }
      const serverIdle =
        [...tabs.values()].every((tab) => tab.where.kind !== "server") &&
        at - serverUsedAt >= Duration.toMillis(SWEEP_EVERY);
      if (server !== null && serverIdle) yield* serverLock.withPermits(1)(closeServerBrowser);
    });
    yield* sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("The browser's sweep failed", cause)),
      Effect.andThen(Effect.sleep(SWEEP_EVERY)),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => serverLock.withPermits(1)(closeServerBrowser));

    return Browser.of({
      all,
      ofBot,
      openForPerson,
      close: closeTab,
      watch,
      pointers: Stream.fromPubSub(pointers),
      personUsed,
      withdraw,
      attachHost: attach,
      serverProblem: SubscriptionRef.changes(serverProblem),
      toolTab,
      handsOf,
      tools,
    });
  }),
);

/** What the login fill and browser help need of the tabs (`TabAccess`), from the Browser service. */
export const tabAccessLayer = Layer.effect(
  TabAccess,
  Effect.gen(function* () {
    const browser = yield* Browser;

    const holdForFill = Effect.fn("TabAccess.holdForFill")(function* (ref: BrowserTabRef) {
      const found = yield* browser.handsOf(ref);
      if (Option.isNone(found) || Option.isNone(found.value.host))
        return yield* new FillHoldRefused({ reason: "no-tab" });
      const { control } = found.value;
      const host = found.value.host.value;
      const held = yield* Deferred.make<void>();
      // The fill holds the tab until this scope closes, which interrupts it.
      const holding = yield* control
        .fill(() => Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkScoped);
      const refused = yield* Effect.raceFirst(
        Deferred.await(held).pipe(Effect.as(Option.none<FillHoldRefused>())),
        Fiber.join(holding).pipe(
          Effect.as(Option.some(new FillHoldRefused({ reason: "unavailable" }))),
          Effect.catchTag("FillRefused", (cause) =>
            Effect.succeedSome(
              new FillHoldRefused({ reason: cause.reason === "person" ? "held" : "no-tab" }),
            ),
          ),
        ),
      ).pipe(
        Effect.timeoutOption(QUEUE_WAIT),
        Effect.map(
          Option.getOrElse(() => Option.some(new FillHoldRefused({ reason: "unavailable" }))),
        ),
      );
      if (Option.isSome(refused)) {
        yield* Fiber.interrupt(holding);
        return yield* refused.value;
      }
      const after = yield* browser.handsOf(ref);
      return {
        host,
        page: Option.match(after, { onNone: () => found.value.page, onSome: (it) => it.page }),
        preempted: Effect.map(control.state, (state) => state.holder?.kind !== "fill"),
      };
    });

    const endPersonHold = Effect.fn("TabAccess.endPersonHold")(function* (ref: BrowserTabRef) {
      const found = yield* browser.handsOf(ref);
      if (Option.isNone(found)) return;
      const state = yield* found.value.control.state;
      if (state.holder?.kind === "person")
        yield* found.value.control.release(state.holder.device, false);
    });

    return TabAccess.of({
      toolTab: browser.toolTab,
      holdForFill,
      present: browser.all.pipe(
        Stream.map(({ tabs }): ReadonlySet<BrowserTabRef> => new Set(tabs.map((tab) => tab.ref))),
      ),
      personHolds: browser.all.pipe(
        Stream.map(({ tabs }) =>
          tabs.flatMap((tab) =>
            tab.heldBy?.kind === "person" ? [{ tab: tab.ref, onIt: tab.onIt }] : [],
          ),
        ),
      ),
      endPersonHold,
    });
  }),
);
