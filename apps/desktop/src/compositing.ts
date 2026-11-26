// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- three requests of the X protocol on the display's own socket, which no service of Effect's speaks.
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

// Whether a window here can be see-through. Windows and macOS always
// composite their windows, and so does every Wayland desktop. On X11 a
// compositing manager may or may not run, and without one a transparent
// window shows black where it should show what is behind it. Electron does
// not say which, so the app asks the X server what the window manager spec
// has a compositing manager declare: it owns the selection `_NET_WM_CM_S<n>`
// of each screen it composites (EWMH, "Compositing Managers").

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

/** InternAtom, only if the atom exists: an atom nobody made is a selection nobody owns. */
const internAtom = (atom: string): Uint8Array => {
  const name = new TextEncoder().encode(atom);
  const request = new Uint8Array(8 + name.length + padded(name.length));
  const view = new DataView(request.buffer);
  request[0] = 16;
  request[1] = 1;
  view.setUint16(2, request.length / 4, true);
  view.setUint16(4, name.length, true);
  request.set(name, 8);
  return request;
};

const getSelectionOwner = (atom: number): Uint8Array => {
  const request = new Uint8Array(8);
  const view = new DataView(request.buffer);
  request[0] = 23;
  view.setUint16(2, 2, true);
  view.setUint32(4, atom, true);
  return request;
};

/** A reply's length, and where an atom or a window stands in one. */
const REPLY = 32;
const VALUE_AT = 8;

/**
 * Whether a compositing manager runs on `screen` of the X server listening
 * at `path`: `null` when the server did not say, as when it refused the
 * connection, answered something else, or took longer than `timeoutMs`.
 */
export const compositingManagerRuns = (options: {
  readonly path: string;
  readonly screen: number;
  readonly cookie: Uint8Array | null;
  readonly timeoutMs: number;
}): Effect.Effect<boolean | null> =>
  Effect.callback<boolean | null>((resume) => {
    const socket = NodeNet.connect({ path: options.path });
    let received = Buffer.alloc(0);
    let step: "setup" | "atom" | "owner" = "setup";
    let settled = false;
    const settle = (answer: boolean | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(answer));
    };
    socket.setTimeout(options.timeoutMs, () => settle(null));
    socket.on("error", () => settle(null));
    socket.on("close", () => settle(null));
    socket.on("connect", () => socket.write(setupRequest(options.cookie)));
    /** The next `length` bytes received, once they all are. */
    const take = (length: number): Buffer | null => {
      if (received.length < length) return null;
      const taken = received.subarray(0, length);
      received = received.subarray(length);
      return taken;
    };
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (step === "setup") {
        if (received.length < 8) return;
        // Success is 1; a refusal (0) and a second round of authentication (2) are not.
        if (received.readUInt8(0) !== 1) return settle(null);
        if (take(8 + received.readUInt16LE(6) * 4) === null) return;
        step = "atom";
        socket.write(internAtom(`_NET_WM_CM_S${options.screen}`));
      }
      if (step === "atom") {
        const reply = take(REPLY);
        if (reply === null) return;
        if (reply.readUInt8(0) !== 1) return settle(null);
        const atom = reply.readUInt32LE(VALUE_AT);
        if (atom === 0) return settle(false);
        step = "owner";
        socket.write(getSelectionOwner(atom));
      }
      if (step === "owner") {
        const reply = take(REPLY);
        if (reply === null) return;
        settle(reply.readUInt8(0) === 1 ? reply.readUInt32LE(VALUE_AT) !== 0 : null);
      }
    });
    return Effect.sync(() => settle(null));
  });

/** How long the X server has to answer before the app goes on without knowing. */
const ASK_FOR = 500;

interface Here {
  readonly platform: NodeJS.Platform;
  readonly wayland: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
  readonly hostname: string;
}

/**
 * Whether a transparent window shows what is behind it here. On X11 the app
 * asks the server; where it cannot ask, or gets no answer, it takes there to
 * be a compositing manager, as nearly every desktop has one.
 */
export const transparencyHere = Effect.fn("desktop.transparencyHere")(function* (here: Here) {
  if (here.platform !== "linux" || here.wayland) return true;
  const display = parseDisplay(here.env["DISPLAY"]);
  if (display === null) return true;
  const fs = yield* FileSystem.FileSystem;
  const authority = yield* fs
    .readFile(here.env["XAUTHORITY"] ?? `${here.homeDirectory}/.Xauthority`)
    .pipe(Effect.option);
  const runs = yield* compositingManagerRuns({
    path: `/tmp/.X11-unix/X${display.number}`,
    screen: display.screen,
    cookie: Option.match(authority, {
      onNone: () => null,
      onSome: (file) => cookieFor(file, display.number, here.hostname),
    }),
    timeoutMs: ASK_FOR,
  });
  return runs ?? true;
});
