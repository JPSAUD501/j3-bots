// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The launcher is compiled once, by Windows' own C# compiler, into a file this package keeps; nothing else here touches the system.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { windowsCommandWord } from "./windows.ts";

// How J3 Bots runs a program on Windows so that nothing it started outlives it.
//
// Windows has no process groups: a process's children keep running when it
// ends, and `taskkill /T` finds them only through a parent that still runs.
// Once the program has ended, by a crash or a kill, whatever it started would
// be left on the operator's desktop. A job object holds them instead: every
// process a member starts is a member too, whatever becomes of its parent, and
// a job marked kill-on-close ends all of them once its last handle closes.
//
// So the program is started by a small launcher. It puts itself in a new
// kill-on-close job, then starts the program, which is born a member, waits
// for it to end and exits with its exit code. The launcher holds the job's
// only handle, which closes when the launcher ends, however it ends: after
// the program, or by a stop that ends the launcher. Then Windows ends every
// process left in the job. A member may not leave it: the job does not allow
// breakaway.
//
// The launcher is a C# program, compiled by the compiler of .NET Framework 4,
// which every supported Windows ships (`csc.exe`), once for its source: the
// first start on a computer compiles it into the user's local application
// data, under a name that is a hash of its source, and every later start runs
// that file. Compiling it on each start, as Windows PowerShell's `Add-Type`
// did, took 0.4 s on an idle computer and up to 30 s on a busy one, whose
// antivirus scans every new assembly.
//
// The program gets the launcher's environment, the one the caller gives. What
// becomes of its standard streams is the caller's choice (`JobStdio`).

/**
 * The launcher: `j3-job <drop|relay> <program> <arguments>`, where
 * `<arguments>` is the program's command line after its name.
 */
const LAUNCHER_SOURCE = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace J3 {
  static class Job {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
      public BasicLimits Basic;
      public IoCounters Io;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    const int ExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits information, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    // Creates the job and puts this process in it; the handle stays open until this process ends.
    public static void Enter() {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception();
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.LimitFlags = KillOnJobClose;
      if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception();
      if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    }
  }

  // Copies one stream into another as bytes arrive, flushing each write, on a
  // thread of its own: a message the program writes reaches the launcher's
  // caller at once, and one the caller writes reaches the program at once.
  sealed class Relay {
    readonly Stream from;
    readonly Stream to;
    readonly bool closeWhenDone;

    Relay(Stream from, Stream to, bool closeWhenDone) {
      this.from = from;
      this.to = to;
      this.closeWhenDone = closeWhenDone;
    }

    void Run() {
      byte[] buffer = new byte[65536];
      try {
        int read;
        while ((read = from.Read(buffer, 0, buffer.Length)) > 0) {
          to.Write(buffer, 0, read);
          to.Flush();
        }
      } catch (IOException) {
      } catch (ObjectDisposedException) {
      } finally {
        if (closeWhenDone) {
          try { to.Close(); } catch (IOException) { }
        }
      }
    }

    public static Thread Start(Stream from, Stream to, bool closeWhenDone) {
      Thread thread = new Thread(new Relay(from, to, closeWhenDone).Run);
      thread.IsBackground = true;
      thread.Start();
      return thread;
    }
  }

  static class Launcher {
    static int Main(string[] args) {
      if (args.Length != 3 || (args[0] != "drop" && args[0] != "relay")) {
        Console.Error.WriteLine("usage: j3-job drop|relay <program> <arguments>");
        return 2;
      }
      Process program;
      try {
        Job.Enter();
        ProcessStartInfo start = new ProcessStartInfo(args[1], args[2]);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        program = Process.Start(start);
      } catch (Win32Exception error) {
        Console.Error.WriteLine(error.Message);
        return 1;
      }
      Thread output = null;
      Thread errors = null;
      if (args[0] == "drop") {
        program.StandardInput.Close();
        program.BeginOutputReadLine();
        program.BeginErrorReadLine();
        Console.Out.WriteLine(program.Id);
        Console.Out.Flush();
      } else {
        Relay.Start(Console.OpenStandardInput(), program.StandardInput.BaseStream, true);
        output = Relay.Start(program.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
        errors = Relay.Start(program.StandardError.BaseStream, Console.OpenStandardError(), false);
      }
      // With a timeout, the wait ends when the program does, not when every
      // process holding its output has closed it.
      while (!program.WaitForExit(3600000)) { }
      // What the program wrote before it ended is passed on; a process it
      // left holding its output does not keep the launcher waiting.
      if (output != null) output.Join(5000);
      if (errors != null) errors.Join(5000);
      return program.ExitCode;
    }
  }
}
`;

/**
 * What becomes of the program's standard streams:
 * - `drop`: its input is closed and its output read and dropped, as when it
 *   is started directly with its output ignored. The first line the launcher
 *   prints is the id of the process it started.
 * - `relay`: the launcher's own standard input, output and error are the
 *   program's, byte for byte as they arrive, and the launcher prints nothing
 *   of its own. When the launcher's input ends, so does the program's.
 */
export type JobStdio = "drop" | "relay";

/** The launcher's file name: a hash of its source, so that a changed source is compiled again. */
const LAUNCHER_FILE = `j3-job-${NodeCrypto.createHash("sha256").update(LAUNCHER_SOURCE).digest("hex").slice(0, 16)}.exe`;

/** The C# compilers of .NET Framework 4, the 64-bit one first. */
const compilers = (systemRoot: string) =>
  ["Framework64", "Framework"].map((framework) =>
    NodePath.win32.join(systemRoot, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
  );

const exists = (file: string) =>
  NodeFs.access(file).then(
    () => true,
    () => false,
  );

const compile = (compiler: string, source: string, out: string) =>
  new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(
      compiler,
      [
        "/nologo",
        "/noconfig",
        "/reference:System.dll",
        "/target:exe",
        "/optimize+",
        `/out:${out}`,
        source,
      ],
      { windowsHide: true },
      (error) =>
        error === null ? resolve() : reject(new Error("The job launcher did not compile")),
    );
  });

/** Compiles the launcher into `file`, unless it is there already. */
const build = async (
  environment: Readonly<Record<string, string | undefined>>,
  file: string,
): Promise<string> => {
  if (await exists(file)) return file;
  const found = await Promise.all(
    compilers(environment["SystemRoot"] ?? "C:\\Windows").map(async (candidate) =>
      (await exists(candidate)) ? [candidate] : [],
    ),
  );
  const compiler = found.flat()[0];
  if (compiler === undefined) throw new Error("This Windows has no .NET Framework 4 compiler");
  await NodeFs.mkdir(NodePath.win32.dirname(file), { recursive: true });
  // Compiled under a name of its own, then renamed: no start runs a file still being written.
  const draft = `${file}.${NodeCrypto.randomUUID()}`;
  try {
    await NodeFs.writeFile(`${draft}.cs`, LAUNCHER_SOURCE);
    await compile(compiler, `${draft}.cs`, `${draft}.exe`);
    await NodeFs.rename(`${draft}.exe`, file).catch(async (error: unknown) => {
      // Another server compiled it meanwhile, and may be running it.
      if (!(await exists(file))) throw error;
    });
    return file;
  } finally {
    await NodeFs.rm(`${draft}.cs`, { force: true });
    await NodeFs.rm(`${draft}.exe`, { force: true });
  }
};

/** The compiles under way in this process, by file: the starts waiting on one share it. */
const building = new Map<string, Promise<string>>();

/**
 * The launcher's path, in the local application data of the user whose
 * `environment` it is, compiled first when no start on this computer has
 * compiled it yet. Rejects when it cannot be compiled.
 */
export const jobLauncher = (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> => {
  const base = environment["LOCALAPPDATA"] ?? environment["TEMP"];
  if (base === undefined) {
    return Promise.reject(new Error("There is no folder to keep the job launcher in"));
  }
  const file = NodePath.win32.join(base, "J3 Bots", "launcher", LAUNCHER_FILE);
  const pending = building.get(file);
  if (pending !== undefined) return pending;
  const started = build(environment, file).finally(() => building.delete(file));
  building.set(file, started);
  return started;
};

/**
 * The command that runs `executable` with `args` on Windows in a job that
 * ends with it (see above), by the launcher at `launcher` (`jobLauncher`). It
 * exits with the program's exit code.
 */
export const inJob = (
  launcher: string,
  executable: string,
  args: ReadonlyArray<string>,
  stdio: JobStdio = "drop",
): { readonly command: string; readonly args: ReadonlyArray<string> } => ({
  command: launcher,
  args: [stdio, executable, args.map(windowsCommandWord).join(" ")],
});
