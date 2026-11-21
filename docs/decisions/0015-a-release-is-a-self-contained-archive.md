# 0015: A release is a self-contained archive per Linux architecture

**Status:** Accepted

## Context

Until now J3 Bots ran only from a checkout: `git clone`, `pnpm install`, `pnpm build`, then the server bundle in `apps/server/dist/bin.mjs` on the host's own Node ([Running on a Raspberry Pi](../operations/running-on-a-pi.md#install)). That needs Git, pnpm and the right Node release on every host, and a host's Node can change under the service.

The server is already close to runnable on its own. Its production build bundles every dependency into two entry points, `bin.mjs` (the CLI and the server) and `bridge.mjs` (the `j3` MCP bridge each harness starts), with the prompt files copied beside them; SQLite is Node's own; and the bridge and the scripted agent are started with `process.execPath`, the Node that runs the server. What it lacked was a Node that does not depend on the host, a place for the web client that is not the checkout's `apps/web/dist`, and the license notices of what it bundles, which a redistribution must carry.

T3 Code ships its command line as a Node single executable application (**Read** at `db51b67`, `scripts/build-cli-archive.ts`), which needs per-platform fixes and an arm64 page-size check.

## Decision

**A release is one archive per Linux architecture**, `j3-bots-<version>-linux-x64.tar.gz` and `j3-bots-<version>-linux-arm64.tar.gz`, built by `pnpm release` (`scripts/build-release.ts`). Each holds one folder:

```
j3-bots-<version>-<platform>/
  bin/j3-bots           a sh launcher: the Node below, on server/bin.mjs
  node/bin/node         the official Node release J3 Bots pins
  server/               the server bundle, with its prompt files beside it
  web/                  the web client
  release.json          version, platform and Node release: marks the layout
  LICENSE
  THIRD_PARTY_NOTICES
```

Source maps are left out. The launcher resolves its own location, so the folder runs from wherever it is unpacked, also through a link to `bin/j3-bots`, and needs nothing on the host but `sh`. A service installed from it records the archive's Node and bundle, as it records a checkout's.

**Node is pinned in one file.** `engines.node` in the root `package.json` is the exact release that development, CI and the archive use, and `nodeReleaseChecksums` beside it holds the SHA-256 of that release's tarball for each platform. The build downloads the tarball from nodejs.org and refuses one whose digest differs; a new Node release is a change to both fields, and a version without a checksum fails the build.

**The server finds its files by layout** (`apps/server/src/installation.ts`): a `release.json` beside the bundle's folder means a release, whose web client is in `web/`; otherwise it is a checkout, whose web client is in `apps/web/dist`. A `release.json` that does not decode stops the server rather than letting it run as a checkout.

**`THIRD_PARTY_NOTICES` is made from what the bundles hold.** Both builds record, through a plugin (`scripts/bundle-inputs.ts`), every module in their output and every file an asset was emitted from, after tree shaking. Each input is attributed to the package that holds it; J3 Bots' own packages are left out, and for every other one the notices give its name, version, declared license and the license and notice files it ships. A package that declares no license and ships no license file fails the build. Two inputs no bundler records are named by hand: Node itself, whose license comes from its tarball, and Tailwind CSS, whose base styles its compiler writes into the web client's stylesheet without making them a module. The bundlers' own glue code (Rolldown's runtime, Vite's preload helper) is not listed.

**`j3-bots engine fetch`** installs the engine the release is pinned to, as the server's first start would, without starting it, so a new release's engine can be in place before its server starts.

## Consequences

- A host needs no Node, pnpm or Git: unpacking needs `tar`, and running needs `sh`. Installing (P2) adds a downloader and a checksum tool.
- Linux with systemd only, as the service and the engine's provider launch already are. The engine also ships `darwin-arm64`, so macOS stays possible with a launchd unit.
- Each archive is about 50 MB, most of it Node. The same bundles go into both archives; only Node differs.
- A Node upgrade is one change to `package.json`, and CI runs every check and the archive's smoke on it.
- The admin socket's status reply is the one message two releases must both read during an update. It is frozen by stored samples that every later release must decode and write back unchanged (`apps/server/src/admin/protocol.test.ts`): fields may be added as optional, never removed, renamed or narrowed.

## Rejected

**A single executable (Node SEA), as T3 Code does.** J3 Bots has two entry points, a web folder and prompt files beside the bundle, and the bridge must be started as a process. A plain Node binary beside them runs both entries and needs none of the per-platform machinery.

**The host's Node.** It is one fewer thing in the archive, but every host would need the right major release, and an upgrade of the host's Node would change what the service runs without J3 Bots knowing.

**An npm package.** It needs Node and npm on the host and resolves dependencies at install time, where the bundle has already fixed them.

**A container image.** The engine launches each harness in a systemd scope of the user's manager and bots work in the operator's environment; a container would hide both, and the operator's harness sign-ins with them.
