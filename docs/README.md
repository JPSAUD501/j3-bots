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
- [Base prompt, v0](prompts/base-prompt.md): the first draft of the text every bot shares.

## Design

- [Design language](design/design-language.md): principles, references, tokens and components.

## Engineering

- [Standards](engineering/standards.md): toolchain, code rules, testing policy, pull requests.

## Decisions

- [Decision records](decisions/README.md)

## Research

- [T3 Code as an engine](research/t3-code.md): what was read and what was verified, with sources.
- [Prior art](research/prior-art.md): the products J3 Bots learns from, and how that material is handled.

## Planning

- [Roadmap](roadmap.md)
- [Open questions](open-questions.md)
