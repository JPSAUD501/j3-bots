// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- the X protocol on the display's own socket, which no service of Effect's speaks.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

// The little of the X protocol (X Window System Protocol, version 11) the app
// speaks itself, on the display's socket: Electron exposes neither whether a
// compositing manager runs (compositing.ts) nor which window is in front and
// what it is called (lookingAt/x11.ts). A connection sends requests one after
// another and takes their replies in order: every request sent here has one.

/** An X display on this computer: its number, and the screen windows open on. */
export interface XDisplay {
  readonly number: string;
  readonly screen: number;
}

/**
 * The display `DISPLAY` names when it is on this computer (`:0`, `:1.0`,
 * `unix:0`); `null` for one on another host, which is not asked, or for
 * anything else.
 */
export const parseDisplay = (display: string | undefined): XDisplay | null => {
  const match = /^(?:unix)?:(\d+)(?:\.(\d+))?$/.exec(display ?? "");
  if (match === null) return null;
  return { number: match[1] ?? "0", screen: Number(match[2] ?? "0") };
};

const COOKIE = "MIT-MAGIC-COOKIE-1";
/** An authority entry's families that fit a display on this computer: this host's own, and any. */
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;

/**
 * The cookie an authority file (`~/.Xauthority`) keeps for display `number`
 * on this computer, or `null`: the entry for this host or for any, before one
 * for another name this host went by. An entry is four counted strings after
 * its family, every count two bytes, most significant first.
 */
export const cookieFor = (
  authority: Uint8Array,
  number: string,
  hostname: string,
): Uint8Array | null => {
  const view = new DataView(authority.buffer, authority.byteOffset, authority.byteLength);
  const text = new TextDecoder("latin1");
  let at = 0;
  const counted = (): Uint8Array | null => {
    if (at + 2 > authority.length) return null;
    const length = view.getUint16(at);
    const end = at + 2 + length;
    if (end > authority.length) return null;
    const bytes = authority.subarray(at + 2, end);
    at = end;
    return bytes;
  };
  let other: Uint8Array | null = null;
  while (at + 2 <= authority.length) {
    const family = view.getUint16(at);
    at += 2;
    const address = counted();
    const display = counted();
    const name = counted();
    const data = counted();
    if (address === null || display === null || name === null || data === null) break;
    if (text.decode(name) !== COOKIE) continue;
    const shown = text.decode(display);
    if (shown !== "" && shown !== number) continue;
    if (family === FAMILY_WILD || (family === FAMILY_LOCAL && text.decode(address) === hostname)) {
      return data;
    }
    if (family === FAMILY_LOCAL) other ??= data;
  }
  return other;
};

const padded = (length: number) => (4 - (length % 4)) % 4;

/** The connection setup: little-endian, protocol 11.0, with the cookie when there is one. */
const setupRequest = (cookie: Uint8Array | null): Uint8Array => {
  const name = cookie === null ? new Uint8Array() : new TextEncoder().encode(COOKIE);
  const data = cookie ?? new Uint8Array();
  const request = new Uint8Array(
    12 + name.length + padded(name.length) + data.length + padded(data.length),
  );
  const view = new DataView(request.buffer);
  request[0] = 0x6c;
  view.setUint16(2, 11, true);
  view.setUint16(6, name.length, true);
  view.setUint16(8, data.length, true);
  request.set(name, 12);
  request.set(data, 12 + name.length + padded(name.length));
  return request;
};

/** A request of `units` four-byte units with `opcode`, its data byte, and its body written by `write`. */
const request = (
  opcode: number,
  data: number,
  units: number,
  write: (view: DataView) => void = () => {},
): Uint8Array => {
  const bytes = new Uint8Array(units * 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = opcode;
  bytes[1] = data;
  view.setUint16(2, units, true);
  write(view);
  return bytes;
};

/** InternAtom; with `onlyIfExists`, an atom nobody made answers 0. */
export const internAtom = (atom: string, onlyIfExists: boolean): Uint8Array => {
  const name = new TextEncoder().encode(atom);
  const bytes = request(
    16,
    onlyIfExists ? 1 : 0,
    (8 + name.length + padded(name.length)) / 4,
    (view) => view.setUint16(4, name.length, true),
  );
  bytes.set(name, 8);
  return bytes;
};

export const getSelectionOwner = (atom: number): Uint8Array =>
  request(23, 0, 2, (view) => view.setUint32(4, atom, true));

/** GetProperty of `type` (0: any), up to `units` four-byte units of its value. */
export const getProperty = (
  window: number,
  property: number,
  type: number,
  units: number,
): Uint8Array =>
  request(20, 0, 6, (view) => {
    view.setUint32(4, window, true);
    view.setUint32(8, property, true);
    view.setUint32(12, type, true);
    view.setUint32(16, 0, true);
    view.setUint32(20, units, true);
  });

export const getGeometry = (drawable: number): Uint8Array =>
  request(14, 0, 2, (view) => view.setUint32(4, drawable, true));

export const getWindowAttributes = (window: number): Uint8Array =>
  request(3, 0, 2, (view) => view.setUint32(4, window, true));

/** GetImage of the whole of a `width` by `height` drawable, as a ZPixmap of every plane. */
export const getImage = (drawable: number, width: number, height: number): Uint8Array =>
  request(73, 2, 5, (view) => {
    view.setUint32(4, drawable, true);
    view.setInt16(8, 0, true);
    view.setInt16(10, 0, true);
    view.setUint16(12, width, true);
    view.setUint16(14, height, true);
    view.setUint32(16, 0xffffffff, true);
  });

/** Where an atom, a window or another four-byte value stands in a reply. */
export const VALUE_AT = 8;

/** A reply: its bytes, header first, as the server sent them. */
export type Reply = Uint8Array;

export const readUint8 = (reply: Reply, at: number): number => reply[at] ?? 0;
export const readUint16 = (reply: Reply, at: number): number =>
  new DataView(reply.buffer, reply.byteOffset, reply.byteLength).getUint16(at, true);
export const readUint32 = (reply: Reply, at: number): number =>
  new DataView(reply.buffer, reply.byteOffset, reply.byteLength).getUint32(at, true);

/** A property's value, as GetProperty answers it: its type, its format (8, 16 or 32) and its bytes. */
export interface Property {
  readonly type: number;
  readonly format: number;
  readonly value: Uint8Array;
}

/** The property a GetProperty reply holds; `null` when the window has none of the type asked. */
export const propertyOf = (reply: Reply): Property | null => {
  const format = readUint8(reply, 1);
  const type = readUint32(reply, 8);
  if (type === 0 || format === 0) return null;
  const length = readUint32(reply, 16) * (format / 8);
  return { type, format, value: reply.subarray(32, 32 + length) };
};

/** A visual of a screen: how its pixels hold red, green and blue. */
interface XVisual {
  readonly id: number;
  readonly depth: number;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/** What the connection's setup tells of the server that the app reads. */
export interface XSetup {
  /** The order of the bytes of a pixel in an image the server answers with. */
  readonly imageByteOrder: "lsb" | "msb";
  /** Bits per pixel of an image, by depth. */
  readonly bitsPerPixel: ReadonlyMap<number, number>;
  readonly screens: ReadonlyArray<{
    readonly root: number;
    readonly visuals: ReadonlyArray<XVisual>;
  }>;
}

/**
 * The server's setup, from its accepted reply: `null` when the reply is cut
 * short or holds what this reading does not know.
 */
export const parseSetup = (reply: Uint8Array): XSetup | null => {
  if (reply.length < 40 || readUint8(reply, 0) !== 1) return null;
  const vendor = readUint16(reply, 24);
  const screenCount = readUint8(reply, 28);
  const formatCount = readUint8(reply, 29);
  const imageByteOrder = readUint8(reply, 30) === 0 ? "lsb" : "msb";
  let at = 40 + vendor + padded(vendor);
  const bitsPerPixel = new Map<number, number>();
  for (let index = 0; index < formatCount; index += 1) {
    if (at + 8 > reply.length) return null;
    bitsPerPixel.set(readUint8(reply, at), readUint8(reply, at + 1));
    at += 8;
  }
  const screens: Array<XSetup["screens"][number]> = [];
  for (let index = 0; index < screenCount; index += 1) {
    if (at + 40 > reply.length) return null;
    const root = readUint32(reply, at);
    const depthCount = readUint8(reply, at + 39);
    at += 40;
    const visuals: Array<XVisual> = [];
    for (let depthIndex = 0; depthIndex < depthCount; depthIndex += 1) {
      if (at + 8 > reply.length) return null;
      const depth = readUint8(reply, at);
      const visualCount = readUint16(reply, at + 2);
      at += 8;
      for (let visualIndex = 0; visualIndex < visualCount; visualIndex += 1) {
        if (at + 24 > reply.length) return null;
        visuals.push({
          id: readUint32(reply, at),
          depth,
          red: readUint32(reply, at + 8),
          green: readUint32(reply, at + 12),
          blue: readUint32(reply, at + 16),
        });
        at += 24;
      }
    }
    screens.push({ root, visuals });
  }
  return { imageByteOrder, bitsPerPixel, screens };
};

/** A connection to an X server, open for as long as its scope. */
export interface XConnection {
  /** The server's accepted setup reply, whole. */
  readonly setup: Uint8Array;
  /**
   * Sends `request` and answers its reply; `null` when the server answered
   * with an error, or the connection ended or went quiet first.
   */
  readonly ask: (request: Uint8Array) => Effect.Effect<Reply | null>;
}

/** What waits on the server: the setup's reply first, then each request's in turn. */
type Waiting = (reply: Reply | null) => void;

/**
 * A connection to the X server listening at `path`, with `cookie` when there
 * is one; `null` when the server refused it or did not answer within
 * `timeoutMs`. Each request then has `timeoutMs` of quiet before the
 * connection is given up. Closed with its scope.
 */
export const connectX = (options: {
  readonly path: string;
  readonly cookie: Uint8Array | null;
  readonly timeoutMs: number;
}): Effect.Effect<XConnection | null, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const socket = NodeNet.connect({ path: options.path });
      let received = Buffer.alloc(0);
      let ended = false;
      const waiting: Array<Waiting> = [];
      let setupLength: number | null = null;
      const end = () => {
        if (ended) return;
        ended = true;
        socket.destroy();
        for (const resume of waiting.splice(0)) resume(null);
      };
      socket.setTimeout(options.timeoutMs, end);
      socket.on("error", end);
      socket.on("close", end);
      socket.on("connect", () => socket.write(setupRequest(options.cookie)));
      // Chunks wait apart until the reply they belong to is whole, and are
      // joined once: a window's picture is megabytes in 64 KB chunks.
      const arriving: Array<Buffer> = [];
      let arrivingBytes = 0;
      let needed = 8;
      socket.on("data", (chunk: Buffer) => {
        arriving.push(chunk);
        arrivingBytes += chunk.length;
        if (received.length + arrivingBytes < needed) return;
        received = Buffer.concat([received, ...arriving.splice(0)]);
        arrivingBytes = 0;
        // Short of `bytes`: the next chunk is joined only once they are there.
        const short = (bytes: number) => {
          needed = bytes;
        };
        // A reply handed on may end the connection, which leaves the rest unread.
        for (;;) {
          if (ended) return;
          if (setupLength === null) {
            if (received.length < 8) return short(8);
            // Success is 1; a refusal (0) and a second round of authentication (2) are not.
            if (received.readUInt8(0) !== 1) return end();
            setupLength = 8 + received.readUInt16LE(6) * 4;
          }
          const first = waiting[0];
          if (first === undefined) return short(0);
          if (setupLength > 0) {
            if (received.length < setupLength) return short(setupLength);
            const reply = received.subarray(0, setupLength);
            received = received.subarray(setupLength);
            setupLength = 0;
            waiting.shift();
            first(reply);
            continue;
          }
          if (received.length < 32) return short(32);
          const kind = received.readUInt8(0);
          // An event the app never asked for: passed over.
          if (kind > 1) {
            received = received.subarray(32);
            continue;
          }
          const length = kind === 1 ? 32 + received.readUInt32LE(4) * 4 : 32;
          if (received.length < length) return short(length);
          const reply = received.subarray(0, length);
          received = received.subarray(length);
          waiting.shift();
          first(kind === 1 ? reply : null);
        }
      });
      const wait = (send: Uint8Array | null) =>
        Effect.callback<Reply | null>((resume) => {
          if (ended) return resume(Effect.succeed(null));
          waiting.push((reply) => resume(Effect.succeed(reply)));
          if (send !== null) socket.write(send);
        });
      return { wait, end };
    }),
    ({ end }) => Effect.sync(end),
  ).pipe(
    Effect.flatMap(({ wait }) =>
      wait(null).pipe(
        Effect.map((setup): XConnection | null =>
          setup === null ? null : { setup, ask: (request) => wait(request) },
        ),
      ),
    ),
  );

/** Where the X server of this session listens, the screen windows open on, and its cookie. */
export interface XServer {
  readonly path: string;
  readonly screen: number;
  readonly cookie: Uint8Array | null;
}

/**
 * The X server `DISPLAY` names, when it is on this computer: its socket, and
 * the cookie the authority file keeps for it; `null` for none here.
 */
export const xServerHere = Effect.fn("desktop.xServerHere")(function* (here: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly hostname: string;
}) {
  const display = parseDisplay(here.env["DISPLAY"]);
  if (display === null) return null;
  const fs = yield* FileSystem.FileSystem;
  const authority = yield* fs
    .readFile(here.env["XAUTHORITY"] ?? `${here.homeDirectory}/.Xauthority`)
    .pipe(Effect.option);
  return {
    path: `/tmp/.X11-unix/X${display.number}`,
    screen: display.screen,
    cookie: Option.match(authority, {
      onNone: () => null,
      onSome: (file) => cookieFor(file, display.number, here.hostname),
    }),
  } satisfies XServer;
});
