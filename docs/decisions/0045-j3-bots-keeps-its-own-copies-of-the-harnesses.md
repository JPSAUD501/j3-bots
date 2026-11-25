# 0045: J3 Bots keeps its own copies of the harnesses

**Status:** Accepted

## Context

[Decision 0044](0044-j3-bots-installs-and-updates-the-harnesses.md) settled that J3 Bots installs a missing Claude Code or Codex itself, from each maker's distribution, and left how to a change of its own. The engine cannot do it at the version J3 Bots pins (**Read** at `59651c1`: `provider.install.start` refuses Claude Code, and installs Codex only for a `managed` instance, another provider with its own sign-in).

What that change has to hold:

- **Nothing unchecked runs.** A download is the harness the maker published, or nothing is made executable.
- **The operator's own install stays theirs.** A harness the operator installed, on the server's `PATH`, is never changed, replaced or updated by J3 Bots on its own.
- **An update never cuts work short.** Switching a provider to a new executable ends its harness processes, so a turn running there would end with it.
- **No mirrors, no install scripts, no global npm.** The makers' install scripts write into the operator's own setup and check nothing J3 Bots can see; npm would install into a global prefix, often root's.

## Decision

**J3 Bots downloads each harness from its maker's official distribution into a folder of its own home, checks it against the maker's published SHA-256 before anything is made executable, and runs its provider on that copy by the engine's `binaryPath`. It keeps the copy up to date by itself, and switches to a new version only while no bot on that provider runs.**

- **Where from.** Claude Code: `downloads.claude.ai/claude-code-releases`, its `stable` channel, the version's `manifest.json` with each platform's SHA-256 and size, and the binary. Codex: `releases.openai.com/codex`, its `channels/latest` listing with each file's digest, the version's `codex-package_SHA256SUMS`, and the package for the server's system. Both are what each maker's own install script reads. Over HTTPS, from those origins only, following no redirect.
- **What is checked.** The whole download against the maker's SHA-256 and, where the maker gives it, its size. A missing checksum, or one that differs, fails the install and leaves nothing behind. For Codex, the package's digest must agree in the listing and in its checksum file, and the checksum file's own digest must be the listing's. The unpacked copy is then run once (`--version`, with the engine's environment and J3 Bots' own harness home) and must say the version listed.
- **Where to.** `<J3_HOME>/harnesses/<provider>/versions/<version>/`, with `current.json` naming the version the provider runs. A new version is downloaded beside the current one, which keeps running until the new one checked; then `current.json` is replaced whole, the provider switched, and the old version removed. A download cut off resumes.
- **How the engine runs it.** Each Claude Code and Codex instance names J3 Bots' copy as its `binaryPath` (**Read** at `59651c1`, `ClaudeSettings` and `CodexSettings` in `contracts/src/settings.ts`), at each provisioning and, on a switch while the engine runs, by replacing that one instance (`server.updateSettings` with an `upsert`, which needs the `providers:manage` scope). The operator's `PATH` is not changed. An instance with no copy runs what the engine finds on its `PATH`, as before.
- **Which harness a provider runs.** J3 Bots' copy when there is one; else the operator's own, found on the `PATH`. A provider with neither offers **Install**. J3 Bots does not install beside an operator's own harness: that one keeps the engine's update button from decision 0044.
- **Updates.** The server checks each maker's latest version a minute after it starts, then about every six hours (an hour after a check that failed). With **Update automatically** on, as it is unless the operator turns it off, a newer version is installed by itself. Settings shows the version, the newest one, **Update now**, and how the last install or update ended.
- **Waiting.** A new version that checked waits while any bot on that provider runs a turn or background work, and switches as soon as none does. During the switch, which takes moments, a new turn of any bot waits for it to end, as while a provider connection is stored (`SendPause`), and then starts.
- **Only the operator.** Install, update and cancel are requests of a paired device. No bot tool reaches them.

## What it costs

- **J3 Bots follows two distributions.** Their addresses, listings and package layouts are J3 Bots' to keep working; a change on a maker's side fails the install, with the reason, until J3 Bots follows it.
- **Disk.** Claude Code's binary is about 370 MB, and Codex's package about 200 MB compressed, more once unpacked (**Verified** 2026-11-25 for the downloads, by the sizes the makers' listings give, Claude Code 2.1.326 and Codex 0.172.0 for Linux x64). During an update, the old and new versions are both on disk.
- **An update waits on busy bots.** On a server whose bots on one provider are never all idle, an update waits until they are.
- **Only some machines.** Claude Code for Linux x64 and arm64, macOS arm64 and Windows x64; Codex for Linux x64 and arm64 (musl), macOS arm64 and Windows x64. Elsewhere the provider links to its maker's install page, with **Look again**.

## What was rejected

- **Putting the copies' folder first on the engine's `PATH`.** Decision 0044's first plan. The `PATH` the engine gives a harness is also the `PATH` its bots' commands run with, and a switch would need the engine restarted, ending every provider's work, where `binaryPath` replaces one instance.
- **Running the makers' install scripts.** They install into the operator's own setup, which J3 Bots leaves alone, and run code J3 Bots cannot check first.
- **npm.** Claude Code and Codex both publish to npm, but a global install writes outside J3 Bots' home, and a local one would need npm and its trust in every dependency's install scripts.
- **Updating whatever runs, without waiting.** Switching ends the harness processes, and with them any turn running there.
