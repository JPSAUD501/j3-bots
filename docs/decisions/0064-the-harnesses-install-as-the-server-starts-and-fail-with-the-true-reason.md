# 0064: The harnesses install as the server starts, and fail with the true reason

**Status:** Accepted

## Context

[Decision 0045](0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md) had a provider with neither J3 Bots' copy nor the operator's own offer **Install**, and the server install it once asked. On a first run that meant the engine downloaded while the harnesses waited for a press the operator could make only on the connect step.

On Windows the first run of the desktop app failed both installs, Claude Code's and Codex's, with "check its free disk space", on a computer with plenty of it, while the engine installed fine on the same machine. Two faults made that:

- **The order.** A copy was unpacked into `<v>.staging/`, run once there with `--version`, and only then renamed to `versions/<v>/`. Windows refuses to rename a folder while another program holds a file in it, and a new executable is held for a moment after its first run: by a scanner that looks at it as it runs, or by its own process as it ends. The engine's install moves its folder before anything runs from it, which is why it succeeded. **Verified** on CI's Windows job (pull request #327): with a second handle opened on the new executable right after its first run and kept two seconds, the install as it was failed both harnesses.
- **The reason.** Every file failure of an install was reported as `storage`, whatever the system said, and `storage` reads as a full disk. The engine's install did the same, and its failure carried no reason at all to the clients.

The engine's own words for a harness it does not find ("not installed or not on PATH") also reached the screen while J3 Bots was installing that very harness.

## Decision

**Each missing harness starts installing as the server starts, beside the engine's download; a copy moves into its version's folder before it first runs; a rename or a removal Windows refuses while a file is held is tried again for a while; and every install failure, a harness's or the engine's, says what it comes down to.**

- **When.** As the server starts, every harness with no copy of J3 Bots', none of the operator's on the `PATH`, a build for the server's system, and whose last install the operator did not cancel, starts installing at once, whatever **Update automatically** says: that setting is about updates. The check that runs a minute later starts one the same way, so a harness the operator removed from the `PATH` is installed then. The engine's status carries the copies (`harnesses`) even before the engine runs and reports any provider, so a client can follow the three downloads from the first moment; `preparation` in the clients' shared runtime reads them, with the engine's, as one list.
- **A stop is not held up.** An install the server started by itself can be switching the engine to its copy when the operator quits, and the engine can take a minute and a half to show it runs it. Only a client's cancel is kept from interrupting a switch; the server's stop interrupts it at once, and the next start provisions the engine from `current.json`.
- **The order.** Download, check against the maker's SHA-256, unpack into `<v>.staging/`, rename that to `versions/<v>/`, and only then run it once with `--version`. A copy that does not say its version is removed from there.
- **Patience on Windows.** A rename or a removal that fails with `EBUSY`, `EPERM` or `EACCES` on Windows is tried again, from 50 ms, doubling up to a second apart, for 30 seconds at most, for the harnesses and the engine alike. Elsewhere, and for any other code, it fails at once.
- **The reason.** A file failure is `storage` only when the system said the disk or the quota is full (`ENOSPC`, `EDQUOT`); `in-use` when a file was held (`EBUSY`, and for a rename or a removal on Windows the codes above); `permission` when the system does not let the server write there; `outside-home` when a location leads out of the home; `files` for anything else. The engine's install gives the same reasons, with `download`, `checksum`, `extract` and `unsupported-platform` of its own, as `installFailure` beside `install-failed`. The server's log keeps each with the system's code, the file and the call.
- **The words.** Clients say each reason in plain words, and say "Installing…" with how far it has come, never the engine's "not found" for a harness J3 Bots is installing or failed to install.

The literal lists grow, and the fields are optional: the protocol stays at 11.

## What it costs

- **A first start downloads without asking.** About 600 MB for the two harnesses beside the engine's archive, on whatever connection the machine has. **Cancel** stops one and is remembered, so the next start does not begin it again; **Install** starts it then.
- **A real failure shows later.** A rename refused for a reason that is not a held file, on Windows, is tried for 30 seconds before it fails.
- **`files` tells little.** It is what remains when the code is none of the above; the log says which code it was.

## What was rejected

- **Checking free space first.** The disk had room; the check would have passed, and the install failed after it all the same.
- **Trying the whole install again.** It downloads hundreds of megabytes again, and a scanner holds the new copy just as long the second time.
- **Telling the operator to exclude the data directory from their scanner.** It is the operator's machine and their security trade, not J3 Bots' to make; the server's fix for a repeated `in-use` mentions it as their choice.
- **Reading `EPERM` and `EACCES` as `in-use` for every operation.** For a write they mean the system does not allow it, and calling that a held file would send the operator to the wrong fix.
