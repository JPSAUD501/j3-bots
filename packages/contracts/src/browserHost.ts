// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { MAX_ATTACHMENT_NAME_LENGTH, MAX_ATTACHMENT_SIZE } from "./attachment.ts";
import { DeviceId, NonNegativeInt, PositiveInt } from "./base.ts";
import { BrowserPageInput, BrowserTabRef, MAX_BROWSER_VIEW } from "./browser.ts";
import {
  BrowserAction,
  BrowserActOutcome,
  BrowserAddress,
  BrowserEvaluation,
  BrowserImage,
  BrowserNavigation,
  BrowserPageSnapshot,
  BrowserPageState,
  BrowserReadiness,
  BrowserWaitCondition,
  MAX_BROWSER_EXPRESSION_LENGTH,
  MAX_BROWSER_TIMEOUT_MS,
  MAX_BROWSER_TYPE_LENGTH,
} from "./browserTools.ts";
import { FillField } from "./secrets.ts";

// The page host protocol (decision 0110): what the J3 Bots server asks of a
// browser that runs tabs for it, and what that browser tells the server.
// Two hosts speak it: the desktop app's own browser, over the desktop's
// connection, and the server's own browser, in the server's process. The
// server is the caller; the host answers. A host never speaks raw CDP to
// the server: one call is one piece of page work, run beside the page.
//
// Tab refs are the server's (`BrowserTabRef`). A tab a host opens by itself,
// as a pop-up or the person's new tab, gets a ref the host mints, with at
// least 128 bits of randomness, and the server keeps it.

/** Bumped when a change would break a host and a server built a version apart. */
export const BROWSER_HOST_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Sign-ins: cookies and site storage

/**
 * SameSite as Chromium keeps it. `unspecified` is a cookie set without the
 * attribute, which Chromium treats as `lax` with exceptions of its own; it
 * must stay `unspecified` when it moves between hosts.
 */
export const BrowserCookieSameSite = Schema.Literals([
  "unspecified",
  "no_restriction",
  "lax",
  "strict",
]);
export type BrowserCookieSameSite = typeof BrowserCookieSameSite.Type;

/** The site a partitioned (CHIPS) cookie belongs under. */
export const BrowserCookiePartition = Schema.Struct({
  topLevelSite: Schema.String,
  hasCrossSiteAncestor: Schema.Boolean,
});
export type BrowserCookiePartition = typeof BrowserCookiePartition.Type;

/**
 * One cookie, in the shape every host can read and write without loss.
 * `domain` never has a leading dot: `hostOnly` says whether the cookie is
 * sent to that host alone or to its subdomains too.
 */
export const BrowserCookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.String.check(Schema.isMinLength(1)),
  hostOnly: Schema.Boolean,
  path: Schema.String.check(Schema.isStartingWith("/")),
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  sameSite: BrowserCookieSameSite,
  /**
   * When it expires, in Unix seconds. Absent for a session cookie, which
   * J3 Bots keeps until the site removes it: a host that restarts is no
   * reason to sign out.
   */
  expires: Schema.optionalKey(Schema.Finite),
  partition: Schema.optionalKey(BrowserCookiePartition),
});
export type BrowserCookie = typeof BrowserCookie.Type;

/** What names a cookie: setting one with the same key replaces it. */
export const BrowserCookieKey = Schema.Struct({
  name: Schema.String,
  domain: Schema.String.check(Schema.isMinLength(1)),
  hostOnly: Schema.Boolean,
  path: Schema.String,
  /**
   * The partition, whole, for a partitioned cookie: Chromium keeps one cookie
   * apart from another of the same name under the same top-level site when
   * their `hasCrossSiteAncestor` differs.
   */
  partition: Schema.optionalKey(BrowserCookiePartition),
});
export type BrowserCookieKey = typeof BrowserCookieKey.Type;

/** Cookies set and removed, in one batch. */
export const BrowserCookieChanges = Schema.Struct({
  set: Schema.Array(BrowserCookie),
  removed: Schema.Array(BrowserCookieKey),
});
export type BrowserCookieChanges = typeof BrowserCookieChanges.Type;

/**
 * One IndexedDB database, in the shape Playwright's `storageState` reads
 * and writes. A record's `keyEncoded` and `valueEncoded` are Playwright's
 * own encoding of values JSON cannot hold, such as dates and binary data,
 * passed through untouched.
 */
export const BrowserIndexedDb = Schema.Struct({
  name: Schema.String,
  version: Schema.Int,
  stores: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      autoIncrement: Schema.Boolean,
      keyPath: Schema.optionalKey(Schema.String),
      keyPathArray: Schema.optionalKey(Schema.Array(Schema.String)),
      records: Schema.Array(
        Schema.Struct({
          key: Schema.optionalKey(Schema.Json),
          keyEncoded: Schema.optionalKey(Schema.Json),
          value: Schema.optionalKey(Schema.Json),
          valueEncoded: Schema.optionalKey(Schema.Json),
        }),
      ),
      indexes: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          keyPath: Schema.optionalKey(Schema.String),
          keyPathArray: Schema.optionalKey(Schema.Array(Schema.String)),
          multiEntry: Schema.Boolean,
          unique: Schema.Boolean,
        }),
      ),
    }),
  ),
});
export type BrowserIndexedDb = typeof BrowserIndexedDb.Type;

/**
 * What one origin keeps besides cookies. `indexedDb` is present only when
 * it was asked for: absent means not read, never empty.
 */
export const BrowserOriginStorage = Schema.Struct({
  /** `scheme://host[:port]`. */
  origin: Schema.String.check(Schema.isMinLength(1)),
  localStorage: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  indexedDb: Schema.optionalKey(Schema.Array(BrowserIndexedDb)),
});
export type BrowserOriginStorage = typeof BrowserOriginStorage.Type;

// ---------------------------------------------------------------------------
// Typing a saved login

/**
 * What a saved login's value goes into, by the field it fills:
 *
 * - `username`: an `<input>` of type text, email or tel;
 * - `password`: an `<input>` of type password;
 * - `totp`: an `<input>` of type text, tel, number or password.
 *
 * The field must have the focus in the page's top frame (through open shadow
 * roots), be shown, and take input. Anything else, a text area, an editable
 * element, a search box or a field in an embedded frame, is refused.
 */
export const BrowserFillField = FillField;
export type BrowserFillField = typeof BrowserFillField.Type;

/**
 * How `tab.fill` went.
 *
 * - `typed`: the value went into the focused field. `submitted` when Enter
 *   was pressed after it; `cleared` when a password the page kept after it
 *   was taken out of the field again.
 * - `refused`: nothing was typed. `field`: the focus is not on a field that
 *   takes this value in the top frame. `navigated`: the page is not at the
 *   address the server checked. `loading`: the page has not finished loading.
 */
export const BrowserFillResult = Schema.Union([
  Schema.TaggedStruct("typed", { submitted: Schema.Boolean, cleared: Schema.Boolean }),
  Schema.TaggedStruct("refused", {
    reason: Schema.Literals(["field", "navigated", "loading"]),
  }),
]);
export type BrowserFillResult = typeof BrowserFillResult.Type;

/** The longest value `tab.fill` types: a login's password at most. */
export const MAX_BROWSER_FILL_LENGTH = 10_000;

// ---------------------------------------------------------------------------
// The host

/**
 * What a host can do. A flag a host does not send is a thing it cannot do,
 * so a newer host's flags pass an older server by.
 *
 * - `screencast`, `input`: a viewer can watch and drive its tabs.
 * - `cookies`, `storage`, `indexedDb`: it reads and writes sign-ins.
 * - `files`: it hands the server a file a bot's action downloaded
 *   (`download.finished`, `download.take`) and takes files for a bot's
 *   upload (`files.put`).
 * - `changeEvents`: it sends `cookies.changed` and `storage.changed` itself,
 *   as its sites change them. The server reads a host without it again
 *   after its pages load and while it has tabs open.
 * - `privateTabs`: the person can open a private tab on it.
 * - `nativeView`: the person sees its tabs in a view of its own, in the
 *   app, and uses them there (`person.input`, `tab.focused`).
 */
export const BrowserHostCapabilities = Schema.Struct({
  screencast: Schema.optionalKey(Schema.Literal(true)),
  input: Schema.optionalKey(Schema.Literal(true)),
  cookies: Schema.optionalKey(Schema.Literal(true)),
  storage: Schema.optionalKey(Schema.Literal(true)),
  indexedDb: Schema.optionalKey(Schema.Literal(true)),
  files: Schema.optionalKey(Schema.Literal(true)),
  changeEvents: Schema.optionalKey(Schema.Literal(true)),
  privateTabs: Schema.optionalKey(Schema.Literal(true)),
  nativeView: Schema.optionalKey(Schema.Literal(true)),
});
export type BrowserHostCapabilities = typeof BrowserHostCapabilities.Type;

/** What the server learns of a host before it sends it any tab. */
export const BrowserHostHello = Schema.Struct({
  protocol: PositiveInt,
  /** `desktop` for the app's own browser, with its device; `server` for the server's. */
  host: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("desktop"), device: DeviceId }),
    Schema.Struct({ kind: Schema.Literal("server") }),
  ]),
  platform: Schema.Struct({
    os: Schema.Literals(["linux", "darwin", "win32"]),
    arch: Schema.Literals(["x64", "arm64"]),
  }),
  /**
   * The browser as sites see it: always Chrome, of the host's own version,
   * on the host's own system.
   */
  browser: Schema.Struct({
    /** Chromium's full version, such as `158.0.8127.88`. */
    version: Schema.String,
    userAgent: Schema.String,
  }),
  capabilities: BrowserHostCapabilities,
  /**
   * Names the store the host keeps its shared sign-ins in: a random id the
   * host mints when the store is created empty, keeps beside it, and mints
   * again whenever the store is emptied. The server takes a cookie missing
   * from a host as one the host removed only against what it last knew of
   * this same store; a host without one is always taken as new, and nothing
   * it lacks is removed from the others.
   */
  cookieStore: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(200)),
  ),
  /**
   * Names this run of the host's browser: a random id the host mints each
   * time its browser starts. A session cookie the store held and the host
   * lacks is taken as lost to a restart only when the run is another than
   * the one the server last agreed with, or is not named; under the same
   * run, a missing cookie is one the site removed.
   */
  browserRun: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(200)),
  ),
  /**
   * The tabs the host holds now: after a reconnect, the server matches them
   * with its registry. A private tab is not among them.
   */
  tabs: Schema.Array(BrowserPageState),
  /**
   * The private tabs the host holds now, apart from `tabs`, so the server
   * keeps showing them to the person after a reconnect or its own restart.
   * No bot lists or reads them. Left out, the host holds none.
   */
  privateTabs: Schema.optionalKey(Schema.Array(BrowserPageState)),
});
export type BrowserHostHello = typeof BrowserHostHello.Type;

/**
 * Why a host refused or could not finish a call. `detail` is the host's
 * own short account, for the bot to read; it never holds a value from a
 * password field.
 *
 * - `no-tab`: the host has no such tab.
 * - `stale-ref`: the ref is from an earlier snapshot, or the page changed
 *   since it was taken.
 * - `invalid-target`: the locator matches nothing it can act on, or more
 *   than one element.
 * - `not-editable`: the target does not take text, or is not a `<select>`.
 * - `timeout`: the step did not finish in time. It may have happened.
 * - `too-large`: the result is over the limit.
 * - `page`: the page or its script failed, as `detail` says.
 * - `refused`: the host will not do it: an address of another scheme, or a
 *   file it may not read.
 * - `unsupported`: the host cannot do this (see its capabilities).
 * - `closed`: the tab or the host closed during the call.
 */
export class BrowserHostError extends Schema.TaggedError<BrowserHostError>()("BrowserHostError", {
  reason: Schema.Literals([
    "no-tab",
    "stale-ref",
    "invalid-target",
    "not-editable",
    "timeout",
    "too-large",
    "page",
    "refused",
    "unsupported",
    "closed",
  ]),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
}) {
  override get message(): string {
    const lead = BROWSER_HOST_ERROR_TEXT[this.reason];
    return this.detail === undefined ? lead : `${lead} ${this.detail}`;
  }
}

const BROWSER_HOST_ERROR_TEXT: Record<BrowserHostError["reason"], string> = {
  "no-tab": "That tab is not open.",
  "stale-ref": "The page changed since that ref was taken. Take a new snapshot and use its refs.",
  "invalid-target": "Nothing on the page matches that target.",
  "not-editable": "That element does not take this input.",
  timeout:
    "The step did not finish in time; it may have happened. Look at the page before trying again.",
  "too-large": "The result is too large.",
  page: "The page failed.",
  refused: "The browser will not do that.",
  unsupported: "This browser cannot do that.",
  closed: "The tab closed.",
};

/** A download a host keeps for the server, by an id the host mints. */
export const BrowserDownloadId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
).pipe(Schema.brand("BrowserDownloadId"));
export type BrowserDownloadId = typeof BrowserDownloadId.Type;

/** A file's name, as a host saves it: no folder in it. */
export const BrowserFileName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ATTACHMENT_NAME_LENGTH),
  Schema.makeFilter(
    (name: string) =>
      (!/[\\/\u0000]/.test(name) && name !== "." && name !== "..") || "a name without a folder",
  ),
);

/** A file's bytes as they cross the connection: at most an attachment's size. */
const FileBytes = Schema.Uint8ArrayFromBase64.check(
  Schema.makeFilter(
    (bytes: Uint8Array) => bytes.length <= MAX_ATTACHMENT_SIZE || "at most an attachment's size",
  ),
);

/** How many bytes of a download one message carries, well under a socket message's limit. */
export const BROWSER_DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

/** A piece of a download's bytes, as it crosses the connection. */
const FileChunk = Schema.Uint8ArrayFromBase64.check(
  Schema.makeFilter(
    (bytes: Uint8Array) =>
      (bytes.length > 0 && bytes.length <= BROWSER_DOWNLOAD_CHUNK_BYTES) || "one chunk",
  ),
);

/**
 * What a host tells the server without being asked, in order.
 *
 * - `tab.opened`: a tab the host opened by itself: a pop-up a page opened
 *   (`opener`), or a new tab the person opened in the app.
 * - `tab.changed`: a tab's page, title, loading or dialog changed.
 * - `tab.closed`: a tab closed: by the person, by its page, or because it
 *   crashed (`crashed`).
 * - `tab.focused`: the tab the person has in front of them in this host's
 *   app, or null when none is.
 * - `person.input`: the person used a tab's page in this host's own view.
 *   Moving the pointer, scrolling the view, finding in the page and zooming
 *   are not sent.
 * - `pointer`: where an action points while it runs, for the acting bot's
 *   cursor.
 * - `cookies.changed`: cookies the host's pages or sites changed. Never the
 *   host's own writes from `cookies.write`, and never a private tab's.
 * - `storage.changed`: origins whose storage may have changed, to read.
 * - `download.started`: a download began on the tab. The server decides
 *   then whose it is, so a bot that acts on the tab later never takes it.
 *   A desktop reports only one that began while a bot's action ran there:
 *   what the person downloads stays with them and is not reported at all.
 * - `download.finished`: a download the host reported started is
 *   complete, under the same id. The host keeps it until the server takes
 *   it (`download.take`) or the host restarts.
 */
export const BrowserHostEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tab.opened"),
    page: BrowserPageState,
    opener: Schema.NullOr(BrowserTabRef),
    private: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("tab.changed"), page: BrowserPageState }),
  Schema.Struct({
    type: Schema.Literal("tab.closed"),
    tab: BrowserTabRef,
    crashed: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("tab.focused"), tab: Schema.NullOr(BrowserTabRef) }),
  Schema.Struct({ type: Schema.Literal("person.input"), tab: BrowserTabRef }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    tab: BrowserTabRef,
    action: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  Schema.Struct({ type: Schema.Literal("cookies.changed"), changes: BrowserCookieChanges }),
  Schema.Struct({
    type: Schema.Literal("storage.changed"),
    origins: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("download.started"),
    tab: BrowserTabRef,
    download: BrowserDownloadId,
  }),
  Schema.Struct({
    type: Schema.Literal("download.finished"),
    tab: BrowserTabRef,
    download: BrowserDownloadId,
    /** The name the site gave it. */
    name: BrowserFileName,
    size: NonNegativeInt,
  }),
]);
export type BrowserHostEvent = typeof BrowserHostEvent.Type;

/**
 * One picture of a tab while it is watched. The host sends the next only
 * after `tab.screencastAck` for this one, and keeps only the newest picture
 * waiting meanwhile.
 */
export const BrowserScreencastFrame = Schema.Struct({
  frame: NonNegativeInt,
  jpeg: Schema.Uint8ArrayFromBase64,
  /** The page's size in CSS pixels: the space input coordinates are in. */
  viewport: Schema.Struct({ width: NonNegativeInt, height: NonNegativeInt }),
});
export type BrowserScreencastFrame = typeof BrowserScreencastFrame.Type;

const tab = { tab: BrowserTabRef };
const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_BROWSER_TIMEOUT_MS }));

/**
 * The calls the server makes on a page host. Each fails only with a
 * `BrowserHostError`; a call that names a tab the host does not have fails
 * with `no-tab`.
 */
export const BrowserHostRpcs = RpcGroup.make(
  /** Who the host is. Asked first, and again after every reconnect. */
  Rpc.make("host.hello", { success: BrowserHostHello, error: BrowserHostError }),
  /** The host's events, from the call on, until the connection ends. */
  Rpc.make("host.events", { success: BrowserHostEvent, error: BrowserHostError, stream: true }),
  /**
   * Opens a tab under the server's ref, at `url` or blank. A private tab
   * keeps its own cookies and storage, apart from the shared sign-ins, and
   * forgets them when it closes.
   */
  Rpc.make("tab.open", {
    payload: {
      ...tab,
      url: Schema.optionalKey(BrowserAddress),
      background: Schema.Boolean,
      private: Schema.Boolean,
      readiness: Schema.optionalKey(BrowserReadiness),
      timeoutMs: Schema.optionalKey(Timeout),
    },
    success: BrowserPageState,
    error: BrowserHostError,
  }),
  /** Closes a tab. A tab that is already gone closes without error. */
  Rpc.make("tab.close", { payload: tab, error: BrowserHostError }),
  Rpc.make("tab.navigate", {
    payload: {
      ...tab,
      to: BrowserNavigation,
      readiness: Schema.optionalKey(BrowserReadiness),
      timeoutMs: Schema.optionalKey(Timeout),
    },
    success: BrowserPageState,
    error: BrowserHostError,
  }),
  /**
   * Reads the page with its refs. A ref holds until the page's document
   * changes: a later snapshot of the same document keeps it.
   */
  Rpc.make("tab.snapshot", {
    payload: { ...tab, includeImage: Schema.Boolean },
    success: BrowserPageSnapshot,
    error: BrowserHostError,
  }),
  Rpc.make("tab.act", {
    payload: { ...tab, action: BrowserAction },
    success: BrowserActOutcome,
    error: BrowserHostError,
  }),
  Rpc.make("tab.evaluate", {
    payload: {
      ...tab,
      expression: Schema.String.check(Schema.isMaxLength(MAX_BROWSER_EXPRESSION_LENGTH)),
      awaitPromise: Schema.Boolean,
      timeoutMs: Schema.optionalKey(Timeout),
    },
    success: BrowserEvaluation,
    error: BrowserHostError,
  }),
  Rpc.make("tab.waitFor", {
    payload: { ...tab, condition: BrowserWaitCondition },
    error: BrowserHostError,
  }),
  /** Answers the dialog the page waits on; `invalid-target` when none waits. */
  Rpc.make("tab.dialog", {
    payload: {
      ...tab,
      accept: Schema.Boolean,
      promptText: Schema.optionalKey(
        Schema.String.check(Schema.isMaxLength(MAX_BROWSER_TYPE_LENGTH)),
      ),
    },
    error: BrowserHostError,
  }),
  Rpc.make("tab.screenshot", {
    payload: {
      ...tab,
      format: Schema.Literals(["png", "jpeg"]),
      quality: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    },
    success: BrowserImage,
    error: BrowserHostError,
  }),
  /**
   * Pictures of the tab while the call runs, at most `maxWidth` by
   * `maxHeight` device pixels. One screencast runs per tab: a second call
   * while one runs is refused, and the server shares the one among its
   * viewers. A hidden tab keeps painting while it is watched.
   */
  Rpc.make("tab.screencast", {
    payload: {
      ...tab,
      maxWidth: Schema.Int.check(
        Schema.isBetween({ minimum: 64, maximum: MAX_BROWSER_VIEW.width }),
      ),
      maxHeight: Schema.Int.check(
        Schema.isBetween({ minimum: 64, maximum: MAX_BROWSER_VIEW.height }),
      ),
      quality: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    },
    success: BrowserScreencastFrame,
    error: BrowserHostError,
    stream: true,
  }),
  Rpc.make("tab.screencastAck", {
    payload: { ...tab, frame: NonNegativeInt },
    error: BrowserHostError,
  }),
  /** A person's input to the page, through a viewer. */
  Rpc.make("tab.input", {
    payload: { ...tab, input: BrowserPageInput },
    error: BrowserHostError,
  }),
  /**
   * Types a saved login's value into the field that has the focus, checked
   * beside the page right before it types: the page is at `url`, loaded, and
   * the focused element in its top frame fits `field`. With `submit`, Enter
   * follows; after a password it always does, and a password the page keeps
   * on screen afterwards is taken out of the field again. The value is never
   * logged, returned or kept. A host that shows the tab in a window of its
   * own holds the person's input there until the fill ends, so no key of
   * theirs lands in the field among the value's.
   */
  Rpc.make("tab.fill", {
    payload: {
      ...tab,
      field: BrowserFillField,
      value: Schema.Redacted(Schema.String).check(
        Schema.makeFilter(
          (value: Redacted.Redacted<string>) => {
            const length = Redacted.value(value).length;
            return length >= 1 && length <= MAX_BROWSER_FILL_LENGTH;
          },
          { expected: `a value of 1 to ${MAX_BROWSER_FILL_LENGTH} characters` },
        ),
      ),
      url: BrowserAddress,
      submit: Schema.Boolean,
    },
    success: BrowserFillResult,
    error: BrowserHostError,
  }),
  /** Whether a tap at the point lands in a field that takes text. */
  Rpc.make("tab.probe", {
    payload: { ...tab, x: Schema.Finite, y: Schema.Finite },
    success: Schema.Struct({ editable: Schema.Boolean }),
    error: BrowserHostError,
  }),
  /**
   * A file for a bot's upload. The host keeps it until the tab closes and
   * answers the path to give `upload` in `tab.act`.
   */
  Rpc.make("files.put", {
    payload: { ...tab, name: BrowserFileName, bytes: FileBytes },
    success: Schema.Struct({ path: Schema.String }),
    error: BrowserHostError,
  }),
  /**
   * The bytes of a download `download.finished` reported, in order, in
   * chunks of at most `BROWSER_DOWNLOAD_CHUNK_BYTES`, so no message passes
   * the server's limit on what a socket sends it. The host lets the file go
   * once it answers: a download already taken, or never reported, fails as
   * `invalid-target`.
   */
  Rpc.make("download.take", {
    payload: { download: BrowserDownloadId },
    success: FileChunk,
    error: BrowserHostError,
    stream: true,
  }),
  /** Every cookie the shared sign-ins hold on this host. */
  Rpc.make("cookies.read", {
    success: Schema.Struct({ cookies: Schema.Array(BrowserCookie) }),
    error: BrowserHostError,
  }),
  /** Sets and removes cookies. The host reports none of it back as `cookies.changed`. */
  Rpc.make("cookies.write", {
    payload: { changes: BrowserCookieChanges },
    error: BrowserHostError,
  }),
  /**
   * Reads origins' storage; `indexedDb` adds their databases. An origin whose
   * databases hold a value `BrowserIndexedDb` cannot carry (a `CryptoKey`, a
   * `Blob`) comes back without `indexedDb`: not read, rather than read wrong.
   */
  Rpc.make("storage.read", {
    payload: { origins: Schema.Array(Schema.String), indexedDb: Schema.Boolean },
    success: Schema.Struct({ origins: Schema.Array(BrowserOriginStorage) }),
    error: BrowserHostError,
  }),
  /** Replaces each given origin's `localStorage`, and its databases where given. */
  Rpc.make("storage.write", {
    payload: { origins: Schema.Array(BrowserOriginStorage) },
    error: BrowserHostError,
  }),
  /**
   * Deletes what the shared sign-ins' store keeps for these origins, or for
   * every origin, besides cookies: `localStorage`, IndexedDB, cache storage,
   * service workers and the rest of their site data. Each open tab of them
   * loses its `sessionStorage` too, and a tab whose page is of one of them
   * loads again, so no page keeps a sign-in in its memory. For signing out:
   * a host with `storage` takes it. The host reports none of it back.
   */
  Rpc.make("storage.clear", {
    payload: {
      clear: Schema.Union([
        Schema.Struct({ origins: Schema.Array(Schema.String) }),
        Schema.Struct({ all: Schema.Literal(true) }),
      ]),
    },
    error: BrowserHostError,
  }),
);
