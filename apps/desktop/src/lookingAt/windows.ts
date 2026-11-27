// SPDX-License-Identifier: AGPL-3.0-or-later
import type { QuickAccessPicture } from "@j3-bots/desktop-bridge";
import { POWERSHELL, powerShellArgs, system32, withoutModulePath } from "@j3-bots/processes";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { nativeImage } from "electron";
import { type FrontWindow, pictureOf, type WindowReader } from "./reader.ts";
import { lookingAtOf } from "./text.ts";
import { residentHelper } from "./windowsHelper.ts";

// Windows names the window the operator is in (GetForegroundWindow, user32)
// and keeps the others in front-to-back order (GetTopWindow, GetWindow).
// Each holds its title (GetWindowTextW) and the process that made it
// (GetWindowThreadProcessId), whose program describes itself
// (FileDescription). A picture is the window drawing itself into a bitmap
// (PrintWindow, its full content even under other windows), cut to the
// frame the desktop shows (DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS).
//
// Node calls none of them without a native module, and the app ships none:
// a small helper in Windows PowerShell, which every supported Windows has,
// calls them through .NET. Compiling it takes a moment, so the helper starts
// the first time the shortcut is pressed and stays, idle, for a while after
// the last time; it reads one ask per line and answers each on one line.

/**
 * The helper's C#. `Front(own, withTitle)`: the window the operator is in,
 * or, while one of the app's own (process `own`) has the keys, the first
 * ordinary window of another process in front-to-back order that is not
 * kept above all others. No title is read unless `withTitle`. `Picture`: a
 * PNG of a window, as base64.
 */
const HELPER = String.raw`
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class J3Seen { public long window; public string app; public string title; }

public static class J3Windows {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr window, int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr window);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc each, IntPtr data);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

  // Sizes in the display's own pixels, whatever its scale (per monitor, v2).
  public static void Start() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }

  static uint ProcessOf(IntPtr window) { uint process; GetWindowThreadProcessId(window, out process); return process; }

  static string TitleOf(IntPtr window) {
    var text = new StringBuilder(1024);
    GetWindowTextW(window, text, text.Capacity);
    return text.ToString();
  }

  // Shown, not minimized, not a tool palette (WS_EX_TOOLWINDOW), not cloaked on another desktop.
  static bool Ordinary(IntPtr window) {
    if (window == IntPtr.Zero || !IsWindowVisible(window) || IsIconic(window)) return false;
    if ((GetWindowLongW(window, -20) & 0x80) != 0) return false;
    int cloaked;
    if (DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
    Rect rect;
    return GetWindowRect(window, out rect) && rect.Right - rect.Left > 1 && rect.Bottom - rect.Top > 1;
  }

  static Process Running(uint id) {
    try { return Process.GetProcessById((int)id); } catch { return null; }
  }

  // A Store app's window belongs to the frame host; the app's own process draws a child of it.
  static Process AppOf(IntPtr window) {
    uint id = ProcessOf(window);
    Process process = Running(id);
    if (process == null || process.ProcessName != "ApplicationFrameHost") return process;
    uint inner = id;
    EnumChildWindows(window, (child, data) => {
      uint other = ProcessOf(child);
      if (other == id) return true;
      inner = other;
      return false;
    }, IntPtr.Zero);
    return Running(inner) ?? process;
  }

  static string NameOf(Process process) {
    try {
      string described = process.MainModule.FileVersionInfo.FileDescription;
      if (!String.IsNullOrWhiteSpace(described)) return described;
    } catch { }
    return process.ProcessName;
  }

  public static J3Seen Front(uint own, bool withTitle) {
    IntPtr window = GetForegroundWindow();
    if (!Ordinary(window) || ProcessOf(window) == own) {
      window = IntPtr.Zero;
      // GW_HWNDNEXT: the next window down. Windows kept above all others
      // (WS_EX_TOPMOST: a video's picture in picture, a pinned window) stand
      // before the one the operator was in, so they are passed over; a titled
      // window is an app's, read by its length alone.
      for (IntPtr at = GetTopWindow(IntPtr.Zero); at != IntPtr.Zero; at = GetWindow(at, 2)) {
        if ((GetWindowLongW(at, -20) & 0x8) != 0) continue;
        if (Ordinary(at) && ProcessOf(at) != own && GetWindowTextLengthW(at) > 0) { window = at; break; }
      }
    }
    if (window == IntPtr.Zero) return null;
    Process app = AppOf(window);
    if (app == null) return null;
    var seen = new J3Seen();
    seen.window = window.ToInt64();
    seen.app = NameOf(app);
    seen.title = withTitle ? TitleOf(window) : null;
    return seen;
  }

  public static string Picture(long handle) {
    IntPtr window = new IntPtr(handle);
    if (!IsWindow(window) || IsIconic(window)) return null;
    Rect outer;
    if (!GetWindowRect(window, out outer)) return null;
    Rect frame;
    if (DwmGetWindowAttribute(window, 9, out frame, 16) != 0) frame = outer;
    int width = outer.Right - outer.Left, height = outer.Bottom - outer.Top;
    if (width < 2 || height < 2) return null;
    using (var whole = new Bitmap(width, height, PixelFormat.Format32bppRgb)) {
      using (var graphics = Graphics.FromImage(whole)) {
        IntPtr dc = graphics.GetHdc();
        // PW_RENDERFULLCONTENT: what the window draws with the GPU too.
        bool drawn = PrintWindow(window, dc, 2);
        graphics.ReleaseHdc(dc);
        if (!drawn) return null;
      }
      var shown = Rectangle.Intersect(
        new Rectangle(frame.Left - outer.Left, frame.Top - outer.Top, frame.Right - frame.Left, frame.Bottom - frame.Top),
        new Rectangle(0, 0, width, height));
      if (shown.Width < 2 || shown.Height < 2) return null;
      using (var cut = whole.Clone(shown, PixelFormat.Format24bppRgb))
      using (var png = new MemoryStream()) {
        cut.Save(png, ImageFormat.Png);
        return Convert.ToBase64String(png.ToArray());
      }
    }
  }
}
'@
[J3Windows]::Start()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $message = $line | ConvertFrom-Json
  $ask = $message.ask
  $answer = $null
  try {
    if ($ask.op -eq 'front') { $answer = [J3Windows]::Front([uint32]$ask.own, [bool]$ask.title) }
    elseif ($ask.op -eq 'picture') { $answer = [J3Windows]::Picture([int64]$ask.window) }
  } catch { $answer = $null }
  [Console]::Out.WriteLine((@{ id = $message.id; answer = $answer } | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
}
`;

const decodeSeen = Schema.decodeUnknownOption(
  Schema.NullOr(
    Schema.Struct({
      window: Schema.Int,
      app: Schema.NullOr(Schema.String),
      title: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodePng = Schema.decodeUnknownOption(Schema.NullOr(Schema.String));

/** How long the helper may be idle before it stops. */
const IDLE_FOR = Duration.minutes(10);

/** How long the helper has to answer, compiling itself the first time included. */
const FRONT_WITHIN = Duration.seconds(8);
const PICTURE_WITHIN = Duration.seconds(8);

/** Reads the window in front on Windows, while the scope lasts. */
export const windowsReader = Effect.fn("desktop.windowsReader")(function* (ownProcess: number) {
  const ask = yield* residentHelper({
    command: system32(process.env, POWERSHELL),
    args: powerShellArgs(HELPER),
    env: withoutModulePath(process.env),
    idleFor: IDLE_FOR,
  });

  const takePicture = (window: number) =>
    ask({ op: "picture", window }, PICTURE_WITHIN).pipe(
      Effect.map((answer): QuickAccessPicture => {
        const png = Option.getOrNull(decodePng(answer));
        if (png === null) return { _tag: "failed" };
        return pictureOf(nativeImage.createFromBuffer(Buffer.from(png, "base64")));
      }),
    );

  const front = ({ withTitle }: { readonly withTitle: boolean }) =>
    ask({ op: "front", own: ownProcess, title: withTitle }, FRONT_WITHIN).pipe(
      Effect.map((answer) => {
        const seen = Option.getOrNull(Option.flatMap(decodeSeen(answer), Option.fromNullishOr));
        if (seen === null) return null;
        const lookingAt = lookingAtOf(seen.app, seen.title, withTitle);
        if (lookingAt === null) return null;
        return {
          lookingAt,
          picture: "available",
          takePicture: takePicture(seen.window),
        } satisfies FrontWindow;
      }),
    );

  return {
    reach: "window",
    // The foreground window, read before quick access takes the keys; when
    // the helper is not that quick (it compiles itself on the first press),
    // the window just under quick access's is found in front-to-back order.
    beforeFocus: Duration.millis(150),
    front,
    screen: Effect.succeed("not-needed"),
    askScreenAccess: () => Effect.void,
  } satisfies WindowReader;
});
