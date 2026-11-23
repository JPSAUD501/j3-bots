// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  POWERSHELL,
  powerShellArgs,
  powerShellLiteral,
  system32,
  windowsCommandWord,
} from "./Processes.ts";

// How the engine runs on Windows, so that nothing it started outlives it.
//
// Windows has no process groups: a process's children keep running when it
// ends, and `taskkill /T` finds them only through a parent that still runs.
// Once the engine has ended, by a crash or a kill, its harnesses and whatever
// they started would be left on the operator's desktop, holding files the next
// update replaces. A job object holds them instead: every process a member
// starts is a member too, whatever becomes of its parent, and a job marked
// kill-on-close ends all of them once its last handle closes.
//
// So the engine is started by a small Windows PowerShell launcher. It puts
// itself in a new kill-on-close job, then starts the engine, which is born a
// member, prints the engine's id, waits for it to end and exits with its exit
// code. The launcher holds the job's only handle, which closes when the
// launcher ends, however it ends: after the engine, or by the supervisor's
// stop, which ends the launcher's tree. Then Windows ends every process left
// in the job. A harness may not leave it: the job does not allow breakaway.
//
// The engine gets the launcher's environment, the one the supervisor gives,
// without the `PSModulePath` PowerShell adds for itself. Its standard input is
// closed and its output read and dropped, as when it is started directly with
// its output ignored.

/** Creates the job and puts this process in it; the handle stays open until this process ends. */
const JOB_TYPE = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace J3 {
  public static class EngineJob {
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
}
`;

/**
 * The command that runs `executable` with `args` on Windows in a job that
 * ends with it (see above): Windows PowerShell 5.1 by its full path, from
 * `SystemRoot` in `environment`. The first line it prints is the id of the
 * process it started; it exits with that process's exit code.
 */
export const inJob = (
  environment: Readonly<Record<string, string | undefined>>,
  executable: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } => ({
  command: system32(environment, POWERSHELL),
  args: powerShellArgs(
    [
      `Add-Type -TypeDefinition ${powerShellLiteral(JOB_TYPE)}`,
      "[J3.EngineJob]::Enter()",
      "$start = New-Object System.Diagnostics.ProcessStartInfo",
      `$start.FileName = ${powerShellLiteral(executable)}`,
      `$start.Arguments = ${powerShellLiteral(args.map(windowsCommandWord).join(" "))}`,
      "$start.UseShellExecute = $false",
      "$start.CreateNoWindow = $true",
      "$start.RedirectStandardInput = $true",
      "$start.RedirectStandardOutput = $true",
      "$start.RedirectStandardError = $true",
      "$start.EnvironmentVariables.Remove('PSModulePath')",
      "$engine = [System.Diagnostics.Process]::Start($start)",
      "$engine.StandardInput.Close()",
      "$engine.BeginOutputReadLine()",
      "$engine.BeginErrorReadLine()",
      "[Console]::Out.WriteLine($engine.Id)",
      "[Console]::Out.Flush()",
      // With a timeout, the wait ends when the engine does, not when every
      // process holding its output has closed it.
      "while (-not $engine.WaitForExit(3600000)) { }",
      "exit $engine.ExitCode",
    ].join("\n"),
  ),
});
