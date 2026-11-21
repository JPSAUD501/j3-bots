# 0016: An update keeps a snapshot to roll back to

**Status:** Accepted

## Context

An installed release is a folder in `<install>/versions/<version>/`, run by the `j3-bots` command, and the service's unit records the real paths of that release's Node and server bundle ([decision 0015](0015-a-release-is-a-self-contained-archive.md)). Moving to another release changes three things at once: the code the unit starts, the engine release it is pinned to, and the databases. Both J3 Bots and the engine migrate their database forward only, on the new release's first start, and an older release cannot use a database a newer one migrated: T3 Code refuses one whose migrations it does not know (**Read** at `db51b67`: `apps/server/src/cloud/servicePreflight.ts:68-77`, from `persistence/databaseMigrationHead.ts`), and J3 Bots used to start on one silently. Going back to a release therefore means going back to its databases too.

## Decision

**The installed release drives the update.** `j3-bots update [--version <version>] [--yes]` is run by the release the command points at, which can always start itself again. It works on the install it runs from: the folder whose `versions/` holds it and which holds the record of the command, `launcher`, wherever `install.sh` put it (`J3_INSTALL_DIR`, `$XDG_DATA_HOME/j3-bots` or `~/.local/share/j3-bots`). A checkout, or a release unpacked anywhere else, is refused. Data stays in the data directory, outside the install, as before.

**Preparing changes nothing the service uses.** The target is the latest stable release, from the releases page's `latest` (asked for JSON), or the one `--version` names. Free space is checked first: twice the files a snapshot copies plus 1 GB where the data directory is, and 512 MB where the install is. The release is fetched as `install.sh` fetches one (`apps/server/src/install/release.ts`): its archive for this platform, checked against the release's `SHA256SUMS`, unpacked into a `.staging-*` folder in `versions/`, run once, then renamed to `versions/<version>/`; a release already there is used as it is, a folder there that is not a release is refused and kept, and the install folder and `versions/` must be this user's and not writable by every account. `J3_RELEASE_BASE_URL` points it at a mirror, as it does `install.sh`. Then the new release's own `j3-bots engine fetch` installs its engine beside the running one. Last, if the service's server says bots have work running (`GET /running-work` on the admin socket), the update asks, or needs `--yes`, since stopping the service stops that work.

**The switch is one uninterruptible sequence** (`apps/server/src/install/switch.ts`):

1. Stop the service and clear its failed state.
2. Copy, with no server running, into `<home>/backups/<time>-<from>-to-<to>/`: `config.json`, `j3.sqlite` with its `-wal` and `-shm`, and the engine's state its adapter names (`statev2.sqlite` with its `-wal` and `-shm`, and the engine's `settings.json`), each at its path relative to the home, with a `manifest.json`: when, both releases and both engine releases, and the migration each database last recorded. Folders are 0700 and files 0600. A copy that fails is removed whole.
3. Run the new release's own `j3-bots service install`, which writes the unit with its own paths and starts it.
4. Wait, five minutes at most, for the service's server to answer as the new version, from the unit's main process, with its engine `ready`. The waiter decodes only `version`, `pid` and the engine state's tag from the status reply, so it reads a newer release's reply, which only adds to it. An engine reported `incompatible`, or a unit that fails, ends the wait at once.
5. Point the command at the new release: the record first, then the command, each written whole under a temporary name and renamed into place, the command in exactly the form `install.sh` writes (`launcherText`), so `uninstall` still recognizes it.

**A new release that never became ready is rolled back by itself.** If step 1 or 2 fails, the old release's `service install` starts it again; the databases were not touched. If step 3 or 4 fails, the service is stopped, every file the snapshot covers is moved out of the home into `replaced-<time>/` in the snapshot's folder (a write-ahead log the new release left must not stay beside a database put back), the snapshot's copies are put back, and the old release's `service install` starts it and is waited for the same way. No turn ran on the new databases, since the new server never answered as ready. If putting the files back fails, the old release is not started on them. Once the new release is ready, nothing is rolled back: a failure to point the command is reported, with the service running the new release.

**The unit is only ever written by a release's own `service install`.** There is no `current` link for the unit to start: the unit names one release's Node and bundle by their real paths, so it always names one release whole, and the switch never leaves it between two.

**`j3-bots update --rollback`** puts back the newest snapshot, if the update that took it installed the release that runs now and the release it came from is still in `versions/`. It says when the snapshot was taken and what is lost, asks (or takes `--yes`), then stops the service, puts the files back as the automatic rollback does, starts the earlier release with its own `service install`, waits for it, and points the command at it.

**Two of everything are kept.** After an update that succeeded: the two releases it moved between, the two newest snapshots, and the engine runtimes of those two releases, which `release.json` now names (`engine`). Nothing else in `versions/`, `backups/` or the engine's runtime folder is removed.

**A release refuses a database a newer one migrated.** On start, J3 Bots refuses a database that records a migration it does not know, naming it, as it already refused one with a gap (`apps/server/src/persistence/Migrations.ts`). Running an older release on a newer database by hand fails with that message, never silently.

**Without a service**, the update copies the files and points the command, refusing while any server runs on the data directory; the operator starts the server.

## Consequences

- A rollback loses what happened after the update in the databases: conversations, rooms, routines and their runs, settings, paired devices, and the engine's threads. Bots' files are not in a snapshot, so their memory and workspaces keep what was written since. Nothing the rollback replaced is deleted: it stays in the snapshot's `replaced-*` folder until that snapshot is pruned.
- A snapshot is about the size of the two databases. The update's free-space check and keeping two of each bound what an update leaves on disk.
- The engine's `settings.json` names the provider endpoint's base URL; the providers' key is in the engine's secret store, which is not copied.
- The check for running work and the stop are not one step: work a bot starts in between is stopped with the service.
- The automatic rollback starts the old release as its `service install` writes it, with the `PATH` and data directory of the unit it replaces.
- The first release that has `update` is the first that can be updated this way; a release from before it is replaced with `j3-bots uninstall` and `install.sh`.

## Rejected

**A `current` link that the unit starts.** The unit would no longer record what it runs, a link swapped under a running service changes its code without a restart, and moving the link does nothing for the databases.

**Copying the whole data directory.** Bots' workspaces, attachments and the engine's runtime are large, and no migration changes them. The snapshot holds what an older release cannot read after a newer one ran, and the settings beside it.

**Copying the databases while the old server runs** (SQLite's online backup). J3 Bots' and the engine's databases must be copied as one consistent pair, and the old server stops for the switch anyway.

**Having the new release drive its own update.** If it cannot start, it cannot restore the release before it. The installed release knows how to start itself.
