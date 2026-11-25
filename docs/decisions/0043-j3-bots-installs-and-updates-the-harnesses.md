# 0043: J3 Bots installs and updates the harnesses

**Status:** Accepted

## Context

A bot runs on Claude Code or Codex, which J3 Bots does not ship: until 0.7.1 the operator installed each harness, and when the engine did not find one, every client said only "Unavailable now". A first run in the desktop app's local mode could end there, with "Create" refused and no cause on the screen.

The owner wants what T3 Code offers: a harness that is missing is installed by the app, and the harnesses are kept up to date, so a fresh install goes from nothing to a first bot without a terminal.

The engine J3 Bots pins has requests for both, but not for J3 Bots' case (**Read** at `59651c1`):

- **Install.** `provider.install.start` refuses Claude Code: its setup never says it can install (`providerInstallation.ts`). It installs Codex only for an instance set up as `managed`, which is another provider, with its own home and its own ChatGPT sign-in (`CodexManagedProvider.ts`). J3 Bots' Codex instance is not one, and could not become one without giving up the endpoint and sign-in J3 Bots sets up for it.
- **Update.** `server.updateProvider` updates a harness the operator installed, the way its maker does (`claude update`, `codex update`, or npm for one installed with npm), and each provider's `versionAdvisory` says whether a newer version is out. T3 Code offers this as a button; it updates nothing by itself, but for a managed Codex older than its pin.

## Decision

**J3 Bots installs a missing harness, and updates the harnesses, without changing the engine: updates through the engine's own request, installs with J3 Bots' own copy of each harness, from its maker's distribution.**

- **Why a provider cannot run is part of its status** (`reason`: not installed, failed, turned off), with the engine's own words, and each client offers the one action that fixes it. This holds from 0.7.1.
- **Install comes in its own change, after this one.** J3 Bots downloads Claude Code and Codex from their makers' official distributions into a folder of its own home, checks each download against its maker's published checksum, and puts that folder first on the engine's `PATH`. The engine then finds it as it finds any harness. Until that change ships, a harness that is not installed links to its maker's install page, with "Look again".
- **Update through the engine.** Settings shows the installed and the latest version where the engine reports a newer one, and offers "Update", which asks the engine (`server.updateProvider`). Like T3 Code, J3 Bots never updates the operator's own install by itself.
- **Only the operator.** Install, update and checking a provider again are requests of a paired device, which holds the operator's authority. No bot tool reaches them.

## What it costs

- **J3 Bots follows two distributions.** Their download addresses, archive layouts and checksum files are J3 Bots' to keep working, where the engine would have kept them.
- **Two copies of a harness can exist.** The operator's own and J3 Bots' own are separate installs; J3 Bots' own is found first.

## What was rejected

- **Codex as a managed instance.** The engine would install and update it, but it is another provider, with a sign-in J3 Bots does not set up, and Claude Code would still have no install.
- **Changing the engine to install Claude Code.** J3 Bots runs T3 Code unmodified ([0001](0001-t3-code-as-unmodified-engine.md)).
- **Running the makers' install scripts.** They install into the operator's own setup, which J3 Bots leaves alone, and check nothing J3 Bots can see.
