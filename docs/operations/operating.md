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

## The server the desktop app runs

When the desktop app runs the bots on this computer, it runs the server itself, as a child of the app, instead of the service ([Clients: Desktop](../architecture/clients.md#desktop)). Nothing of it is installed: no unit, no `j3-bots` command, no `~/.j3-bots`. Its files are under the app's profile, `<userData>`: `~/.config/J3 Bots` on Linux, `%APPDATA%\J3 Bots` on Windows, `~/Library/Application Support/J3 Bots` on macOS (`J3 Bots Development` for a development build).

| Path | What |
| --- | --- |
| `<userData>/server/home` | Its data home (`J3_HOME`), with its own `config.json`, database and keys. Only this user may open it. |
| `<userData>/server/server.log` | Everything it writes, both streams, appended at each start. Moved to `server.log.1` past 10 MB. The server writes it directly, so it is complete even when the app died first. |
| `<userData>/server/server.pid` | Windows only: the last server started, for the next run to end if it was left behind. |
| `<userData>/server-runtime/<version>` | The Node and server bundle of each release it ran, copied out of the app. Once an update of them works, the two it moved between are kept. On Windows it runs from `current`, a copy of the release that runs. |

- **Logs.** Read why it stopped with `tail -n 100 "$HOME/.config/J3 Bots/server/server.log"`. The server's own lines are JSON, one per line, as in the journal; a refused start ends with its message in plain text. The app shows the last lines it wrote when it stops or is refused.
- **Restarts.** A server that stops on its own is started again after 1 s, doubled each time up to 30 s, and counted as a first stop again after a minute of running. A start the server refuses (exit status 78) is not: the app shows the message, which says how to repair it, and **Try again** starts it once the cause is fixed.
- **Stop.** Quitting the app stops the server: it is asked on its admin pipe, sent SIGTERM where that fails, and killed after 30 seconds. Closing the window does not: in this mode the app stays in the tray. If the app is killed, the server sees its stdin end and stops by itself.
- **Updates.** An update of the app brings the next release of its server, and the first start of it moves the bots' data to it as `j3-bots update` does ([below](#update-and-roll-back)). The app stops the server that ran, copies the databases into a snapshot in `<userData>/server/home/backups/`, and starts the new release, while the connection line says `Updating your bots to <version>…`. Once the new release answers with its engine ready, the app records it and keeps two of everything: the runtimes of the two releases, the two newest snapshots and their engines. If the new release does not get ready, the app puts the snapshot back and starts the release before, from the runtime it kept. The line then says `The update to <new> didn't work. Your bots are back on <old>.`, with **Try again**, and **See details** for the new release's reason and last lines. Once it put the data back, the app does not try that release by itself again, even when it is opened again, until **Try again**; an update that failed before it moved anything, as when the snapshot could not be taken, is tried again at the next start. An app older than the release the data was last handed to runs that release, from its kept runtime, and says to update the app. Quitting waits for an update under way to end. One the system cut short, such as the app killed or a power cut, is carried on at the next start, or its rollback finished.
- **Its ports.** Choosing this computer picks three free ports from 3747 up and writes them to the home's `config.json`, listening on loopback only. The file is not rewritten, so a port taken later by another program refuses the start (exit status 78) rather than move the server, and the app shows which port and where it is set. Free the port, or change `port` in that file; the app then refuses the start, since the page is kept on the old port, until its settings stop using this computer and choose it again, which signs it in at the new address. A `config.json` the app or the server cannot read is refused the same way, never replaced: give this user read access to it, or delete it to have it written again, on the port the app keeps.

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

It says when the snapshot was taken and what is lost, and asks first (`--yes` answers for a script). The databases go back to that moment: conversations, rooms, routines, settings, paired devices and the engine's threads since then are lost. Bots' files on disk, their memory included, are not in the snapshot and stay as they are. Neither are the secrets and their key, which stay as they are; a release older than the secrets' file reports it as written by a newer release and leaves it alone until you update again. An ask for a secret you answered since the snapshot shows as waiting again while the secret stays saved: decline it rather than save the secret twice. Nor are provider keys, which stay in the engine's secret store: the providers' endpoints go back to the snapshot's, with the keys you have now, so run `j3-bots provider connect` again if you changed a provider since the update. What the rollback replaced is kept in the snapshot's `replaced-*` folder until an update removes that snapshot. It starts the release the snapshot was taken from and points the command at it. `j3-bots doctor` names the snapshot it would put back, or says it waits for the command, as below. When the command runs another release than the service, as a rollback killed after it finished and before it pointed the command leaves them, it puts nothing back, since the snapshot it would find is an older update's: it says so, with the fix `j3-bots update --version <the service's release>`.

The browser bots use keeps its profile, with the sites you signed in to, outside the snapshot, so a rollback leaves it as it is. The release you go back to may run an older version of that browser, which may not open a profile a newer version wrote; it then starts with an empty one, signed out of every site, and you sign in again. Rolling back to 0.3, from before each bot had a browser switch, gives every bot the browser again: the engine's settings go back to 0.3's, which leave it allowed everywhere.

**Keep `~/.j3-bots/backups/` on the data directory's filesystem**, not as a link to another disk, such as a USB drive on a Raspberry Pi. A rollback moves the data directory's files into it by renaming them, which cannot cross filesystems. An update and `--rollback` check this before they stop anything, refuse when it is elsewhere, and give the commands that put it back.

**A rollback cut off** by a power cut or `kill -9` stays marked until it finishes: until the snapshot is back whole no server starts on the data directory, and then only the release it rolls back to, since the server refuses to while the mark is there, and `j3-bots update` refuses to run. A server that ran already, as when the rollback was killed before it stopped the service, runs on until a rollback stops it. `j3-bots doctor` reports the rollback as a problem, with its fix; Server, Service and Command say what they find, and one that finds something wrong waits for the rollback instead of giving a fix of its own. After a rollback killed while it copied the snapshot, the service disabled, it reads:

```text
✗ Snapshot        A rollback to J3 Bots 0.1.0, from /home/j3bots/.j3-bots/backups/20261122T000400Z-0.1.0-to-0.2.0, has not finished, and has put none of it back. Until it does, no server starts on the data directory.
                  Fix: Run `j3-bots update --rollback`, which finishes it. If it fails every time, as when a file of the snapshot is lost, `j3-bots update --rollback --abandon` gives it up and starts J3 Bots 0.2.0 again on the data as it is.
- Server          The server is not running. Waits for the rollback to finish: see Snapshot.
- Service         The service is installed but inactive. Waits for the rollback to finish: see Snapshot.
✓ Command         j3-bots runs J3 Bots 0.2.0, as the service does.
```

`j3-bots update --rollback` carries on from where it stopped. An update cut off the same way leaves the service on one release whole; when the `j3-bots` command runs another one, `doctor` says so under Command, with the fix `j3-bots update --version <the service's release>`, which points the command at the release the service runs.

**A snapshot that cannot be put back**, as when a file of it was lost to a failing SD card, stops the rollback while it copies, every time, before it has changed the data directory. Give the rollback up instead:

```sh
j3-bots update --rollback --abandon
```

It says what it does and asks first (`--yes` answers for a script). The data directory is as the release the snapshot was taken for left it, so that release is recorded as the one that runs, the rollback's mark is removed, and that release starts as the service again, with the command pointed at it. Nothing in the data directory changes, and the snapshot stays in `backups/`. It refuses once the rollback has put any of the snapshot back, and when the mark that says how far it got cannot be read once the rollback had begun to swap the snapshot in, which a `replaced-*` folder in the snapshot's folder shows: then only finishing it makes the data whole. When that swap had begun and a file of the snapshot is lost too, neither command can go on; the snapshot's `replaced-*` folders hold what each swap moved out of the data directory, at its path there.

A release refuses a database a newer release migrated, naming the migration it does not know, so starting an older release by hand on newer data fails: roll back instead.

An update records in `~/.j3-bots/state/runtime.json` the release that runs: before the new release starts, the update itself, pending, with its snapshot; then the new release once it is ready, or after a rollback the release rolled back to, and the one it rolled back from. The service does not read it: the unit names the release it runs. An update cut off before the new release was recorded, by a power cut or a failure to write the file, stays pending: `j3-bots update --version <new>` carries it on from the release before, with the same snapshot, and records it. An update to any other release first rolls the cut-off one back to the release before, with that snapshot, and says so, then updates from there. A rollback whose record cannot be written stops with its mark kept: `j3-bots update --rollback` starts the earlier release again and records it, without copying the snapshot again.

### From a client

A client can update the server too. When the server finds a newer release ([Server: release feed](../architecture/server.md#release-feed)), every paired client opens the update prompt in front of the app, with the version, the release's highlights and "Update now" ([Clients: the update prompt](../architecture/clients.md#the-update-prompt)). "Later" puts it away for a day, and a line in the roster's footer, or over the roster on the phone, brings it back.

"Update now" updates the server first and the client after it ([decision 0051](../decisions/0051-an-update-asks-in-front-and-goes-server-first.md)):

1. The server's update is this same `j3-bots update`, run for you ([Server: updating from a client](../architecture/server.md#updating-from-a-client)). It asks before it stops bots' work, as the command does.
2. The client follows it through the restart and waits until the server answers on the new release.
3. Only then does the client update itself. The desktop app downloads, verifies and restarts, the Android app installs, and a browser reloads.

If the server's update does not end on the new release, nothing else happens. The prompt says why and offers "Try again": it rolled back, and why, or the rollback itself failed and `j3-bots update --rollback` finishes it. Every other client shows how it ended too.

It needs what the command needs, and two things more, since the update stops the service it was asked through and so runs beside it, as a unit of your systemd user manager:

- **The service started the server.** A server you run with `j3-bots serve` is updated by hand.
- **`systemd-run`**, which comes with systemd.
- **Lingering**, so your user manager, and the update with it, carries on when you log out: `sudo loginctl enable-linger "$(id -un)"`, once. Without it, a client says the server cannot update itself and shows that command.

The server the desktop app runs is updated with the app ([above](#the-server-the-desktop-app-runs)); a client says so instead of offering an update.

Each update runs as `j3-bots-update-<id>.service`, as you, with your service's environment, `J3_RELEASE_BASE_URL` and `J3_RELEASE_PUBLIC_KEY` included, and is removed when it ends. What it printed stays in the journal:

```sh
journalctl --user -u 'j3-bots-update-*'
```

Where it stands, and how the last one ended, are in `~/.j3-bots/state/update.json`, which the server reads after the restart. Only one update runs at a time, from a client or a shell: while one runs, the other is refused.

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

## The browser

A bot uses the engine's browser only once you turn on **Browser: use this computer's browser** in its details. Turning it on applies from the bot's next turn. Turning it off takes effect now: the bot's work is stopped, as **Stop** stops it, and the browser is taken from every thread of the bot's project, its delegated tasks and any other agent's thread there included, so nothing that runs there afterwards has it. The engine downloads the browser, about 130 MB, the first time a bot uses it.

On Linux the browser needs three things from the system: a sandbox the system allows (on Ubuntu 23.10 and later, AppArmor blocks it until a profile allows it), the shared libraries it loads, and fonts. `j3-bots doctor` checks them under Browser, and the bot's details say when this computer still needs setting up. `doctor` prints the commands that fix what is missing, for someone who can use `sudo` to run once. On Ubuntu with everything missing, they are:

```sh
printf '%s\n' '# Lets the J3 Bots engine'\''s headless browser use Chrome'\''s sandbox.' … | sudo tee /etc/apparmor.d/t3-chrome-headless-shell > /dev/null
sudo apparmor_parser -r /etc/apparmor.d/t3-chrome-headless-shell
sudo apt-get update
sudo apt-get install -y --no-install-recommends libnss3 libglib2.0-0t64 … fontconfig fonts-liberation
```

The first writes the AppArmor profile that lets the browser J3 Bots' engine downloads make the user namespace its sandbox needs, and nothing more; `doctor` prints it in full, to read before you run it. On Fedora, the libraries and fonts come from `dnf` instead, and on a system with neither `apt-get` nor `dnf`, `doctor` names what to install with its package manager. As root, these commands run only the system's own tools, from folders only root can change: `tee`, `apparmor_parser` and the package manager. Nothing that the account J3 Bots runs as can change runs as root, which is why the fix is not the engine's own `browser setup` command: it does the same, but it is a file in J3 Bots' data directory. J3 Bots never runs `sudo` itself. The libraries are known only once the browser is downloaded, so run `doctor` again after a bot first used it. A profile on disk that the system has not loaded, as on a computer restored from an image, shows only when the browser starts: open the bot's browser once, and the bot's details then say the computer needs setting up, and `doctor` prints `sudo apparmor_parser -r /etc/apparmor.d/t3-chrome-headless-shell`, which loads it. A bot whose own use of the browser fails this way does not tell the details so. Chrome refuses its sandbox to root: run J3 Bots as a [user of its own](install.md#choose-the-user-it-runs-as), not as root.

**Sign out of all sites**, in Settings under Bots' browser, deletes the engine's `default` browser profile, the one every bot's browser uses: you are signed out everywhere, for every bot, and its open tabs close. A profile made in the engine's own console is left alone.

## Secrets

Secrets keep the logins and values you type for bots, and what connectors need to reach their services, in `~/.j3-bots/vault/vault.sqlite`, sealed under a key the server keeps beside it, `~/.j3-bots/vault/key` ([Server: secrets](../architecture/server.md#secrets)). There is no password and nothing to unlock: they work from the server's start, also after an update or a reboot.

- **Add one** in Settings → Secrets, or on the card a bot shows when it asks for one. A bot never sees a value: it uses the secret by its reference, `secret:<name>`, and only if the secret lets that bot use it. A secret a bot asked for is that bot's until you widen it, in Settings → Secrets, to more bots or every bot.
- **A bot signs in with a login** when the login allows it and its browser is on. The server types the login into the bot's browser tab when the bot asks, without asking you each time. Each fill shows in the bot's work. What a page could still do with it is in [Security: filling a login](../architecture/security.md#filling-a-login).
- **The key file opens everything**, for whoever has it with the secrets' file, and any program running as the server's user can read it, a bot's shell included. Keep it out of copies you hand around ([Back up](#back-up)), and keep the server to a [dedicated user](../architecture/security.md#running-on-a-machine-that-matters) on a computer that matters. What that leaves open is in [Security: the operator's secrets](../architecture/security.md#the-operators-secrets).
- **Coming from a vault with a master password** (before 0.9.0): Settings → Secrets asks for that password one last time. From then on the server keeps the key itself and never asks again. Until you type it, no connector that needs a secret can reach its service, and no login can be filled. Each login gets a name from its old label, such as `github-work`, which you can change.
- **If Settings says the secrets can't be read**, the key file is missing or is another one. The server changes nothing meanwhile: stop it, put `vault/key` back from your backup (readable by you alone: `chmod 600`), and start it again.
- **If Settings says something does not open**, the secrets' file was changed or damaged. The server's log names the record. Restore the `vault` folder, file and key together, from a backup.
- **To start over with no secrets**, as when an old vault's password is lost, or the key is: stop the service, move the folder aside and start again:

  ```sh
  systemctl --user stop j3-bots
  mv ~/.j3-bots/vault ~/j3-bots-vault.lost-$(date +%F)
  systemctl --user start j3-bots
  ```

  The secrets are then empty. Add each login again. A connector kept its address, its keys and its sign-in among the secrets, so each one lost them too: remove it from its page and add it again, with the address or command and any key or app it was given. Keep the moved folder if you might find the password or the key: putting it back as `~/.j3-bots/vault` while the service is stopped brings everything back. It goes outside the data directory so that no backup of it takes the folder with its key.

## J3 Bots' own harnesses

When it does not find Claude Code or Codex, the server can install its own copy, from the harness's maker, when you press **Install** ([Install: when the engine cannot run a harness](install.md#when-the-engine-cannot-run-a-harness)). A harness you installed yourself stays yours: the server never installs beside it, and Settings offers the engine's **Update** for it.

- **Where.** In the data directory, `harnesses/claude-code/` and `harnesses/codex/` ([Server: data](../architecture/server.md#data)). Your `PATH` and your own `~/.claude` and `~/.codex` are not touched; the engine is told where the copy is.
- **Disk.** Claude Code is about 370 MB, Codex's download about 200 MB and more once unpacked. During an update the old and the new version are both there, until the switch, or until the engine next starts.
- **Updates.** The server checks each maker for a newer version a minute after it starts and about every six hours, and installs it by itself. The new version waits until no bot is running anything in a session on that provider, then takes over; new turns wait the moment it takes, until the engine shows it runs the new version, at most a minute and a half, or it is put back on the version before. Each bot's next turn on that provider then starts the new version and goes on with its conversation. The version before is removed then, or, if a session could not be released, when the engine next starts. Turning the switch off while an update waits gives that update up. Settings → Providers shows each copy's version, **Update** when a newer one is out, and how the last update ended, and one switch turns the updates by themselves off; **Update** still works with it off.
- **What it reaches.** `downloads.claude.ai` and `releases.openai.com`, over HTTPS. A server that cannot reach them says the install could not download.
- **Back up.** A backup does not need the copies: the server installs them again. Add `--exclude=./harnesses` to the `tar` [below](#back-up) to leave them out; after a restore without them, the provider offers **Install** again.
- **Remove a copy.** Stop the server, delete `harnesses/<provider>/` from the data directory, and start it again: the provider then runs the harness on the `PATH`, if there is one, or offers **Install**. `j3-bots uninstall --delete-data` removes them with the rest.
- **Not checked yet on Windows and macOS.** The install is built for both, and tested only against stand-ins on Linux.

## Back up

Everything J3 Bots keeps is in the data directory: the configuration, the database, the bots' memory and workspaces, attachments and the engine's own data. Stop the service while you copy it, so the database and the files match:

```sh
systemctl --user stop j3-bots
(umask 077 && tar -C ~/.j3-bots --exclude=./engine/j3/runtime --exclude=./engine/tools \
  --exclude=./engine/userdata/server-browser --exclude=./admin.sock --exclude=./vault/key \
  --exclude='./vault/.*' \
  -czf ~/j3-bots-$(date +%F).tar.gz . && cp ~/.j3-bots/vault/key ~/j3-bots-key-$(date +%F))
systemctl --user start j3-bots
```

The archive leaves out the secrets' key file, which `cp` copies on its own, and any temporary file beside it a write that was cut short left, which can hold the key. Keep that copy apart from the archive, on another disk or in a password manager: either one alone opens no secret.

`umask 077` creates the archive readable by you alone from the start. Keep it where only you can read it: it holds the bots' files, the secrets (sealed, and of no use without the key file you keep apart), the device tokens' hashes, the provider key in `engine/userdata/secrets`, and `engine/j3/credential.json`, the credential the server signs in to its engine with, which lets whoever has it start agents with full access. `engine/j3/runtime` is the downloaded engine, and `engine/tools` the browser it downloaded, which it downloads again. `engine/userdata/server-browser` is that browser's profile: it holds live session cookies for every site you signed in to there, which let whoever has them act on those sites as you, so the command above leaves it out, and after a restore you sign in again. Moving the bots to another server with `j3-bots export` and `import` leaves out the engine's directory, and the profile with it ([below](#move-to-another-server)). The archive includes `backups/`, the snapshots `j3-bots update` took; add `--exclude=./backups` to leave them out.

## Restore

```sh
systemctl --user stop j3-bots
mv ~/.j3-bots ~/.j3-bots.before-restore
mkdir -m 700 ~/.j3-bots && tar -C ~/.j3-bots -xzf ~/j3-bots-<date>.tar.gz
install -m 600 ~/j3-bots-key-<date> ~/.j3-bots/vault/key
systemctl --user start j3-bots
j3-bots doctor
```

Restore onto the version the backup was taken with, or a newer one, into a data directory at the same path: the database names each bot's workspace by it. To move the bots to another path or another server, [export and import them](#move-to-another-server). The secrets come back as they were when the backup was taken; without the key file they stay unreadable until you put it back. Once `doctor` shows the server and the engine ready and your conversations are back, delete `~/.j3-bots.before-restore`.

## Move to another server

To run the bots somewhere else, export them where they are and import them there. An export goes to any path and any machine, Linux or Windows. A backup restores only at the same path.

Where the bots are now:

```sh
systemctl --user stop j3-bots
j3-bots export --output ~/j3-bots-export.tar.gz
```

The bots the desktop app runs on this computer have no service and no `j3-bots` command ([The server the desktop app runs](#the-server-the-desktop-app-runs)). Quit the app from its tray, so their server stops, then run the server it carries on their data home. On Linux, with `<version>` the newest folder in `server-runtime`:

```sh
cd ~/.config/"J3 Bots"/server-runtime/<version>
J3_HOME=~/.config/"J3 Bots"/server/home node/bin/node server/bin.mjs export --output ~/j3-bots-export.tar.gz
```

The export asks for a passphrase for the secrets, twice, at least eight characters. **It cannot be recovered**: without it, the secrets in the export are lost. Without `--output`, it writes `j3-bots-export-<date>.tar.gz` in the folder you are in; it never writes over a file. It tells you how many bots and secrets it holds, and what it left out: links in the bots' folders, files whose name has a `\` in it (each named, to rename and export again), attachments already missing, and secrets it could not read, with the reason.

Keep the file private, as you would a backup: it holds every conversation, memory and file. Copy it to the other server over a private channel, such as `scp`. There, install J3 Bots ([Install](install.md)), then:

```sh
systemctl --user stop j3-bots
j3-bots import ~/j3-bots-export.tar.gz
systemctl --user start j3-bots
```

The import checks every file against what the export recorded before it changes anything, asks for the passphrase, and puts the bots in place. On its first start, the server opens a new session for each bot. Each bot's conversation, memory, skills and files are as they were.

- **What moves.** The bots, their conversations, memory, skills and files, the shared memory and skills, the attachments, the routines, the rooms, sections and settings, and the secrets and connector secrets.
- **What stays behind.** The configuration (`config.json`), the engine's directory, the provider connection and sign-ins, J3 Bots' own copies of the harnesses, the update snapshots, the paired devices and the webhooks' secrets. The new server keeps its own configuration and sign-ins.
- **After the import.**
  - Pair every device again with `j3-bots pair`.
  - If the new server has no provider, run `j3-bots provider login` or `j3-bots provider connect`.
  - Each webhook has a new address, on the new server and with a new secret. Give it to whatever calls it: the old one stops working.
- **A server that already has something the import would delete** refuses it: bots, secrets, files kept from a deleted bot, shared memory, attachments, or shared skills of your own. `j3-bots import <file> --replace` deletes them and puts the export's in their place.
- **A newer release's export** is refused: update J3 Bots on the new server first. An older release's export is updated as it is imported.
- **If an import stops halfway**, the server refuses to start until you run the same `j3-bots import` with the same file again, which finishes it. Another file is imported in its place only with `--replace`.
- **For a script,** `--passphrase-stdin` reads the passphrase from the first line of standard input on both commands, instead of asking at the terminal.
- **The server you exported from still has everything.** If you start it again, the bots run in two places, each with its own copy of what they remember. Once the new server works, delete the old data directory (`j3-bots uninstall --delete-data`), or keep it stopped.

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
