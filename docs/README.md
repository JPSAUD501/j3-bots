# Documentation

## How to read these documents

J3 Bots depends on the behavior of another project's server, pinned to one T3 Code release ([Engine: version pinning](architecture/engine.md#version-pinning)). Each claim about that server carries one of three labels:

| Label | Meaning |
| --- | --- |
| **Verified** | Observed on a running T3 Code server. The probe, the release and the date are in [research/t3-code.md](research/t3-code.md). |
| **Read** | Read in T3 Code source, not yet exercised. The commit is named with each fact in [research/t3-code.md](research/t3-code.md). |
| **Assumed** | Reasoned, not checked. Each one is listed in [open-questions.md](open-questions.md). |

Decisions marked **Proposed** are recommendations waiting for the project owner's confirmation. Decisions marked **Accepted** are settled.

## Product

- [Vision and principles](vision.md): what J3 Bots is for and what it refuses to become.
- [Concepts](product/concepts.md): the vocabulary. Read this before anything else.
- [Experience](product/experience.md): the flows a user goes through and the screens that serve them.
- [Usage data](product/usage-data.md): what J3 Bots sends about how it is used, what it never sends, and how to turn it off.

## Architecture

- [Overview](architecture/overview.md): the pieces and the boundaries between them.
- [Engine](architecture/engine.md): how J3 Bots runs and drives T3 Code without modifying it.
- [Server](architecture/server.md): the domain model, the wake pipeline, rooms, memory and routines.
- [Clients](architecture/clients.md): web, desktop and mobile.
- [Browser](architecture/browser.md): the browsers J3 Bots runs for its bots, their hosts and the shared driver.
- [Security](architecture/security.md): trust boundaries and what protects them.

## Prompts

- [Prompt architecture](prompts/architecture.md): the layers, how each reaches the model, the tools bots get.
- [Base prompt](prompts/base-prompt.md): where the text every bot shares lives, and the notes for editing it.

## Design

- [Design language](design/design-language.md): principles, references, tokens and components.

## Operations

- [Installing J3 Bots](operations/install.md): the one-command install, supported systems, what `doctor` says, providers, pairing, Raspberry Pi notes.
- [Operating J3 Bots](operations/operating.md): configuration, the service, logs, updates, back up and restore, removal.
- [Reaching J3 Bots from elsewhere](operations/exposing.md): HTTPS, Tailscale, a domain through a proxy, `publicOrigin`, webhooks, a sign-in gate.
- [A bot's browser, secrets and connectors](operations/browser-secrets-and-connectors.md): turning on a bot's browser, watching it and taking it over, the secrets you type for bots and the cards bots ask with, connecting a service, and what backups and updates do with each.
- [A Google connector with your own app](operations/connector-google.md) and [a Slack one](operations/connector-slack.md) (drafts): registering the app, the addresses sign-ins return to, and giving J3 Bots its client.
- [Performance](operations/performance.md): the budgets CI holds the web client's first load and a turn's traffic to, how to read and raise them, and checking a query's plan.
- [Releasing](operations/releasing.md): cutting a release of the desktop app and the server, what the release workflow may do, signing, and trying an update or an install locally.
- [The release notes template](releases/TEMPLATE.md): the sections every release's notes have, the order of updating, and the highlights the update prompt shows.
- Release notes, each with what is new, what changes on updating and the known limits:
  - [0.1.0](releases/v0.1.0.md): the first release, what it contains and how to install it.
  - [0.3.0](releases/v0.3.0.md): the bots on your own computer, run by the desktop app.
  - [0.3.1](releases/v0.3.1.md): signed releases, updates from the apps and the nightly channel.
  - [0.4.0](releases/v0.4.0.md): the bot's browser, logins a bot uses without seeing them, connectors and visuals.
  - [0.5.0](releases/v0.5.0.md): a conversation for each pair of bots, teams bots build on your word, events as one line and the first run's motion.
  - [0.6.0](releases/v0.6.0.md): a room is a group where everyone reads, with no host.
  - [0.7.0](releases/v0.7.0.md): a bot brings work to a room from its own conversation, and the apps update themselves as they open.
  - [0.7.1](releases/v0.7.1.md): a bot reads its rooms from any conversation, and a room's talk among its bots is bounded by rounds.
  - [0.8.0](releases/v0.8.0.md): from no harness to a working bot without a terminal, and people's names for bots.
  - [0.9.0](releases/v0.9.0.md): the whole of MCP, apps drawn in the conversation and skills, Secrets with no password, updates that open in front of you, and the first run as a stage.
  - [0.10.0](releases/v0.10.0.md): a first run for someone who has never heard of a harness, Settings that lists what the bots added, the server on Windows, and moving your bots to another server.
  - [0.11.0](releases/v0.11.0.md): a bot's plan and its little ones, failures that say what to do, Force stop, suggested replies, pictures as photos, and quick access on the desktop.
- [The every-surface check](operations/every-surface-check.md): the desktop app and the Android app against one server, run by hand: continuity, cards resolved across devices, the desktop's surfaces, and what it does not prove.

## Engineering

- [Standards](engineering/standards.md): toolchain, code rules, testing policy, pull requests.
- [Contributing](../CONTRIBUTING.md): building and checking a change, the sign-off every commit carries, and how contributions are licensed.

## Decisions

- [Decision records](decisions/README.md)

## Proposals

Changes J3 Bots would like from T3 Code, drafted here. None has been sent.

- [A typed secret in the engine's browser](proposals/engine-browser-secret-input.md): withdrawn, since J3 Bots runs its own browsers ([decision 0110](decisions/0110-j3-bots-runs-its-own-browsers-and-the-engines-is-off.md)).

## Research

- [T3 Code as an engine](research/t3-code.md): what was read and what was verified, with sources.
- [Prior art](research/prior-art.md): the products J3 Bots learns from, and how that material is handled.

## Planning

- [Roadmap](roadmap.md)
- [Open questions](open-questions.md)
