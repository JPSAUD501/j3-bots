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

## Architecture

- [Overview](architecture/overview.md): the pieces and the boundaries between them.
- [Engine](architecture/engine.md): how J3 Bots runs and drives T3 Code without modifying it.
- [Server](architecture/server.md): the domain model, the wake pipeline, rooms, memory and routines.
- [Clients](architecture/clients.md): web, desktop and mobile.
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
- [A Google connector with your own app](operations/connector-google.md) and [a Slack one](operations/connector-slack.md) (drafts): registering the app, the addresses sign-ins return to, and giving J3 Bots its client.
- [Releasing](operations/releasing.md): cutting a release of the desktop app and the server, what the release workflow may do, signing, and trying an update or an install locally.
- [Release notes for 0.1.0](releases/v0.1.0.md): the first release, what it contains, how to install it and what does not work yet.
- [Release notes for 0.3.0](releases/v0.3.0.md), a draft until it is released: the bots on your own computer, what changes on updating and what does not work yet.
- [The every-surface check](operations/every-surface-check.md): the desktop app and the Android app against one server, run by hand: continuity, cards resolved across devices, the desktop's surfaces, and what it does not prove.

## Engineering

- [Standards](engineering/standards.md): toolchain, code rules, testing policy, pull requests.
- [Contributing](../CONTRIBUTING.md): building and checking a change, the sign-off every commit carries, and how contributions are licensed.

## Decisions

- [Decision records](decisions/README.md)

## Research

- [T3 Code as an engine](research/t3-code.md): what was read and what was verified, with sources.
- [Prior art](research/prior-art.md): the products J3 Bots learns from, and how that material is handled.

## Planning

- [Roadmap](roadmap.md)
- [Open questions](open-questions.md)
