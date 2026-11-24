// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  POWERSHELL,
  powerShellArgs,
  powerShellLiteral,
  system32,
  windowsCommandWord,
} from "./windows.ts";

// How J3 Bots runs a program on Windows so that nothing it started outlives it.
//
// Windows has no process groups: a process's children keep running when it
// ends, and `taskkill /T` finds them only through a parent that still runs.
// Once the program has ended, by a crash or a kill, whatever it started would
// be left on the operator's desktop. A job object holds them instead: every
// process a member starts is a member too, whatever becomes of its parent, and
// a job marked kill-on-close ends all of them once its last handle closes.
//
// So the program is started by a small Windows PowerShell launcher. It puts
// itself in a new kill-on-close job, then starts the program, which is born a
// member, waits for it to end and exits with its exit code. The launcher holds
// the job's only handle, which closes when the launcher ends, however it ends:
// after the program, or by a stop that ends the launcher. Then Windows ends
// every process left in the job. A member may not leave it: the job does not
// allow breakaway.
//
// The program gets the launcher's environment, the one the caller gives,
// without the `PSModulePath` PowerShell adds for itself. What becomes of its
// standard streams is the caller's choice (`JobStdio`).

/** Creates the job and puts this process in it; the handle stays open until this process ends. */
const JOB_TYPE = `
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace J3 {
  public static class Job {
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
  public sealed class Relay {
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

const startLines = (executable: string, args: ReadonlyArray<string>) => [
  `Add-Type -TypeDefinition ${powerShellLiteral(JOB_TYPE)}`,
  "[J3.Job]::Enter()",
  "$start = New-Object System.Diagnostics.ProcessStartInfo",
  `$start.FileName = ${powerShellLiteral(executable)}`,
  `$start.Arguments = ${powerShellLiteral(args.map(windowsCommandWord).join(" "))}`,
  "$start.UseShellExecute = $false",
  "$start.CreateNoWindow = $true",
  "$start.RedirectStandardInput = $true",
  "$start.RedirectStandardOutput = $true",
  "$start.RedirectStandardError = $true",
  "$start.EnvironmentVariables.Remove('PSModulePath')",
  "$program = [System.Diagnostics.Process]::Start($start)",
];

// With a timeout, the wait ends when the program does, not when every process
// holding its output has closed it.
const WAIT = "while (-not $program.WaitForExit(3600000)) { }";

const STDIO_LINES: Record<JobStdio, ReadonlyArray<string>> = {
  drop: [
    "$program.StandardInput.Close()",
    "$program.BeginOutputReadLine()",
    "$program.BeginErrorReadLine()",
    "[Console]::Out.WriteLine($program.Id)",
    "[Console]::Out.Flush()",
    WAIT,
  ],
  relay: [
    "$null = [J3.Relay]::Start([Console]::OpenStandardInput(), $program.StandardInput.BaseStream, $true)",
    "$output = [J3.Relay]::Start($program.StandardOutput.BaseStream, [Console]::OpenStandardOutput(), $false)",
    "$errors = [J3.Relay]::Start($program.StandardError.BaseStream, [Console]::OpenStandardError(), $false)",
    WAIT,
    // What the program wrote before it ended is passed on; a process it left
    // holding its output does not keep the launcher waiting.
    "$null = $output.Join(5000)",
    "$null = $errors.Join(5000)",
  ],
};

/**
 * The command that runs `executable` with `args` on Windows in a job that
 * ends with it (see above): Windows PowerShell 5.1 by its full path, from
 * `SystemRoot` in `environment`. It exits with the program's exit code.
 */
export const inJob = (
  environment: Readonly<Record<string, string | undefined>>,
  executable: string,
  args: ReadonlyArray<string>,
  stdio: JobStdio = "drop",
): { readonly command: string; readonly args: ReadonlyArray<string> } => ({
  command: system32(environment, POWERSHELL),
  args: powerShellArgs(
    [...startLines(executable, args), ...STDIO_LINES[stdio], "exit $program.ExitCode"].join("\n"),
  ),
});
