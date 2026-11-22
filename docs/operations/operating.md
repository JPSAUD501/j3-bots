# Operating J3 Bots

Day-to-day care of a J3 Bots server that [Installing J3 Bots](install.md) set up: its configuration, the service, logs, updates, backups and removal. Every command here runs on the server's machine, as the user that runs the service. For a [dedicated user](install.md#choose-the-user-it-runs-as), that is a `sudo -iu` shell with `XDG_RUNTIME_DIR` set as shown there: without it, `update`, `--rollback` and `uninstall` find no systemd manager and refuse.

## Configuration

`~/.j3-bots/config.json` holds the settings. The server writes it with every setting at its default on its first start, and never rewrites it after that:

```json
{
  "host": "lan",
  "port": 3737,
  "toolPort": 3739,
  "enginePort": 3738,
  "webClient": null,
  "tls": null,
  "publicOrigin": null
}
```

| Setting | What it does |
| --- | --- |
| `host` | Where the server listens. `"lan"` serves every IPv4 address of the machine, as long as each one is private (a home network, Tailscale), and refuses to start while any is public. It closes, unread, a connection that reaches it on an address that is not private, such as one that appears after it started. An IP address instead must be one the machine has when the service starts at boot, or the start fails; `lan` has no such dependency. |
| `port` | The port browsers and apps reach the server at. |
| `toolPort`, `enginePort` | Loopback ports for the bot tools and the engine. Change them only when another program holds them. |
| `webClient` | A web client folder to serve instead of the one the release carries. |
| `tls` | `{ "cert": "<file>", "key": "<file>" }` to serve HTTPS ([Exposing: HTTPS](exposing.md#https-with-your-own-certificate)). |
| `publicOrigin` | The `https` address other machines reach the server at through a proxy or a tunnel ([Exposing: publicOrigin](exposing.md#publicorigin)). |

Relative paths resolve against the data directory. Edit the file, then restart the service:

```sh
systemctl --user restart j3-bots
```

An unknown key or an invalid value stops the start with a message that names it; `j3-bots doctor` shows the same before you restart. The full reference, with the environment variables that override each setting for `j3-bots serve`, is in [Server: configuration](../architecture/server.md#configuration).

The service does not see `J3_*` variables from your shell, nor from the user manager's environment (the unit unsets them): it runs with `config.json` alone. `doctor` warns about each one set in your shell while the service is installed. Put lasting settings in `config.json`.

## The service

```sh
j3-bots service status
systemctl --user status j3-bots
systemctl --user restart j3-bots
```

The unit is `~/.config/systemd/user/j3-bots.service`. `j3-bots service install` writes it; run that command again, never edit the unit by hand. It records:

- the Node and the server bundle of the release that ran it (for a checkout, the real path of the Node that ran it);
- the `PATH` of the shell you ran it from, so the engine finds the harnesses. Each folder is recorded by its real path, and folders under `XDG_RUNTIME_DIR`, such as the per-shell links fnm makes, are left out because they are gone after a reboot.

So after you install a harness in a folder that was not on that `PATH`, `doctor` warns that the service does not find it, and gives the command that installs the service again with that `PATH` and the same data directory, `J3_HOME=<data directory> j3-bots service install`, to run from a shell that has the harness ([A harness the service does not find](install.md#a-harness-the-service-does-not-find)).

What the unit does:

- **Restarts.** `Restart=on-failure` restarts the server five seconds after it fails. systemd allows five starts in five minutes, and counts every start, by hand or by restart. Past that it stops trying, and for the rest of those five minutes refuses to start the service, even once the cause is fixed. `doctor` then reports the service as failed. Read why with `journalctl --user -u j3-bots -n 100`, clear the limit with `systemctl --user reset-failed j3-bots`, then run `systemctl --user restart j3-bots`.
- **Memory.** `MemoryHigh` is 60% of the machine's memory. Above it, the kernel reclaims the service's memory first, which leaves room for the rest of the system. It covers the server and the engine. The harnesses the engine starts run in systemd scopes of their own, so it does not limit them. It needs the kernel's memory controller, which `doctor` checks ([Raspberry Pi](install.md#raspberry-pi)).
- **Stop.** systemd sends SIGTERM to the server alone (`KillMode=mixed`), and the server stops the engine and its children itself, within about 17 seconds: 5 for open requests, 2 for open WebSockets, 10 for the engine. After 30 seconds (`TimeoutStopSec`) systemd kills whatever is left. The server exits with status 130 on SIGTERM, which the unit counts as success, so a clean stop does not leave the unit failed.

## Logs

```sh
journalctl --user -u j3-bots -f          # follow
journalctl --user -u j3-bots -n 200      # the last 200 lines
```

The server writes one JSON object per line: wakes, dispatches and outcomes with identifiers, not message text. If `journalctl --user` shows nothing, the journal is not stored on disk; run `sudo mkdir -p /var/log/journal` and `sudo systemctl restart systemd-journald`.

## Update and roll back

```sh
j3-bots update                    # to the latest release
j3-bots update --version 0.2.0    # to this one, a pre-release included
```

The release you have installed runs the update, so it can always start itself again; how and why is in [decision 0016](../decisions/0016-an-update-keeps-a-snapshot-to-roll-back-to.md). It works only on an install `install.sh` made: a checkout is updated [by hand](#from-a-checkout). Nothing the service uses changes while it prepares:

1. It checks for free space: twice the size of the databases plus 1 GB where the data directory is, and 512 MB where the install is.
2. It prints `Downloading J3 Bots <version>…`, downloads the release for this machine, checks it against the release's `SHA256SUMS` as `install.sh` does, and unpacks it into `~/.local/share/j3-bots/versions/<version>/`. Then it downloads the engine that release is pinned to, beside the running one.
3. If bots have work running, it asks before it stops it: `1 bot has work running, and the update stops it. Update now?` Answering no changes nothing. `--yes` answers for a script; without a terminal to ask on, the update is refused unless it is given.

Then it prints `Stopping the service, copying the databases, and starting J3 Bots <version>…`. It copies J3 Bots' database, the engine's and the settings into a snapshot in `~/.j3-bots/backups/`, readable by you alone, and starts the new release as the service. When the new server answers and its engine is ready, it points the `j3-bots` command at the new release and says so. An update from 0.1.0 to 0.2.0, on a test machine:

```text
$ j3-bots update
Downloading J3 Bots 0.2.0…
J3 Bots 0.2.0 is checked and unpacked in /home/j3bots/.local/share/j3-bots/versions/0.2.0.
Installing T3 Code, the engine, into /home/j3bots/.j3-bots/engine…
T3 Code 0.1.11 was already installed: /home/j3bots/.j3-bots/engine/j3/runtime/0.1.11/t3
Stopping the service, copying the databases, and starting J3 Bots 0.2.0…
J3 Bots 0.2.0 runs, and its engine is ready. 0.1.0 and the databases as they were are kept: `j3-bots update --rollback` puts them back.
Snapshot: /home/j3bots/.j3-bots/backups/20261122T000345Z-0.1.0-to-0.2.0. The two newest snapshots are kept; an older one is removed with what its rollbacks replaced, in its replaced-* folders.
```

Without the service installed, it starts nothing: it points the command at the new release and says to start it with `j3-bots serve`.

It keeps the release before, the two newest snapshots and the engines of those two releases, and removes older ones. It carries on if your terminal hangs up, as when an SSH connection drops. Only one update or rollback runs at a time: a second one is refused at once and changes nothing, and so is `j3-bots uninstall`. A server you started yourself with `j3-bots serve` makes the update refuse before it stops anything.

**A failed update rolls back by itself**, says what failed, and exits with an error:

- If stopping the service or copying the databases fails, it starts the release before again, on databases it did not change: `J3 Bots <old> runs again; the databases were not changed.`
- If the new release does not answer within a minute, or its engine is not ready within five, it puts the release before and the databases from the snapshot back and starts the release before: `J3 Bots <old> runs again, on the databases as they were before the update.` The new server may have accepted a message while the update waited for its engine; what it recorded then is not in the databases put back, and is kept in the snapshot's `replaced-*` folder.
- If bringing the release before back fails too, it says so, with where the databases as they were are kept; when that left a rollback unfinished, it says that `j3-bots update --rollback` finishes it, as for a rollback cut off (below).

The release it fetched and the snapshot stay on disk until a later update succeeds.

**To go back** after an update that worked:

```sh
j3-bots update --rollback
```

It says when the snapshot was taken and what is lost, and asks first (`--yes` answers for a script). The databases go back to that moment: conversations, rooms, routines, settings, paired devices and the engine's threads since then are lost. Bots' files on disk, their memory included, are not in the snapshot and stay as they are. Neither are provider keys, which stay in the engine's secret store: the providers' endpoints go back to the snapshot's, with the keys you have now, so run `j3-bots provider connect` again if you changed a provider since the update. What the rollback replaced is kept in the snapshot's `replaced-*` folder until an update removes that snapshot. It starts the release the snapshot was taken from and points the command at it. `j3-bots doctor` names the snapshot it would put back.

**Keep `~/.j3-bots/backups/` on the data directory's filesystem**, not as a link to another disk, such as a USB drive on a Raspberry Pi. A rollback moves the data directory's files into it by renaming them, which cannot cross filesystems. An update and `--rollback` check this before they stop anything, refuse when it is elsewhere, and give the commands that put it back.

**A rollback cut off** by a power cut or `kill -9` stays marked until it finishes: no server starts on the data directory, since the server refuses to while the mark is there, and `j3-bots update` refuses to run. `j3-bots doctor` then reports it as a problem, with one fix, while Server, Service and Command wait for it. After a rollback killed on a test machine:

```text
✗ Snapshot        A rollback to J3 Bots 0.1.0, from /home/j3bots/.j3-bots/backups/20261122T000400Z-0.1.0-to-0.2.0, has not finished. Until it does, the service stays disabled and no other release may run on the data directory.
                  Fix: Run `j3-bots update --rollback`, which finishes it.
- Server          Waits for the rollback to finish: see Snapshot.
- Service         Waits for the rollback to finish: see Snapshot.
- Command         Waits for the rollback to finish: see Snapshot.
```

`j3-bots update --rollback` carries on from where it stopped. An update cut off the same way leaves the service on one release whole; when the `j3-bots` command runs another one, `doctor` says so under Command, with the fix `j3-bots update --version <the service's release>`, which points the command at the release the service runs.

A release refuses a database a newer release migrated, naming the migration it does not know, so starting an older release by hand on newer data fails: roll back instead.

### From a checkout

A checkout keeps no snapshot: [back up](#back-up) first.

```sh
cd ~/j3-bots
git pull
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart j3-bots
j3-bots doctor
```

The server migrates its database when it starts, and downloads the engine its code pins on its first start when that changed.

## Back up

Everything J3 Bots keeps is in the data directory: the configuration, the database, the bots' memory and workspaces, attachments and the engine's own data. Stop the service while you copy it, so the database and the files match:

```sh
systemctl --user stop j3-bots
(umask 077 && tar -C ~/.j3-bots --exclude=./engine/j3/runtime --exclude=./admin.sock \
  -czf ~/j3-bots-$(date +%F).tar.gz .)
systemctl --user start j3-bots
```

`umask 077` creates the archive readable by you alone from the start. Keep it where only you can read it: it holds the bots' files, the device tokens' hashes, the provider key in `engine/userdata/secrets`, and `engine/j3/credential.json`, the credential the server signs in to its engine with, which lets whoever has it start agents with full access. `engine/j3/runtime` is the downloaded engine, which the server downloads again. The archive includes `backups/`, the snapshots `j3-bots update` took; add `--exclude=./backups` to leave them out.

## Restore

```sh
systemctl --user stop j3-bots
mv ~/.j3-bots ~/.j3-bots.before-restore
mkdir -m 700 ~/.j3-bots && tar -C ~/.j3-bots -xzf ~/j3-bots-<date>.tar.gz
systemctl --user start j3-bots
j3-bots doctor
```

Restore onto the version the backup was taken with, or a newer one. Once `doctor` shows the server and the engine ready and your conversations are back, delete `~/.j3-bots.before-restore`.

## Remove

```sh
j3-bots uninstall
```

This undoes `install.sh` and removes only what it wrote: it stops the service, disables it and deletes its unit, then deletes the `j3-bots` command, each version in `~/.local/share/j3-bots/versions/` and the record of the command, and then each of those two folders if that leaves it empty. Anything else you put in those folders is kept.

The data directory stays, and the command names it. To delete J3 Bots' data too:

```sh
j3-bots uninstall --delete-data
```

It asks before it deletes; `--yes` answers for a script. It deletes every entry the server writes in the data directory ([Server: data](../architecture/server.md#data)), and then the data directory if that leaves it empty. A folder no server has used, with no `server.lock` or `j3.sqlite`, is not touched. A web client you put in its `web/` is kept, and so is a file of yours in it. When the data directory is a link, the link and the folder it points to are kept.

`uninstall` refuses, and removes nothing, while `j3-bots update` or `--rollback` runs. With `--delete-data`, it also refuses while a server it does not stop runs for that data directory, such as one started with `j3-bots serve`. A unit that runs another J3 Bots, such as a checkout, is kept, and `uninstall` says so. A release you unpacked yourself, or a checkout, is not an install: `uninstall` refuses it; `j3-bots service uninstall` removes its service and keeps the data directory, and the rest is yours to delete.

If you made a [dedicated user](install.md#choose-the-user-it-runs-as) for J3 Bots, remove it afterwards, from your own account. Its systemd manager keeps running for a few seconds after lingering is turned off, and `userdel` refuses a user with running processes, so stop the manager first:

```sh
sudo loginctl disable-linger j3bots
sudo systemctl stop "user@$(id -u j3bots).service"
sudo userdel -r j3bots
```
