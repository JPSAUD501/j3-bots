# 0015: A release is self-contained: an archive per Linux architecture, and a server runtime in each desktop package

**Status:** Accepted

## Context

Until now J3 Bots ran only from a checkout: `git clone`, `pnpm install`, `pnpm build`, then the server bundle in `apps/server/dist/bin.mjs` on the host's own Node ([Installing J3 Bots: from a checkout](../operations/install.md#from-a-checkout)). That needs Git, pnpm and the right Node release on every host, and a host's Node can change under the service.

The server is already close to runnable on its own. Its production build bundles every dependency into two entry points, `bin.mjs` (the CLI and the server) and `bridge.mjs` (the `j3` MCP bridge each harness starts), with the prompt files copied beside them; SQLite is Node's own; and the bridge and the scripted agent are started with `process.execPath`, the Node that runs the server. What it lacked was a Node that does not depend on the host, a place for the web client that is not the checkout's `apps/web/dist`, and the license notices of what it bundles, which a redistribution must carry.

Local mode (0.3.0) runs the same server as a child of the desktop app, on the person's own computer, on Linux x64 and Windows x64, and on Apple Silicon once it has been tried on a Mac. Electron brings its own Node, but not the release J3 Bots pins: 24.22.1 in Electron 44.10.1, against 26.13.1 (**Verified**). The tool bridge each harness starts is `process.execPath`, which under Electron would start the app again rather than Node.

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
  APP-STORE-PERMISSION
  THIRD_PARTY_NOTICES
```

**Each desktop package carries the server runtime of its platform**, in its resources as `server-runtime/`, for local mode: the AppImage and the deb (`linux-x64`), the Windows installer (`win32-x64`) and the arm64 dmg and zip (`darwin-arm64`). The x64 Mac build carries none: on an Intel Mac the app only connects to a server. The runtime is the archive's folder without `web/`, since the app brings its own web client, and without `bin/j3-bots`, since the app starts Node itself; on Windows its Node is `node/node.exe`:

```
server-runtime/
  node/bin/node         node/node.exe on Windows
  server/
  release.json          its version is the app's
  LICENSE
  APP-STORE-PERMISSION
  THIRD_PARTY_NOTICES   Node, and what the server bundle holds
```

`pnpm release` builds it for `linux-x64` beside that platform's archive, and `pnpm release --server-runtime` alone for any of the three, into `dist/release/server-runtime/<platform>/`. electron-builder copies it into each package, and electron-builder only warns when a folder it is told to copy is missing, so a build hook (`apps/desktop/scripts/afterPack.ts`) fails a package that lacks the runtime its platform needs, carries one of another version or platform, or carries one where local mode does not run. The app copies the runtime out of its resources before it runs it ([Clients: desktop](../architecture/clients.md#desktop)).

Source maps are left out. The launcher resolves its own location, so the folder runs from wherever it is unpacked, also through a link to `bin/j3-bots`, and needs nothing on the host but `sh`. A service installed from it records the archive's Node and bundle, as it records a checkout's.

**Node is pinned in one file.** `engines.node` in the root `package.json` is the exact release that development, CI, the archives and the runtimes use, and `nodeReleaseChecksums` beside it holds the SHA-256 of that release's file for each platform, as nodejs.org publishes it in the release's `SHASUMS256.txt`: the `.tar.xz` for Linux and macOS, the `.zip` for Windows. The build downloads the file from nodejs.org and refuses one whose digest differs before unpacking it; a new Node release is a change to both fields, and a platform without a checksum fails the build. The Windows `.zip` is unpacked in-process (`scripts/zip.ts`), so no `unzip` or `tar` is needed for it.

**The server finds its files by layout** (`apps/server/src/installation.ts`): a `release.json` beside the bundle's folder means a release, whose web client is in `web/`; otherwise it is a checkout, whose web client is in `apps/web/dist`. A `release.json` that does not decode stops every command that needs the release's files, `doctor` included, with only the sentence that says to unpack the release again, rather than letting it run as a checkout.

**`THIRD_PARTY_NOTICES` is made from what the bundles hold.** Both builds record, through a plugin (`scripts/bundle-inputs.ts`), every module in their output and every file an asset was emitted from, after tree shaking. Each input is attributed to the package that holds it; J3 Bots' own packages are left out, and for every other one the notices give its name, version, declared license and the license and notice files it ships. A package that declares no license and ships no license file fails the build. Three inputs no bundler records are named by hand: Node itself, whose license comes from its tarball; Tailwind CSS, whose base styles its compiler writes into the web client's stylesheet without making them a module; and Rolldown, whose runtime helpers it writes into both bundles. Rolldown ships inside `@voidzero-dev/vite-plus-core`, which is listed with its license file, Rolldown's notice among those it carries.

**Installed, a release lives outside the data directory.** `install.sh`, a release asset, unpacks a release into `~/.local/share/j3-bots/versions/<version>/` (`$XDG_DATA_HOME/j3-bots`, or `J3_INSTALL_DIR`) and writes the `j3-bots` command, `~/.local/bin/j3-bots` (or `J3_BIN_DIR`): a three-line `sh` script whose last line runs one version, `exec '<install>/versions/<version>/bin/j3-bots' "$@"`. Where it wrote that command is recorded, one line, in `<install>/launcher`. The data directory, `~/.j3-bots`, holds only what the server keeps, so a version can be replaced, or the installed versions removed (`j3-bots uninstall`), without touching it, and deleting the data never deletes the code that would restore it. A release finds its install from its own path: its folder is in a `versions/` folder, and the folder above that holds the record, `launcher`, which is what makes it an install; a release unpacked anywhere else is not one. A release reaches `versions/<version>/` only by a rename from a staging folder beside it, after its download matched `SHA256SUMS`, so `install.sh` never removes a folder there: one that is not a release is refused and kept. It writes the record before the command, so the command never exists without it. The install folder, its `versions/` and the command's folder must belong to the installing user and be written by no other account, since a release found there is run as it is; their group may write when it is the user's own group, as folders made under `umask 002` allow, whoever else it holds. Every folder above each, up to `/`, on the path as given and on the one its links lead to, must be the user's or root's and written by no other account, unless it is sticky, as `/tmp` is, where only the owner of a folder may move it: otherwise another account could move the checked folder away after the check and put its own in its place, which `ssh`'s `StrictModes` guards against the same way. `install.sh` and `j3-bots update` (`checkOwnFolder` in `apps/server/src/install/layout.ts`) check the same, and say which folder and why. On Windows, where the update judges a folder's access list, the folders above it are not judged. `j3-bots uninstall` removes only what `install.sh` wrote: each folder in `versions/` that holds a `release.json`, the staging folders an interrupted run left there, and the record, then `versions/` and the install folder only if that leaves each empty. It stops and removes the service only when the unit's `ExecStart` runs this install (the recorded command, or a release in its `versions/`), and with `--delete-data` deletes only what the server writes, never `web/`, from a folder a server has used (it holds `server.lock` or `j3.sqlite`).

**`j3-bots engine fetch`** installs the engine the release is pinned to, as the server's first start would, without starting it, so a new release's engine can be in place before its server starts.

## Consequences

- A host needs no Node, pnpm or Git: unpacking needs `tar`, and running needs `sh`. Local mode needs nothing at all: the app runs the runtime it carries. Installing adds `curl` or `wget` and `sha256sum` or `shasum`.
- Linux with systemd only, as the service and the engine's provider launch already are. The engine also ships `darwin-arm64`, so macOS stays possible with a launchd unit.
- Each archive is about 50 MB, most of it Node. The same bundles go into both archives; only Node differs.
- The runtime adds 28 to 48 MB to each desktop package that carries it, also mostly Node, as each package format compresses it differently ([Releasing](../operations/releasing.md#what-a-release-contains) gives each package's size), and the app's web client is not carried twice. The engine is in neither: the server downloads it on first use, 150 to 190 MB, which a person who only connects to a server never needs.
- A Node upgrade is one change to `package.json`, and CI runs every check and the archive's smoke on it.
- The admin socket's status reply is the one message two releases must both read: an update has the old command line read the new server's reply, and a rollback the reverse. Stored samples, which every later release must decode and write back unchanged (`apps/server/src/admin/protocol.test.ts`), check only that the new release reads the old. The old reading the new cannot be tested, since that reader has shipped, so it rests on a rule: a field may be added only as optional, and no field is removed, renamed or changed. Existing unions and literals are closed, because an older reader refuses a value it does not know, so a new value needs a new optional field. The command that waits for an updated server decodes only what it needs from the reply: its `version`, its `pid` and the tag of its engine's state ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)).

## Rejected

**A single executable (Node SEA), as T3 Code does.** J3 Bots has two entry points, a web folder and prompt files beside the bundle, and the bridge must be started as a process. A plain Node binary beside them runs both entries and needs none of the per-platform machinery.

**The host's Node.** It is one fewer thing in the archive, but every host would need the right major release, and an upgrade of the host's Node would change what the service runs without J3 Bots knowing.

**An npm package.** It needs Node and npm on the host and resolves dependencies at install time, where the bundle has already fixed them.

**Electron's own Node for local mode** (`ELECTRON_RUN_AS_NODE`, or a `utilityProcess`). It would add nothing to the packages, but it is another Node release than the one every other J3 Bots server runs and `doctor` checks, and the tool bridge, which each harness starts as `process.execPath`, would start the app instead of Node: the server starts the engine, and through it each harness, with only the variables it allows (`packages/engine-t3/src/t3/Command.ts`), and `ELECTRON_RUN_AS_NODE` is not one of them.

**A container image.** The engine launches each harness in a systemd scope of the user's manager and bots work in the operator's environment; a container would hide both, and the operator's harness sign-ins with them.
