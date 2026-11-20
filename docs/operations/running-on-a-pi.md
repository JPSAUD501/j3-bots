# Running J3 Bots on a Raspberry Pi

This guide sets up the J3 Bots server as a systemd user service on a Raspberry Pi 4 running 64-bit Raspberry Pi OS. Any arm64 or x64 Linux machine with systemd works the same way. Clients reach the server from the local network, or over Tailscale.

## What you need

- A Raspberry Pi 4 with 4 GB of memory or more, on 64-bit Raspberry Pi OS (`uname -m` prints `aarch64`).
- About 3 GB of free disk. The engine is about 200 MB once downloaded. The database and the bots' files grow with use.
- Node 26 (J3 Bots is built and tested on 26.13.1), pnpm 12 and Git. One way to get Node is [fnm](https://github.com/Schniz/fnm): `fnm install 26.13.1`. pnpm then installs with `npm install --global pnpm@12.16.1`.
- The harnesses your bots will run on, such as Claude Code (`claude`) or Codex (`codex`), installed and signed in as the user that runs J3 Bots.

No Docker and no root access are involved, except one `sudo loginctl` command so that the service starts at boot.

## Choose the user it runs as

A bot in full access can do anything its user can do. On a Pi that holds SSH keys to the rest of your network, run J3 Bots as a **dedicated user**: one with no SSH keys, no sudo, its own provider sign-ins and no access to your own home ([Security](../architecture/security.md#running-on-a-machine-that-matters)).

```sh
sudo adduser --disabled-password --gecos "" j3bots
sudo loginctl enable-linger j3bots
sudo -iu j3bots
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
```

`enable-linger` starts that user's systemd manager at boot, with no login. `XDG_RUNTIME_DIR` lets `systemctl --user` find that manager from a `sudo -i` shell. Do everything below as that user, including installing Node, pnpm and the harnesses, and signing in to them.

## Install

```sh
git clone https://github.com/JPSAUD501/j3-bots.git ~/j3-bots
cd ~/j3-bots
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.local/bin
ln -sf ~/j3-bots/apps/server/dist/bin.mjs ~/.local/bin/j3-bots
```

`pnpm build` builds the server into `apps/server/dist/` and builds the web client into `apps/web/dist/` once the repository has one. The server bundle carries every dependency it needs. You can drop the development tools with `pnpm install --prod --frozen-lockfile`, but building again then needs a full `pnpm install` first.

Most systems put `~/.local/bin` on `PATH` at the next login. Until then, run the commands as `~/.local/bin/j3-bots`.

## First run

```sh
j3-bots doctor
j3-bots service install
```

`doctor` checks the machine before anything starts ([what it checks](#what-doctor-checks)). Fix every ✗ it reports. A `!` is a warning: the server still runs.

`service install` does the following:

- creates the data directory, `~/.j3-bots`, readable by this user only;
- writes `~/.j3-bots/config.json` with the defaults;
- writes the unit `~/.config/systemd/user/j3-bots.service`;
- enables the unit and starts it.

On its first start, the server downloads the engine it is pinned to into `~/.j3-bots/engine`.

The unit records the absolute path of the Node that ran `service install`, this checkout's server bundle and the `PATH` of the shell you ran it from, so the engine finds the harnesses. Two cases need `service install` again:

- after you install Node somewhere else;
- after you install a harness in a folder that was not on that `PATH`.

The service does not see `J3_*` variables from your shell; `service install` names any it finds. Put lasting settings in `config.json`.

If you did not create a dedicated user, turn lingering on for your own user so that the service survives a logout and starts at boot. `doctor` and `service install` both remind you:

```sh
sudo loginctl enable-linger "$(id -un)"
```

### The unit

- `Restart=on-failure` restarts the server five seconds after it fails. After five failures in five minutes, systemd stops trying, and `doctor` reports the service as failed.
- `MemoryHigh` is 60% of the machine's memory: about 2.4 GB on a 4 GB Pi. Above it the kernel reclaims the service's memory first, which leaves room for the rest of the system. It needs the kernel's memory controller. Raspberry Pi OS kernels may disable it. `doctor` reports that case, and the fix is `cgroup_enable=memory` at the end of the single line in `/boot/firmware/cmdline.txt`, then a reboot.
- On stop, systemd sends SIGTERM to the server alone (`KillMode=mixed`). The server stops the engine and its children itself, and after 30 seconds systemd kills whatever is left.

## Configuration

`~/.j3-bots/config.json` holds every setting at its default:

```json
{
  "host": "lan",
  "port": 3737,
  "toolPort": 3739,
  "enginePort": 3738,
  "webClient": null,
  "tls": null
}
```

`"host": "lan"` serves every IPv4 address of the Pi, as long as each one is private: a home network, or Tailscale. Edit the file, then run `systemctl --user restart j3-bots`. An unknown key or an invalid value stops the start with a message that names it. The full list, with the environment variables that override each setting, is in [Server: configuration](../architecture/server.md#configuration).

## Pair a device

```sh
j3-bots pair
```

```text
Pairing code: 7Q2MV-K9XDA

It works once, for the next 5 minutes.
Open J3 Bots on the new device and enter it there:
  http://192.168.1.40:3737
  http://100.101.102.103:3737
```

`pair` asks the running server for the code over its admin socket, `~/.j3-bots/admin.sock`. Only this user can connect to that socket, so the command works only on the Pi, as the user that runs the service. Open one of the addresses on the phone or computer you are pairing and enter the code.

A browser treats a plain-HTTP address other than `localhost` as insecure, and on such an address it does not install J3 Bots as an app (a PWA). To install it on a phone, serve HTTPS: put a certificate and key in `tls` (paths relative to the data directory work). With Tailscale, `tailscale cert <machine>.<tailnet>.ts.net` issues one for the Pi's tailnet name. Pair at `https://<machine>.<tailnet>.ts.net:3737` afterwards.

## Logs

```sh
journalctl --user -u j3-bots -f          # follow
journalctl --user -u j3-bots -n 200      # the last 200 lines
systemctl --user status j3-bots
j3-bots service status
```

The server writes one JSON object per line. If `journalctl --user` shows nothing, the journal is not stored on disk. Then run `sudo mkdir -p /var/log/journal` and `sudo systemctl restart systemd-journald`.

## Update

```sh
cd ~/j3-bots
git pull
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart j3-bots
j3-bots doctor
```

The server migrates its database when it starts. If the new release pins another engine version, the server downloads that version on its first start. The server looks for the web client when it starts: if it was not built then, it is served only after a restart.

## Back up

Everything J3 Bots keeps is in the data directory: the configuration, the database, the bots' memory and workspaces, attachments and the engine's own data. Stop the service while you copy it, so that the database and the files match:

```sh
systemctl --user stop j3-bots
tar -C ~/.j3-bots --exclude=./engine/j3/runtime --exclude=./admin.sock \
  -czf ~/j3-bots-$(date +%F).tar.gz .
systemctl --user start j3-bots
```

`engine/j3/runtime` is the downloaded engine, which the server downloads again. The archive holds the bots' files and the device tokens' hashes, so keep it where only you can read it.

To restore:

1. Stop the service.
2. Move `~/.j3-bots` aside.
3. Run `mkdir -m 700 ~/.j3-bots && tar -C ~/.j3-bots -xzf <archive>`.
4. Start the service.

## Remove

```sh
j3-bots service uninstall
```

This stops the service, disables it and deletes its unit. The data directory stays. Delete `~/.j3-bots` yourself if you mean to.

## What `doctor` checks

Each line is ✓ (fine), `!` (a warning: the server runs, but something is missing), ✗ (a problem to fix) or `-` (not checked). A line that is not ✓ carries a fix. `doctor` exits with status 1 when it reports any problem.

| Check | What it looks at |
| --- | --- |
| Node | The Node running it has the major version J3 Bots is built on. |
| Configuration | `config.json` and the `J3_*` variables decode and pass the checks the server makes at start. Two examples: a public address without TLS, and a data directory inside a Git checkout. |
| Data directory | It is a folder, this user can write to it, and other users cannot read it. |
| Disk space | Free space where the data directory is: less than 1 GB is a problem, less than 3 GB a warning. |
| Server | Whether a server answers on the admin socket, and which version. |
| Ports | With no server running, that the server's port, the bot tool port and the engine's port are free on their addresses. |
| Engine | That the pinned engine has a release for this machine, whether it is installed yet, and, with the server running, the state the server reports for it. |
| Claude Code, Codex | That the harness is on `PATH`, and what the engine reports about the server's providers on it. |
| Web client | That a built web client is there, and that the running server serves it. |
| Pairing | How many devices are paired. |
| Service | That the unit is installed, enabled and running, and has not failed. |
| Start at boot | That lingering is on for this user. |
| Memory limit | That the kernel lets the service's `MemoryHigh` apply. |

`doctor` reads; it changes nothing. It is safe to run while the service runs.

## Known limits in this release

- The server sets up no providers yet. `doctor` warns that no Claude Code or Codex provider is set up, and bots cannot run turns until a release that configures them.
- The engine adapter does not yet read sign-in or usage state from the engine. For a configured provider it reports "ready", and `doctor` repeats what it reports (**Read** in `packages/engine-t3/src/t3/T3Engine.ts`).
- `j3-bots pair` prints the code and the addresses but no QR code.
- When the engine cannot start, the server may not exit on SIGTERM, and systemd kills it after 30 seconds. Its data is safe: the database is SQLite in WAL mode.
- `"lan"` checks the machine's addresses when the server starts. A public IPv4 address that appears later (for example, the Pi plugged straight into a modem) would be served too, until the next start refuses it.
