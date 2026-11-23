# Engineering standards

J3 Bots aims for the quality bar of the project it builds on. This document records what J3 Bots adopts from T3 Code's practices, what it adapts, and what it leaves until the project is large enough to need it.

## Toolchain

| Concern | Choice |
| --- | --- |
| Language | TypeScript everywhere |
| Runtime | Node, pinned to one exact version for development, CI and release builds: `engines.node` in the root `package.json`, with the checksum of each release tarball an archive ships beside it |
| Package manager | pnpm, with a version catalog so every package resolves the same version of a shared dependency |
| Task runner, test runner, bundler | Vite+ (`vp`): Vitest for tests, oxlint for lint, oxfmt for format |
| Type checking | The native TypeScript compiler with Effect diagnostics |
| Dead code | knip, for files, dependencies and exports |
| Web | React with the React Compiler, TanStack Router, Tailwind CSS v4 |
| Desktop | Electron |
| Mobile | Expo |

The server stack and the choice of Effect are argued in [decision 0007](../decisions/0007-client-and-server-stack.md).

## TypeScript

The compiler runs with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax` and `erasableSyntaxOnly`.

- **`any` is not used.** Not in application code, not in tests, not to quiet an error.
- **No unchecked cast at a boundary.** Data that crosses a process, a network or a file is decoded with a schema, and the decoded type is the only one the rest of the code sees.
- **Inferred types over annotations**, except on exported functions and at boundaries.
- **A suppression carries its reason** on the same line.
- **Time, randomness and ids come from injected services**, never from globals, so tests control them.

## Structure

**Contracts are the only wire boundary.** `packages/contracts` defines every request, event, entity and error exchanged between the server and its clients. It contains schemas and types, and no logic.

**One package knows the engine.** `packages/engine-t3` implements the engine adapter. Nothing outside it imports a T3 Code type, a T3 Code path or a T3 Code identifier format. The rest of the server speaks to an interface in J3 Bots' own terms. This is what keeps an engine upgrade a contained change.

**Server features are services; transports are thin.** A capability is a method on its domain's service. A handler for a client request, a bot tool call or a webhook does three things: decode, call one service method, map the typed errors. That way every entry point reaches the same behavior.

**Errors are typed and structured.** A service method's failure modes are part of its signature. An error's message is fixed or built from its own fields, never from an underlying cause, and it never contains secrets or payloads.

**Durable intent before side effects.** Anything that must not be lost or done twice (a wake, a delivered message, a routine run) is written to the database first, then acted on, with an idempotency key on the action.

**The UI stays dumb.** Components render state and emit intent. A decision two clients share lives in `packages/client-runtime`.

**Complexity belongs at the edges.** Provider quirks stay in the engine. Engine quirks stay in the adapter. The domain stays plain.

## Testing

Test behavior that can break.

**Worth testing:** the wake pipeline (ordering, coalescing, budgets, idempotent dispatch), room routing, the scheduler, envelope rendering and its escaping, memory operations, the adapter's translation of engine events, reconnect and resume, authorization.

**Not worth testing:** what the type checker already guarantees, trivial getters and mappers, copy text, mocks asserting they were called, components rendered to static markup, and **the absence of something that was removed**. When a feature is deleted, its tests are deleted with it.

Rules:

- **One layer.** A behavior is tested at the lowest layer where a regression would show.
- **Extend before adding.** A new case in an existing test beats a new test file.
- **Real collaborators.** Test doubles stand in only for a process, the network, the clock, randomness or the filesystem.
- **No sleeping.** Tests advance a test clock and wait on durable signals. No timeouts, no polling loops, no retries. A flaky test is fixed, not retried.
- **A bug fix starts with a failing test** for logic, and with a before-and-after capture for anything visual.

Two suites matter more than the rest:

- **Engine conformance.** `packages/engine-t3` is tested against a real, isolated T3 Code server at the pinned version. This suite is what makes an engine upgrade safe. See [Engine](../architecture/engine.md#upgrading-the-engine). Everything above the adapter is tested against `@j3-bots/engine-t3/testing`, an in-memory engine that keeps the adapter's contract and has tests of its own for the parts callers rely on.
- **Prompt evals.** Prompt changes are behavior changes. See [Prompt architecture](../prompts/architecture.md#evaluation).

## Changes

- **One problem per pull request**, including everything that problem needs across layers.
- **Sign-off.** Every commit carries a `Signed-off-by` line from its author, which certifies the Developer Certificate of Origin ([CONTRIBUTING.md](../../CONTRIBUTING.md#sign-off)). CI refuses a pull request with a commit that lacks one.
- **License identifiers.** Every first-party source file starts with `SPDX-License-Identifier: AGPL-3.0-or-later` ([decision 0008](../decisions/0008-license.md)). `pnpm lint` checks it; vendored upstream source keeps its own license.
- **Title:** a conventional-commit prefix and plain language that says what changed for the person using it: `fix(mobile): a held message is sent once after reconnect`.
- **Body:** the problem in a sentence or two, then how it was fixed, then how it was verified. "Tests pass" is not verification.
- **Interface changes** include before-and-after images; motion includes a short capture.
- **Hit every surface.** A change to something the operator can do is checked on web, desktop and mobile, in both themes, and for the reverse action: anything that can be turned on can be turned off.

## Documentation

- Documentation records decisions, constraints and traps. It does not narrate the code.
- When a decision changes, the text is rewritten. A second account is never appended.
- Expensive decisions get a short record under `docs/decisions`.
- Plans and scratch files are not committed.

## Interface text

- English is the source language. Every string goes through the translation layer from the first screen.
- A sentence is translated whole. It is never assembled from fragments.
- Portuguese is the first additional language.

## Not adopted yet

T3 Code runs machinery that is right for its size and too much for a new project. J3 Bots starts without it and adds each piece when its absence starts to cost something:

- a full event-sourced core with projections and replay; J3 Bots uses plain tables plus a durable queue for the few things that need it;
- dozens of custom lint rules; J3 Bots starts with a handful (only `packages/engine-t3` may import T3 Code, which is in place; suppression reasons, wall-clock use in tests, restyling of `ui` components, untranslated text);
- a compiler-coverage gate, a remote task cache, multiple release channels;
- contribution automation (size labels, limits, vouching).

## Releases

One version number for the whole repository. Each release names the exact engine version it was tested with, and that pairing is the unit of support.

A release is one archive per Linux architecture that carries its own Node, built by `pnpm release` ([decision 0015](../decisions/0015-a-release-is-a-self-contained-archive.md)). CI builds the archive for x64 and arm64 on every pull request and runs it with no Node on `PATH`: `doctor`, the server, its web client and one bot turn on the pinned engine, through the scripted agent. It then installs the archive with `scripts/install.sh` from a local mirror of a release and removes it with `j3-bots uninstall --delete-data`. A version tag builds the same archives with the tag's version, runs the same checks on them and publishes them with `SHA256SUMS` and `install.sh` ([Releasing](../operations/releasing.md)). The desktop packages carry the server runtime of their platform for local mode, the same Node and bundle without the web client. CI builds them on Linux, macOS and Windows on every pull request, as a tag does, and runs each runtime where it was packaged: its Node, and the server on it.
