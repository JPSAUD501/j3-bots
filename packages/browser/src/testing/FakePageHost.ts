// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BROWSER_HOST_PROTOCOL_VERSION,
  type BrowserCookie,
  type BrowserCookieChanges,
  type BrowserCookieKey,
  BrowserDownloadId,
  type BrowserFillField,
  type BrowserFillResult,
  BrowserHostError,
  type BrowserHostEvent,
  type BrowserHostHello,
  type BrowserOriginStorage,
  type BrowserPageState,
  type BrowserTabRef,
} from "@j3-bots/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { addressOf } from "../driver/address.ts";
import type { PageHost, PageHostPayload } from "../PageHost.ts";

/**
 * What a fake tab shows. `tree` is the page as a snapshot reads it, with
 * refs as the browser gives them (`[ref=e1]`); the fake rewrites them per
 * snapshot as a real host does.
 */
export interface FakePage {
  readonly title: string;
  readonly tree: string;
  /**
   * What has the focus on the page, for `tab.fill`: a field that a login's
   * user name, password or one-time code fits, or something no value fits,
   * as a field inside an embedded frame. Nothing, when absent.
   */
  readonly focus?: BrowserFillField | "other";
}

/** A value `tab.fill` typed, as the fake host took it. */
export interface FakeFill {
  readonly tab: BrowserTabRef;
  readonly field: BrowserFillField;
  readonly value: Redacted.Redacted<string>;
  readonly submitted: boolean;
}

/** A call the fake host was asked, by its name in the protocol. */
export interface FakeHostCall {
  readonly call: string;
  readonly tab?: BrowserTabRef;
  /** For `tab.screencast`: the size and quality asked for. */
  readonly size?: {
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly quality: number;
  };
}

/**
 * A page host in memory, for tests of what drives one. It keeps tabs,
 * cookies and storage, gives refs per snapshot and refuses a stale one as a
 * real host does, and lets a test act as the host's person or pages.
 */
export interface FakePageHost extends PageHost {
  /** Every call asked of the host so far, in order. */
  readonly calls: Effect.Effect<ReadonlyArray<FakeHostCall>>;
  /** The tabs the host holds now, private ones included. */
  readonly tabs: Effect.Effect<ReadonlyArray<BrowserPageState>>;
  /** Tells whoever listens to `events` what the host would. */
  readonly emit: (event: BrowserHostEvent) => Effect.Effect<void>;
  /** What a page at `url` shows when a tab goes there. */
  readonly serve: (url: string, page: FakePage) => Effect.Effect<void>;
  /**
   * A picture of the tab, to its watcher. As a real host does, it sends the
   * next only after the last is acknowledged, keeping the newest meanwhile.
   */
  readonly paint: (tab: BrowserTabRef) => Effect.Effect<void>;
  /**
   * The host's sites change its cookies: the fake keeps the change and, as
   * a host with `changeEvents` does, reports it as `cookies.changed`.
   */
  readonly siteCookies: (changes: BrowserCookieChanges) => Effect.Effect<void>;
  /** A site's page writes its origin's storage, reported as `storage.changed` with `changeEvents`. */
  readonly siteStorage: (origin: BrowserOriginStorage) => Effect.Effect<void>;
  /** The cookies the host holds now. */
  readonly cookies: Effect.Effect<ReadonlyArray<BrowserCookie>>;
  /** What the host keeps of each origin now. */
  readonly storage: Effect.Effect<ReadonlyArray<BrowserOriginStorage>>;
  /**
   * The host restarts its browser: session cookies are gone, as a browser
   * without "continue where you left off" drops them, and nothing reports it.
   */
  readonly restart: Effect.Effect<void>;
  /** The host empties its store, under the new id `cookieStore`, as a desktop does when revoked. */
  readonly emptyStore: (cookieStore: string | undefined) => Effect.Effect<void>;
  /** Every value `tab.fill` typed, in order. */
  readonly fills: Effect.Effect<ReadonlyArray<FakeFill>>;
  /** The frames acknowledged so far, by tab. */
  readonly acked: Effect.Effect<
    ReadonlyArray<{ readonly tab: BrowserTabRef; readonly frame: number }>
  >;
  /** A file a bot's action downloaded on the tab: kept, and reported as started, then finished. */
  readonly download: (
    tab: BrowserTabRef,
    name: string,
    bytes: Uint8Array,
  ) => Effect.Effect<BrowserDownloadId>;
  /** A download that starts on the tab now, and finishes, kept, once `finish` runs. */
  readonly startDownload: (
    tab: BrowserTabRef,
    name: string,
    bytes: Uint8Array,
  ) => Effect.Effect<{
    readonly download: BrowserDownloadId;
    readonly finish: Effect.Effect<void>;
  }>;
  /** The files given for uploads, by the path the host answered. */
  readonly files: Effect.Effect<ReadonlyMap<string, Uint8Array>>;
}

interface FakeTab {
  state: BrowserPageState;
  readonly private: boolean;
  /** How many documents the tab has shown: a ref holds within one. */
  generation: number;
  readonly refs: Set<string>;
}

interface Watcher {
  readonly queue: Queue.Queue<number, BrowserHostError | Cause.Done>;
  /** The frame out and not yet acknowledged, and the newest painted since. */
  out: number | undefined;
  next: number | undefined;
}

const BLANK: FakePage = { title: "", tree: "" };

const cookieKey = (
  cookie: Pick<BrowserCookieKey, "name" | "domain" | "hostOnly" | "path">,
  partition: string | undefined,
) => [cookie.name, cookie.domain, cookie.hostOnly, cookie.path, partition ?? ""].join("\u0000");

const NATIVE_REF = /\[ref=((?:f\d+)?e\d+)\]/g;

export const makeFakePageHost = (
  options: {
    readonly host?: BrowserHostHello["host"];
    readonly capabilities?: BrowserHostHello["capabilities"];
    readonly cookieStore?: string;
  } = {},
): Effect.Effect<FakePageHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<BrowserHostEvent>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(events));
    const tabs = new Map<BrowserTabRef, FakeTab>();
    const pages = new Map<string, FakePage>();
    const cookies = new Map<string, BrowserCookie>();
    const files = new Map<string, Uint8Array>();
    const downloads = new Map<BrowserDownloadId, Uint8Array>();
    const storage = new Map<string, BrowserOriginStorage>();
    const calls: Array<FakeHostCall> = [];
    const acked: Array<{ readonly tab: BrowserTabRef; readonly frame: number }> = [];
    const fills: Array<FakeFill> = [];
    let cookieStore = options.cookieStore;
    const capabilities = options.capabilities ?? {
      screencast: true,
      input: true,
      cookies: true,
      storage: true,
      files: true,
    };
    const watchers = new Map<BrowserTabRef, Watcher>();
    let frames = 0;

    const applyCookies = (changes: BrowserCookieChanges) => {
      for (const removed of changes.removed) cookies.delete(cookieKey(removed, removed.partition));
      for (const cookie of changes.set)
        cookies.set(cookieKey(cookie, cookie.partition?.topLevelSite), cookie);
    };

    const record = (call: string, tab?: BrowserTabRef) =>
      Effect.sync(() => {
        calls.push(tab === undefined ? { call } : { call, tab });
      });

    const find = (tab: BrowserTabRef) =>
      Effect.suspend(() => {
        const found = tabs.get(tab);
        return found === undefined
          ? Effect.fail(new BrowserHostError({ reason: "no-tab" }))
          : Effect.succeed(found);
      });

    /** Takes the tab to `url`, a new document; only web addresses open, as on a real host. */
    const go = (tab: FakeTab, url: string) =>
      Effect.suspend(() => {
        const address = addressOf(url);
        if (address === undefined)
          return Effect.fail(
            new BrowserHostError({
              reason: "refused",
              detail: "Only http and https addresses open.",
            }),
          );
        const page = pages.get(address) ?? BLANK;
        tab.state = {
          ...tab.state,
          url: address,
          title: page.title,
          loading: false,
          loadError: null,
          dialog: null,
        };
        tab.generation += 1;
        tab.refs.clear();
        return Effect.void;
      });

    const deliver = (watcher: Watcher, frame: number) => {
      watcher.out = frame;
      Queue.offerUnsafe(watcher.queue, frame);
    };

    const changed = (tab: FakeTab) =>
      tab.private ? Effect.void : PubSub.publish(events, { type: "tab.changed", page: tab.state });

    const onTab = <A>(
      call: string,
      tab: BrowserTabRef,
      run: (found: FakeTab) => Effect.Effect<A, BrowserHostError>,
    ) => record(call, tab).pipe(Effect.andThen(find(tab)), Effect.flatMap(run));

    const checkRefs = (found: FakeTab, targets: ReadonlyArray<string | undefined>) =>
      Effect.suspend(() => {
        for (const target of targets) {
          if (target === undefined || !/aria-ref/i.test(target)) continue;
          const ref = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(target)?.[1];
          if (ref === undefined)
            return Effect.fail(new BrowserHostError({ reason: "invalid-target" }));
          if (!found.refs.has(ref))
            return Effect.fail(new BrowserHostError({ reason: "stale-ref" }));
        }
        return Effect.void;
      });

    const privateTabs = () =>
      [...tabs.values()].filter((tab) => tab.private).map((tab) => tab.state);

    let downloadsStarted = 0;
    const startDownload: FakePageHost["startDownload"] = (tab, name, bytes) =>
      Effect.gen(function* () {
        downloadsStarted += 1;
        const id = BrowserDownloadId.make(`download-${downloadsStarted}`);
        yield* PubSub.publish(events, { type: "download.started", tab, download: id });
        const finish = Effect.suspend(() => {
          downloads.set(id, bytes);
          return PubSub.publish(events, {
            type: "download.finished",
            tab,
            download: id,
            name,
            size: bytes.length,
          });
        }).pipe(Effect.asVoid);
        return { download: id, finish };
      });
    const host: FakePageHost = {
      // Built at each call: the tabs and the store are the host's as they are now.
      hello: record("host.hello").pipe(
        Effect.map(() => ({
          protocol: BROWSER_HOST_PROTOCOL_VERSION,
          host: options.host ?? { kind: "server" },
          platform: { os: "linux", arch: "x64" },
          browser: { version: "1.0.0.0", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Fake" },
          capabilities,
          ...(cookieStore === undefined ? {} : { cookieStore }),
          tabs: [...tabs.values()].filter((tab) => !tab.private).map((tab) => tab.state),
          ...(privateTabs().length === 0 ? {} : { privateTabs: privateTabs() }),
        })),
      ),
      // Recorded once subscribed, so a test that waits for the call loses no event.
      events: Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(events);
          yield* record("host.events");
          return Stream.fromSubscription(subscription);
        }),
      ),
      open: (input) =>
        record("tab.open", input.tab).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const existing = tabs.get(input.tab);
              if (existing !== undefined) return Effect.succeed(existing.state);
              const tab: FakeTab = {
                state: {
                  tab: input.tab,
                  url: "",
                  title: "",
                  loading: false,
                  loadError: null,
                  dialog: null,
                },
                private: input.private,
                generation: 0,
                refs: new Set(),
              };
              return (input.url === undefined ? Effect.void : go(tab, input.url)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    tabs.set(input.tab, tab);
                    return tab.state;
                  }),
                ),
              );
            }),
          ),
        ),
      close: (tab) =>
        record("tab.close", tab).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const found = tabs.get(tab);
              if (found === undefined) return Effect.void;
              tabs.delete(tab);
              const watcher = watchers.get(tab);
              if (watcher !== undefined) Queue.endUnsafe(watcher.queue);
              watchers.delete(tab);
              return found.private
                ? Effect.void
                : PubSub.publish(events, { type: "tab.closed", tab, crashed: false });
            }),
          ),
        ),
      navigate: ({ tab, to }) =>
        onTab("tab.navigate", tab, (found) =>
          go(found, to.kind === "url" ? to.url : found.state.url).pipe(
            Effect.andThen(changed(found)),
            Effect.as(found.state),
          ),
        ),
      snapshot: ({ tab }) =>
        onTab("tab.snapshot", tab, (found) =>
          Effect.sync(() => {
            const tree = (pages.get(found.state.url) ?? BLANK).tree.replace(
              NATIVE_REF,
              (_match, native: string) => {
                const ref = `fake-${found.generation}-${native}`;
                found.refs.add(ref);
                return `[ref=${ref}]`;
              },
            );
            return { ...found.state, tree, truncated: false };
          }),
        ),
      act: ({ tab, action }) =>
        onTab("tab.act", tab, (found) =>
          checkRefs(
            found,
            action.action === "drag"
              ? [action.source, action.target]
              : "locator" in action
                ? [action.locator]
                : [],
          ).pipe(Effect.as({})),
        ),
      evaluate: ({ tab }) => onTab("tab.evaluate", tab, () => Effect.succeed({ value: null })),
      waitFor: ({ tab, condition }) =>
        onTab("tab.waitFor", tab, (found) => checkRefs(found, [condition.locator])),
      dialog: ({ tab }) =>
        onTab("tab.dialog", tab, (found) =>
          Effect.suspend(() => {
            if (found.state.dialog === null)
              return Effect.fail(
                new BrowserHostError({ reason: "invalid-target", detail: "No dialog is open." }),
              );
            found.state = { ...found.state, dialog: null };
            return changed(found);
          }),
        ),
      screenshot: ({ tab, format }) =>
        onTab("tab.screenshot", tab, () =>
          Effect.succeed({
            mimeType: format === "png" ? ("image/png" as const) : ("image/jpeg" as const),
            data: "",
            width: 1280,
            height: 800,
          }),
        ),
      screencast: ({ tab, maxWidth, maxHeight, quality }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* find(tab);
            return Stream.callback<number, BrowserHostError>((queue) =>
              Effect.acquireRelease(
                // Recorded once watching, so a test that waits for the call loses no picture.
                Effect.suspend(() => {
                  if (watchers.has(tab))
                    return Effect.fail(
                      new BrowserHostError({
                        reason: "refused",
                        detail: "This tab is already being watched; its one screencast is shared.",
                      }),
                    );
                  watchers.set(tab, { queue, out: undefined, next: undefined });
                  return Effect.sync(() => {
                    calls.push({
                      call: "tab.screencast",
                      tab,
                      size: { maxWidth, maxHeight, quality },
                    });
                  });
                }),
                () => Effect.sync(() => watchers.delete(tab)),
              ),
            ).pipe(
              Stream.map((frame) => ({
                frame,
                jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
                viewport: { width: 1280, height: 800 },
              })),
            );
          }),
        ),
      screencastAck: ({ tab, frame }) =>
        onTab("tab.screencastAck", tab, () =>
          Effect.sync(() => {
            acked.push({ tab, frame });
            const watcher = watchers.get(tab);
            if (watcher === undefined || watcher.out !== frame) return;
            const next = watcher.next;
            watcher.out = undefined;
            watcher.next = undefined;
            if (next !== undefined) deliver(watcher, next);
          }),
        ),
      input: ({ tab }) => onTab("tab.input", tab, () => Effect.void),
      probe: ({ tab }) => onTab("tab.probe", tab, () => Effect.succeed({ editable: false })),
      putFile: ({ tab, name, bytes }) =>
        onTab("files.put", tab, () =>
          Effect.sync(() => {
            const path = `/fake/files/${tab}/${files.size}/${name}`;
            files.set(path, bytes);
            return { path };
          }),
        ),
      takeDownload: ({ download }) =>
        record("download.take").pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const bytes = downloads.get(download);
              if (bytes === undefined) {
                return Effect.fail(new BrowserHostError({ reason: "invalid-target" }));
              }
              downloads.delete(download);
              return Effect.succeed({ bytes });
            }),
          ),
        ),
      fill: ({ tab, field, value, url, submit }) =>
        onTab("tab.fill", tab, (found) =>
          Effect.sync((): BrowserFillResult => {
            if (found.state.url !== url) return { _tag: "refused", reason: "navigated" };
            if (found.state.loading) return { _tag: "refused", reason: "loading" };
            if (pages.get(url)?.focus !== field) return { _tag: "refused", reason: "field" };
            const submitted = submit || field === "password";
            fills.push({ tab, field, value, submitted });
            return { _tag: "typed", submitted, cleared: false };
          }),
        ),
      readCookies: record("cookies.read").pipe(
        Effect.andThen(Effect.sync(() => ({ cookies: [...cookies.values()] }))),
      ),
      writeCookies: (changes) =>
        record("cookies.write").pipe(Effect.andThen(Effect.sync(() => applyCookies(changes)))),
      readStorage: (input: PageHostPayload<"storage.read">) =>
        record("storage.read").pipe(
          Effect.andThen(
            Effect.sync(() => ({
              origins: input.origins.flatMap((origin) => {
                const kept = storage.get(origin);
                if (kept === undefined) return [];
                if (input.indexedDb) return [kept];
                const { indexedDb: _indexedDb, ...rest } = kept;
                return [rest];
              }),
            })),
          ),
        ),
      writeStorage: (origins) =>
        record("storage.write").pipe(
          Effect.andThen(
            Effect.sync(() => {
              for (const origin of origins) {
                const kept = storage.get(origin.origin);
                storage.set(origin.origin, {
                  ...origin,
                  ...(origin.indexedDb === undefined && kept?.indexedDb !== undefined
                    ? { indexedDb: kept.indexedDb }
                    : {}),
                });
              }
            }),
          ),
        ),
      calls: Effect.sync(() => [...calls]),
      tabs: Effect.sync(() => [...tabs.values()].map((tab) => tab.state)),
      emit: (event) => PubSub.publish(events, event).pipe(Effect.asVoid),
      serve: (url, page) =>
        Effect.sync(() => {
          pages.set(url, page);
        }),
      paint: (tab) =>
        Effect.sync(() => {
          frames += 1;
          const watcher = watchers.get(tab);
          if (watcher === undefined) return;
          if (watcher.out === undefined) deliver(watcher, frames);
          else watcher.next = frames;
        }),
      siteCookies: (changes) =>
        Effect.suspend(() => {
          applyCookies(changes);
          return capabilities.changeEvents === true
            ? PubSub.publish(events, { type: "cookies.changed", changes }).pipe(Effect.asVoid)
            : Effect.void;
        }),
      siteStorage: (origin) =>
        Effect.suspend(() => {
          storage.set(origin.origin, origin);
          return capabilities.changeEvents === true
            ? PubSub.publish(events, { type: "storage.changed", origins: [origin.origin] }).pipe(
                Effect.asVoid,
              )
            : Effect.void;
        }),
      cookies: Effect.sync(() => [...cookies.values()]),
      storage: Effect.sync(() => [...storage.values()]),
      restart: Effect.sync(() => {
        for (const [key, cookie] of cookies) if (cookie.expires === undefined) cookies.delete(key);
      }),
      emptyStore: (next) =>
        Effect.sync(() => {
          cookies.clear();
          storage.clear();
          cookieStore = next;
        }),
      fills: Effect.sync(() => [...fills]),
      acked: Effect.sync(() => [...acked]),
      startDownload,
      download: (tab, name, bytes) =>
        Effect.gen(function* () {
          const started = yield* startDownload(tab, name, bytes);
          yield* started.finish;
          return started.download;
        }),
      files: Effect.sync(() => new Map(files)),
    };
    return host;
  });
